# @thxmxx/telegram-mcp

Telegram bridge for Claude Code. While Claude runs tasks on your machine, it notifies you, asks questions and shows option buttons — on your phone **and** on the terminal simultaneously. Whichever you answer first wins.

## Install (one-time, global)

```bash
npx @thxmxx/telegram-mcp init
```

The wizard asks for your Telegram bot token and user ID, registers the MCP server globally in Claude Code, and installs the `/use-telegram` slash command. You never need to run this again.

## Usage

In any Claude Code session, activate Telegram with the slash command:

```
/use-telegram
```

Or just mention it naturally in your prompt:

```
Refactor the auth module and notify me on Telegram when done.
Deploy to staging — ask me on Telegram if anything is unclear.
```

### Modes

```
/use-telegram            Full mode — notify + ask + choose
/use-telegram notify     Notifications only, no questions
```

### Combining with other slash commands

Slash commands are independent and composable:

```
/deploy staging
/use-telegram notify
```

## How it works

```
Claude Code runs a task
    ↓ calls telegram_choose("Which DB?", ["PostgreSQL", "MySQL", "SQLite"])
You get buttons on Telegram AND a numbered list on the terminal
    ↓ you tap PostgreSQL on your phone (or type 1 in the terminal)
Claude receives "PostgreSQL" and continues
```

Every message is tagged with an auto-generated instance label like `[backend#a3f2]` or `[frontend#9c11]` — so when you have multiple Claude Code sessions open you always know which one is talking.

If you answer from the terminal, Telegram confirms it:
```
[backend#a3f2] ✅ PostgreSQL (via terminal)
```

## Tools Claude gains

| Tool | Description |
|---|---|
| `telegram_notify` | Send a progress update. No reply needed. |
| `telegram_ask` | Ask a free-form question. Waits for reply. |
| `telegram_choose` | Show option buttons. Waits for a tap. |

## Requirements

- Node.js 18+
- [Claude Code](https://docs.claude.ai/claude-code) installed and logged in
- A Telegram bot token — get one free from [@BotFather](https://t.me/botfather)
- Your Telegram user ID — message [@userinfobot](https://t.me/userinfobot)

## Permissions

On first use, Claude Code will ask you to approve the three tools this MCP server registers (`telegram_notify`, `telegram_ask`, `telegram_choose`). This is standard Claude Code behaviour — you can review exactly what is being granted before accepting.

## Security

- The MCP server only accepts responses from your configured Telegram user ID
- Credentials are stored in `~/.claude.json` by Claude Code — never in this repo
- If your token is ever exposed, revoke it immediately via @BotFather `/revoke` then re-run `init`

## License

MIT
