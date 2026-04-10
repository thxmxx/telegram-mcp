#!/usr/bin/env node
/**
 * @thxmxx/telegram-mcp — MCP server
 * Uses grammY (https://grammy.dev) for reliable Telegram polling.
 *
 * Tools:
 *   telegram_notify  — send a message (fire and forget)
 *   telegram_ask     — ask a question, wait for text reply
 *   telegram_choose  — show buttons, wait for a tap
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

const bot = new Bot(TOKEN);

// Message/callback queues — listeners register themselves and dequeue on match
const messageListeners = [];
const callbackListeners = [];

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

// Start polling (non-blocking)
bot.start({
  onStart: () => process.stderr.write(`[telegram-mcp] polling started\n`),
});

// ── Wait helpers ──────────────────────────────────────────────────────────────

function waitForMessage(filter, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = messageListeners.indexOf(handler);
      if (i !== -1) messageListeners.splice(i, 1);
      reject(new Error("Timed out (5 min)"));
    }, timeoutMs);

    function handler(text) {
      if (!filter(text)) return;
      clearTimeout(timer);
      const i = messageListeners.indexOf(handler);
      if (i !== -1) messageListeners.splice(i, 1);
      resolve(text);
    }
    messageListeners.push(handler);
  });
}

function waitForCallback(timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = callbackListeners.indexOf(handler);
      if (i !== -1) callbackListeners.splice(i, 1);
      reject(new Error("Timed out (5 min)"));
    }, timeoutMs);

    function handler(data) {
      clearTimeout(timer);
      const i = callbackListeners.indexOf(handler);
      if (i !== -1) callbackListeners.splice(i, 1);
      resolve(data);
    }
    callbackListeners.push(handler);
  });
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

function raceReply(question) {
  return Promise.race([
    waitForMessage((t) => !t.startsWith("/")).then((v) => ({
      source: "telegram",
      value: v,
    })),
    terminalPrompt(question).then((v) => ({ source: "terminal", value: v })),
  ]);
}

function raceCallback(question, options) {
  const numbered = options.map((o, i) => `  ${i + 1}. ${o}`).join("\n");
  return Promise.race([
    waitForCallback().then((v) => ({ source: "telegram", value: v })),
    terminalPrompt(
      `${question}\n${numbered}\nChoose (1-${options.length})`,
    ).then((v) => {
      const idx = parseInt(v, 10) - 1;
      return { source: "terminal", value: options[idx] ?? v };
    }),
  ]);
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "telegram-mcp", version: "1.0.0" });

server.tool(
  "telegram_notify",
  "Send a Telegram notification. Use for progress updates and task completions. Does NOT wait for a reply.",
  { message: z.string() },
  async ({ message }) => {
    await bot.api.sendMessage(CHAT_ID, `${HDR} ${message}`, {
      parse_mode: "Markdown",
    });
    process.stderr.write(`[${INSTANCE}] notify: ${message}\n`);
    return { content: [{ type: "text", text: "Sent." }] };
  },
);

server.tool(
  "telegram_ask",
  "Ask the user a free-form question via Telegram and wait for their reply. Also shown on terminal — first to answer wins.",
  { question: z.string() },
  async ({ question }) => {
    await bot.api.sendMessage(CHAT_ID, `${HDR} ❓ ${question}`, {
      parse_mode: "Markdown",
    });
    const { source, value } = await raceReply(question);
    if (source === "terminal") {
      await bot.api.sendMessage(
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
  },
  async ({ question, options }) => {
    const keyboard = new InlineKeyboard();
    options.forEach((opt) => keyboard.text(opt, opt).row());
    await bot.api.sendMessage(CHAT_ID, `${HDR} 🔘 ${question}`, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    const { source, value } = await raceCallback(question, options);
    await bot.api.sendMessage(
      CHAT_ID,
      `${HDR} ✅ *${value}* _(via ${source})_`,
      { parse_mode: "Markdown" },
    );
    process.stderr.write(`[${INSTANCE}] choose (${source}): ${value}\n`);
    return { content: [{ type: "text", text: value }] };
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
    await bot.api.sendMessage(
      CHAT_ID,
      `${HDR} ✅ Task complete — waiting for next instruction.\n_Address me as_ \`@${INSTANCE} <instruction>\``,
      { parse_mode: "Markdown" },
    );
    process.stderr.write(`[${INSTANCE}] listening for @${INSTANCE}...\n`);

    const mention = `@${INSTANCE}`.toLowerCase();
    try {
      const text = await waitForMessage(
        (t) =>
          t.toLowerCase().startsWith(mention) &&
          t.trim().length > mention.length,
        3_600_000,
      );
      const instruction = text.slice(mention.length).trim();
      process.stderr.write(`[${INSTANCE}] received: ${instruction}\n`);
      return { content: [{ type: "text", text: instruction }] };
    } catch (err) {
      await bot.api.sendMessage(
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
