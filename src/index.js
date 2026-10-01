#!/usr/bin/env node
/**
 * @thxmxx/telegram-mcp — MCP server
 * Uses grammY (https://grammy.dev) for reliable Telegram polling.
 *
 * Tools:
 *   telegram_notify  — send a message (fire and forget)
 *   telegram_ask     — ask a question, wait for text reply
 *   telegram_choose  — show buttons, wait for a tap
 *   telegram_choose_batch: several button messages at once, wait for all
 *   telegram_listen  — wait for user to address this instance by name
 */

import { Bot, InlineKeyboard } from "grammy";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, env, exit } from "node:process";
import { randomBytes } from "node:crypto";
import {
  clampTimeout,
  timeoutMessage,
  splitMessage,
  truncate,
  TELEGRAM_LIMIT,
  encodeBatchCb,
  encodeChooseCb,
  decodeChooseCb,
  BatchTracker,
  validateBatchItems,
  PollingController,
} from "./core.js";

// ── Config ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, "../.env");

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const [k, ...v] = line.split("=");
    if (k && v.length && !env[k.trim()]) {
      env[k.trim()] = v.join("=").trim();
    }
  }
}

const TOKEN = env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  process.stderr.write(
    "[telegram-mcp] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.\n" +
      "               Run: npx @thxmxx/telegram-mcp init\n",
  );
  exit(1);
}

// ── Instance label ────────────────────────────────────────────────────────────

const folder = process.cwd().split("/").pop() || "claude";
const shortId = randomBytes(2).toString("hex");
const INSTANCE = `${folder}#${shortId}`;
const HDR = `\`[${INSTANCE}]\``;

// ── Bot ───────────────────────────────────────────────────────────────────────
// `api` is used for every send and never polls. Polling happens on a separate
// Bot instance that is created only while some tool is waiting (see below).

const api = new Bot(TOKEN).api;

// Listeners register themselves while a tool waits and dequeue on match
const messageListeners = [];
const callbackListeners = [];

function createPollingBot() {
  const bot = new Bot(TOKEN);

  bot.on("message:text", (ctx) => {
    if (String(ctx.chat.id) !== String(CHAT_ID)) return;
    for (const fn of [...messageListeners]) fn(ctx.message.text);
  });

  bot.on("callback_query:data", async (ctx) => {
    if (String(ctx.from.id) !== String(CHAT_ID)) return;
    await ctx.answerCallbackQuery();
    for (const fn of [...callbackListeners]) fn(ctx.callbackQuery.data);
  });

  bot.catch((err) =>
    process.stderr.write(`[telegram-mcp] bot error: ${err.message}\n`),
  );
  return bot;
}

// drop_pending_updates: replies typed while nobody was waiting are stale and
// must not answer a later question.
// Long polling runs only while at least one waiter holds a handle. If Telegram
// answers 409 (another session polls this bot) the handle's `failed` promise
// rejects, so the waiting tool returns an error instead of hanging.
const polling = new PollingController({
  log: (m) => process.stderr.write(`[${INSTANCE}] ${m}\n`),
  startPolling: () => {
    const bot = createPollingBot();
    const done = bot.start({ drop_pending_updates: true });
    return { done, stop: () => bot.stop() };
  },
});

/** Run `fn(signal)` while holding polling. Aborts the signal when done. */
async function whilePolling(fn) {
  const handle = polling.acquire();
  const ac = new AbortController();
  try {
    return await Promise.race([fn(ac.signal), handle.failed]);
  } finally {
    ac.abort();
    handle.release();
  }
}

// ── Wait helpers ──────────────────────────────────────────────────────────────

function waitFor(list, accept, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      const i = list.indexOf(handler);
      if (i !== -1) list.splice(i, 1);
      signal?.removeEventListener("abort", cleanup);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage(Math.round(timeoutMs / 1000))));
    }, timeoutMs);
    function handler(data) {
      const out = accept(data);
      if (out === undefined) return;
      cleanup();
      resolve(out);
    }
    signal?.addEventListener("abort", cleanup);
    list.push(handler);
  });
}

function waitForMessage(filter, timeoutMs, signal) {
  return waitFor(
    messageListeners,
    (t) => (filter(t) ? t : undefined),
    timeoutMs,
    signal,
  );
}

// Resolves with the callback data accepted by `accept` (undefined = ignore)
function waitForCallback(accept, timeoutMs, signal) {
  return waitFor(callbackListeners, accept, timeoutMs, signal);
}

function terminalPrompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    process.stderr.write(`\n[${INSTANCE}] ${question}\n> `);
    rl.once("line", (line) => {
      rl.close();
      resolve(line.trim());
    });
  });
}

function raceReply(question, timeoutMs, signal) {
  return Promise.race([
    waitForMessage((t) => !t.startsWith("/"), timeoutMs, signal).then((v) => ({
      source: "telegram",
      value: v,
    })),
    terminalPrompt(question).then((v) => ({ source: "terminal", value: v })),
  ]);
}

function raceCallback(question, options, chooseId, timeoutMs, signal) {
  const numbered = options.map((o, i) => `  ${i + 1}. ${o}`).join("\n");
  return Promise.race([
    waitForCallback(
      (data) => {
        const d = decodeChooseCb(data);
        if (!d || d.chooseId !== chooseId || d.optIdx >= options.length) return;
        return options[d.optIdx];
      },
      timeoutMs,
      signal,
    ).then((v) => ({ source: "telegram", value: v })),
    terminalPrompt(
      `${question}\n${numbered}\nChoose (1-${options.length})`,
    ).then((v) => {
      const idx = parseInt(v, 10) - 1;
      return { source: "terminal", value: options[idx] ?? v };
    }),
  ]);
}

const timeoutParam = z
  .number()
  .int()
  .optional()
  .describe(
    "Seconds to wait for the answer. Default 300, clamped to 10..3600.",
  );

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "telegram-mcp", version: "1.0.0" });

server.tool(
  "telegram_notify",
  "Send a Telegram notification. Use for progress updates and task completions. Does NOT wait for a reply.",
  { message: z.string() },
  async ({ message }) => {
    await api.sendMessage(CHAT_ID, `${HDR} ${message}`, {
      parse_mode: "Markdown",
    });
    process.stderr.write(`[${INSTANCE}] notify: ${message}\n`);
    return { content: [{ type: "text", text: "Sent." }] };
  },
);

server.tool(
  "telegram_ask",
  "Ask the user a free-form question via Telegram and wait for their reply. Also shown on terminal — first to answer wins.",
  { question: z.string(), timeout_s: timeoutParam },
  async ({ question, timeout_s }) => {
    const timeoutMs = clampTimeout(timeout_s) * 1000;
    await api.sendMessage(CHAT_ID, `${HDR} ❓ ${question}`, {
      parse_mode: "Markdown",
    });
    const { source, value } = await whilePolling((signal) =>
      raceReply(question, timeoutMs, signal),
    );
    if (source === "terminal") {
      await api.sendMessage(
        CHAT_ID,
        `${HDR} ✅ Answered from terminal: *${value}*`,
        { parse_mode: "Markdown" },
      );
    }
    process.stderr.write(`[${INSTANCE}] ask (${source}): ${value}\n`);
    return { content: [{ type: "text", text: value }] };
  },
);

