#!/usr/bin/env node
/**
 * npx @thxmxx/telegram-mcp init
 *
 * One-time global setup:
 *  1. Asks for bot token and chat ID
 *  2. Registers the MCP server globally in Claude Code (~/.claude.json)
 *  3. Installs the /use-telegram slash command in ~/.claude/commands/
 *
 * Instance names are auto-generated per session — no need to configure them.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output, exit } from "node:process";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const rl  = createInterface({ input, output });
const ask = (q) => rl.question(q);

const BOLD  = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN  = "\x1b[36m";
const DIM   = "\x1b[2m";
const RESET = "\x1b[0m";

const ok  = (msg) => console.log(`${GREEN}✔${RESET}  ${msg}`);
const die = (msg) => { console.error(`\x1b[31m✘${RESET}  ${msg}`); rl.close(); exit(1); };

// ── Pre-flight ────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}@thxmxx/telegram-mcp — one-time setup${RESET}\n`);

const [major] = process.versions.node.split(".").map(Number);
if (major < 18) die(`Node.js 18+ required (you have ${process.versions.node})`);
ok(`Node.js ${process.versions.node}`);

try {
  const ver = execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  ok(`Claude Code: ${ver}`);
} catch {
  die("`claude` not found. Install: https://docs.claude.ai/claude-code");
}

// ── Step 1: Bot token ─────────────────────────────────────────────────────────

console.log(`
${BOLD}Step 1 — Bot token${RESET}
  ${DIM}Open Telegram → @BotFather → /newbot${RESET}
`);
const token = (await ask("  Bot token: ")).trim();
if (!token) die("Token is required.");

// ── Step 2: Chat ID ───────────────────────────────────────────────────────────

console.log(`
${BOLD}Step 2 — Your Telegram user ID${RESET}
  ${DIM}Message @userinfobot on Telegram to get your numeric ID.${RESET}
`);
const chatId = (await ask("  Your Telegram user ID: ")).trim();
if (!chatId) die("User ID is required.");

rl.close();

// ── Register MCP globally in Claude Code ─────────────────────────────────────

console.log(`\n${BOLD}Registering MCP server globally…${RESET}`);

const serverPath = new URL("./index.js", import.meta.url).pathname;

try {
  execFileSync("claude", [
    "mcp", "add", "--scope", "user",   // global, persists across all projects
    "telegram-mcp",
    "-e", `TELEGRAM_BOT_TOKEN=${token}`,
    "-e", `TELEGRAM_CHAT_ID=${chatId}`,
    "--", "node", serverPath,
  ], { stdio: "inherit" });
} catch {
  // Fallback: older Claude Code versions without --scope flag
  try {
    execFileSync("claude", [
      "mcp", "add",
      "telegram-mcp",
      "-e", `TELEGRAM_BOT_TOKEN=${token}`,
      "-e", `TELEGRAM_CHAT_ID=${chatId}`,
      "--", "node", serverPath,
    ], { stdio: "inherit" });
  } catch {
    die(
      "`claude mcp add` failed.\n" +
      "  Update Claude Code: https://docs.claude.ai/claude-code\n\n" +
      "  Manual config:\n" +
      `    TELEGRAM_BOT_TOKEN=${token}\n` +
      `    TELEGRAM_CHAT_ID=${chatId}\n` +
      `    command: node ${serverPath}`
    );
  }
}

ok("MCP server registered globally.");

// ── Install /use-telegram slash command ───────────────────────────────────────

const commandsDir = join(homedir(), ".claude", "commands");
mkdirSync(commandsDir, { recursive: true });

const commandPath = join(commandsDir, "use-telegram.md");
writeFileSync(commandPath, `# use-telegram

Activate Telegram integration for this Claude Code session.

## What this does

Enables the telegram_notify, telegram_ask and telegram_choose tools so you
can be notified and asked questions on your phone while Claude works.

The instance name is derived automatically from the current folder and
session ID, so messages on Telegram always show which session is talking.

## Modes

- \`/use-telegram\` — full interactive mode (notify + ask + choose)
- \`/use-telegram notify\` — notifications only, no questions

## Behaviour

When this command is active:
- Use telegram_notify for progress updates and completed tasks
- Use telegram_ask when you need a free-form answer from the user
- Use telegram_choose when the user must pick from known options
- Always prefix messages with the auto-generated instance label
- Mirror every question to the terminal too — whoever answers first wins
- After any long-running task, send a completion summary via telegram_notify

## Instance naming

Generate the instance label as: \`{folder-name}#{short-session-id}\`
Example: \`backend#a3f2\`, \`frontend#9c11\`

Use the same label for the entire session.
`);

ok(`Slash command installed → ${commandPath}`);

// ── Done ──────────────────────────────────────────────────────────────────────

console.log(`
${GREEN}${BOLD}All done!${RESET}

  Restart Claude Code. From now on, in any session:

    ${BOLD}/use-telegram${RESET}           full mode (notify + ask + choose)
    ${BOLD}/use-telegram notify${RESET}    notifications only

  Or just tell Claude in the prompt:
    ${DIM}"refactor this and notify me on telegram when done"${RESET}
    ${DIM}"deploy to staging, ask me via telegram if anything is unclear"${RESET}

  Each session auto-identifies itself as ${BOLD}[folder#id]${RESET} in Telegram.
  ${DIM}No need to run init again unless you change your bot token.${RESET}
`);
