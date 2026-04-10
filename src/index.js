#!/usr/bin/env node
/**
 * @thxmxx/telegram-mcp — MCP server
 *
 * Tools:
 *   telegram_notify  — send a message (fire and forget)
 *   telegram_ask     — ask a question, wait for text reply
 *   telegram_choose  — show buttons, wait for a tap
 *   telegram_listen  — wait for user to address this instance by name,
 *                      returns the next instruction so Claude can keep working
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import TelegramBot from "node-telegram-bot-api";
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

// ── Auto instance label: folder#shortid ───────────────────────────────────────

const folder = process.cwd().split("/").pop() || "claude";
const shortId = randomBytes(2).toString("hex");
const INSTANCE = `${folder}#${shortId}`;
const HDR = `\`[${INSTANCE}]\``;

// ── Telegram client ───────────────────────────────────────────────────────────

const bot = new TelegramBot(TOKEN, { polling: true });

// ── Helpers ───────────────────────────────────────────────────────────────────

function waitForReply(timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.removeListener("message", handler);
      reject(new Error("Timed out (5 min)"));
    }, timeoutMs);
    function handler(msg) {
      if (String(msg.chat.id) !== String(CHAT_ID)) return;
      if (msg.text?.startsWith("/")) return;
      clearTimeout(timer);
      bot.removeListener("message", handler);
      resolve({ source: "telegram", value: msg.text || "" });
    }
    bot.on("message", handler);
  });
}

function waitForCallback(timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.removeListener("callback_query", handler);
      reject(new Error("Timed out (5 min)"));
    }, timeoutMs);
    function handler(query) {
      if (String(query.from.id) !== String(CHAT_ID)) return;
      clearTimeout(timer);
      bot.removeListener("callback_query", handler);
      bot.answerCallbackQuery(query.id);
      resolve({ source: "telegram", value: query.data || "" });
    }
    bot.on("callback_query", handler);
  });
}

/**
 * Wait for a message addressed to THIS instance.
 * Format: "@instance-label <instruction>"
 * e.g.   "@backend#a3f2 now refactor the auth module"
 *
 * Ignores messages addressed to other instances silently.
 * Times out after `timeoutMs` (default: 1 hour).
 */
function waitForAddressedMessage(timeoutMs = 3_600_000) {
  const mention = `@${INSTANCE}`.toLowerCase();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bot.removeListener("message", handler);
      reject(new Error(`No message addressed to ${INSTANCE} within timeout`));
    }, timeoutMs);

    function handler(msg) {
      if (String(msg.chat.id) !== String(CHAT_ID)) return;
      if (!msg.text) return;

      const text = msg.text.trim();
      const lower = text.toLowerCase();

      // Message must start with @instance-label
      if (!lower.startsWith(mention)) return;

      // Extract the instruction after the mention
      const instruction = text.slice(mention.length).trim();
      if (!instruction) return;

      clearTimeout(timer);
      bot.removeListener("message", handler);
      resolve(instruction);
    }

    bot.on("message", handler);
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
    waitForReply(),
    terminalPrompt(question).then((v) => ({ source: "terminal", value: v })),
  ]);
}

function raceCallback(question, options) {
  const numbered = options.map((o, i) => `  ${i + 1}. ${o}`).join("\n");
  return Promise.race([
    waitForCallback(),
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

// ── telegram_notify ───────────────────────────────────────────────────────────

server.tool(
  "telegram_notify",
  "Send a Telegram notification to the user. Use for progress updates and task completions. Does NOT wait for a reply.",
  { message: z.string().describe("The message to send") },
  async ({ message }) => {
    await bot.sendMessage(CHAT_ID, `${HDR} ${message}`, {
      parse_mode: "Markdown",
    });
    process.stderr.write(`[${INSTANCE}] notify: ${message}\n`);
    return { content: [{ type: "text", text: "Sent." }] };
  },
);

// ── telegram_ask ──────────────────────────────────────────────────────────────

server.tool(
  "telegram_ask",
  "Ask the user a free-form question via Telegram and wait for their reply. The same question appears on the terminal — whoever answers first wins.",
  { question: z.string().describe("The question to ask") },
  async ({ question }) => {
    await bot.sendMessage(CHAT_ID, `${HDR} ❓ ${question}`, {
      parse_mode: "Markdown",
    });
    const { source, value } = await raceReply(question);
    if (source === "terminal") {
      await bot.sendMessage(
        CHAT_ID,
        `${HDR} ✅ Answered from terminal: *${value}*`,
        { parse_mode: "Markdown" },
      );
    }
    process.stderr.write(`[${INSTANCE}] ask (${source}): ${value}\n`);
    return { content: [{ type: "text", text: value }] };
  },
);

// ── telegram_choose ───────────────────────────────────────────────────────────

server.tool(
  "telegram_choose",
  "Ask the user to pick one option. Shows inline buttons on Telegram and a numbered list on the terminal. Whoever responds first wins.",
  {
    question: z.string().describe("The question or prompt"),
    options: z
      .array(z.string())
      .min(2)
      .max(10)
      .describe("Options to present (2–10)"),
  },
  async ({ question, options }) => {
    const keyboard = {
      inline_keyboard: options.map((opt) => [
        { text: opt, callback_data: opt },
      ]),
    };
    await bot.sendMessage(CHAT_ID, `${HDR} 🔘 ${question}`, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
    const { source, value } = await raceCallback(question, options);
    await bot.sendMessage(CHAT_ID, `${HDR} ✅ *${value}* _(via ${source})_`, {
      parse_mode: "Markdown",
    });
    process.stderr.write(`[${INSTANCE}] choose (${source}): ${value}\n`);
    return { content: [{ type: "text", text: value }] };
  },
);

// ── telegram_listen ───────────────────────────────────────────────────────────

server.tool(
  "telegram_listen",
  `Wait for the user to send a new instruction addressed to this instance on Telegram.
   Call this after completing a task to stay available for follow-up work.
   The user must address messages as: @${INSTANCE} <instruction>
   Returns the instruction text when received. Times out after 1 hour of inactivity.
   When this tool returns, execute the instruction and call telegram_listen again when done.`,
  {},
  async () => {
    await bot.sendMessage(
      CHAT_ID,
      `${HDR} ✅ Task complete — waiting for your next instruction.\n` +
        `_Address me as_ \`@${INSTANCE} <your instruction>\``,
      { parse_mode: "Markdown" },
    );

    process.stderr.write(`[${INSTANCE}] listening for @${INSTANCE} ...\n`);

    try {
      const instruction = await waitForAddressedMessage();
      process.stderr.write(`[${INSTANCE}] received: ${instruction}\n`);
      return { content: [{ type: "text", text: instruction }] };
    } catch (err) {
      await bot.sendMessage(
        CHAT_ID,
        `${HDR} 💤 Timed out after 1 hour of inactivity.`,
        {
          parse_mode: "Markdown",
        },
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
