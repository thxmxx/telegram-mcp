#!/usr/bin/env node
/**
 * @thxmxx/telegram-mcp
 *
 * npx @thxmxx/telegram-mcp init    — one-time global setup
 * npx @thxmxx/telegram-mcp start   — start MCP server manually (for testing)
 */

const cmd = process.argv[2];

if (cmd === "init") {
  await import("./setup.js");
} else if (cmd === "start") {
  await import("./index.js");
} else {
  console.log(`
  @thxmxx/telegram-mcp

  npx @thxmxx/telegram-mcp init     One-time setup — registers MCP in Claude Code globally
  npx @thxmxx/telegram-mcp start    Start MCP server manually (for testing)

  After init, use in any Claude Code session:
    /use-telegram                   Full mode (notify + ask + choose)
    /use-telegram notify            Notifications only
`);
  process.exit(0);
}