server.tool(
  "telegram_choose",
  "Show option buttons on Telegram and wait for the user to tap one. Also shown as numbered list on terminal — first to answer wins.",
  {
    question: z.string(),
    options: z.array(z.string()).min(2).max(10),
    timeout_s: timeoutParam,
  },
  async ({ question, options, timeout_s }) => {
    const timeoutMs = clampTimeout(timeout_s) * 1000;
    const chooseId = randomBytes(4).toString("hex");
    const keyboard = new InlineKeyboard();
    options.forEach((opt, i) =>
      keyboard.text(opt, encodeChooseCb(chooseId, i)).row(),
    );
    await api.sendMessage(CHAT_ID, `${HDR} 🔘 ${question}`, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    const { source, value } = await whilePolling((signal) =>
      raceCallback(question, options, chooseId, timeoutMs, signal),
    );
    await api.sendMessage(
      CHAT_ID,
      `${HDR} ✅ *${value}* _(via ${source})_`,
      { parse_mode: "Markdown" },
    );
    process.stderr.write(`[${INSTANCE}] choose (${source}): ${value}\n`);
    return { content: [{ type: "text", text: value }] };
  },
);

server.tool(
  "telegram_choose_batch",
  "Send several multiple-choice cards to Telegram at once (each its own message with buttons) and wait until every one is answered or the timeout hits. Returns JSON {answers: {id: option|null}, timed_out: [ids]}. Long texts are sent first as plain messages, then the buttons.",
  {
    items: z
      .array(
        z.object({
          id: z.string(),
          text: z.string(),
          options: z.array(z.string()).min(1).max(10),
        }),
      )
      .min(1)
      .max(10),
    timeout_s: timeoutParam,
  },
  async ({ items, timeout_s }) => {
    const bad = validateBatchItems(items);
    if (bad) {
      return { isError: true, content: [{ type: "text", text: bad }] };
    }
    const timeoutMs = clampTimeout(timeout_s) * 1000;
    const batchId = randomBytes(4).toString("hex");
    const tracker = new BatchTracker(batchId, items);
    const messageIds = new Map(); // item index -> {id, text} of the buttons message

    const run = async (signal) => {
      // Register BEFORE sending so a fast tap is never missed.
      let onDone;
      const allDone = new Promise((res) => (onDone = res));
      const pendingEdits = [];
      const listener = (data) => {
        const r = tracker.handle(data);
        if (r.type !== "answered") return;
        const sent = messageIds.get(r.itemIdx);
        if (sent) {
          pendingEdits.push(
            api
              .editMessageText(
                CHAT_ID,
                sent.messageId,
                truncate(`${sent.text}\n\n✅ ${r.option}`),
                { reply_markup: { inline_keyboard: [] } },
              )
              .catch((e) =>
                process.stderr.write(
                  `[${INSTANCE}] edit failed: ${e.message}\n`,
                ),
              ),
          );
        }
        if (tracker.complete) onDone();
      };
      callbackListeners.push(listener);
      const timer = setTimeout(onDone, timeoutMs);
      const stop = () => {
        clearTimeout(timer);
        const i = callbackListeners.indexOf(listener);
        if (i !== -1) callbackListeners.splice(i, 1);
      };
      signal.addEventListener("abort", stop);

      try {
        for (let i = 0; i < items.length; i++) {
          if (signal.aborted) break;
          const it = items[i];
          const keyboard = new InlineKeyboard();
          it.options.forEach((opt, j) =>
            keyboard.text(opt, encodeBatchCb(batchId, i, j)).row(),
          );
          const header = `${INSTANCE} [${it.id}]`;
          let text = `${header}\n${it.text}`;
          if (text.length > TELEGRAM_LIMIT - 20) {
            // Long card: full text first (plain, split), then a short buttons message.
            for (const chunk of splitMessage(it.text, TELEGRAM_LIMIT - 100)) {
              await api.sendMessage(CHAT_ID, `${header}\n${chunk}`);
            }
            text = `${header}\n(text above) choose for "${it.id}":`;
          }
          const msg = await api.sendMessage(CHAT_ID, text, {
            reply_markup: keyboard,
          });
          messageIds.set(i, { messageId: msg.message_id, text });
        }
        if (tracker.complete) onDone();
        await allDone;
      } finally {
        stop();
        await Promise.all(pendingEdits);
      }
      return tracker.result();
    };

    const result = await whilePolling(run);
    process.stderr.write(
      `[${INSTANCE}] choose_batch: ${items.length - result.timed_out.length}/${items.length} answered\n`,
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.tool(
  "telegram_listen",
  `Wait for the user to send a new instruction addressed to this instance.
   Format: @${INSTANCE} <instruction>
   Call this after completing a task to stay available. Returns the instruction text.
   Times out after 1 hour of inactivity. When it returns, execute the instruction then call telegram_listen again.`,
  {},
  async () => {
    await api.sendMessage(
      CHAT_ID,
      `${HDR} ✅ Task complete — waiting for next instruction.\n_Address me as_ \`@${INSTANCE} <instruction>\``,
      { parse_mode: "Markdown" },
    );
    process.stderr.write(`[${INSTANCE}] listening for @${INSTANCE}...\n`);

    const mention = `@${INSTANCE}`.toLowerCase();
    try {
      const text = await whilePolling((signal) =>
        waitForMessage(
          (t) =>
            t.toLowerCase().startsWith(mention) &&
            t.trim().length > mention.length,
          3_600_000,
          signal,
        ),
      );
      const instruction = text.slice(mention.length).trim();
      process.stderr.write(`[${INSTANCE}] received: ${instruction}\n`);
      return { content: [{ type: "text", text: instruction }] };
    } catch (err) {
      if (err.name === "PollingConflictError") throw err;
      await api.sendMessage(
        CHAT_ID,
        `${HDR} 💤 Timed out after 1 hour of inactivity.`,
        { parse_mode: "Markdown" },
      );
      return { content: [{ type: "text", text: `timeout: ${err.message}` }] };
    }
  },
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[telegram-mcp] Ready — instance: ${INSTANCE}\n`);
process.stderr.write(
  `[telegram-mcp] Address messages as: @${INSTANCE} <instruction>\n`,
);
