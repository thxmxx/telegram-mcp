# @thxmxx/telegram-mcp

Telegram bridge for Claude Code. While Claude runs tasks on your machine, it notifies you, asks questions and shows option buttons — on your phone **and** on the terminal simultaneously. Whichever you answer first wins.

## Install (one-time, global)

```bash
npx @thxmxx/telegram-mcp init
```

The wizard asks for your Telegram bot token and user ID, registers the MCP server globally in Claude Code, and installs the `/use-telegram` slash command. You never need to run this again.

## Usage

Start Claude Code without permission prompts so it can work autonomously:

```bash
claude --dangerously-skip-permissions
```

> ⚠️ This flag disables all tool confirmation prompts — file writes, shell commands, everything. Use only on your own machine for personal workflows.

Then activate Telegram in any session:

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
| `telegram_notify` | Send a progress update. No reply needed. Never polls. |
| `telegram_ask` | Ask a free-form question. Waits for reply. Optional `timeout_s`. |
| `telegram_choose` | Show option buttons. Waits for a tap. Optional `timeout_s`. |
| `telegram_choose_batch` | Send up to 10 button cards at once and wait for all answers. Optional `timeout_s`. |
| `telegram_listen` | Wait for an instruction addressed to this instance (up to 1 hour). |

### Configurable wait (`timeout_s`)

`telegram_ask`, `telegram_choose` and `telegram_choose_batch` accept an optional integer `timeout_s`: how many seconds to wait for your answer. Default 300, clamped to 10..3600. For `ask` and `choose` the timeout error states the real value, for example `Timed out after 45s`.

### Batch choices (`telegram_choose_batch`)

Input:

```json
{
  "items": [
    { "id": "job1", "text": "Apply to this one?", "options": ["Send", "Skip"] },
    { "id": "job2", "text": "And this one?", "options": ["Send", "Skip", "Edit"] }
  ],
  "timeout_s": 600
}
```

`items` has 1 to 10 entries with unique `id`s. Every item is sent at once as its own message with inline buttons, and the tool waits until all are answered or the timeout hits. It returns:

```json
{ "answers": { "job1": "Send", "job2": null }, "timed_out": ["job2"] }
```

Buttons carry the batch, item and option index, so taps are unambiguous across items. A second tap on an item that is already answered is ignored. When an item is answered, its message is edited to show the choice and the buttons are removed. Texts that do not fit in one Telegram message (4096 chars) are sent first as plain text, split at paragraph, line or word boundaries, followed by a short message carrying the buttons. Batch messages are sent as plain text (no Markdown), so card text is shown exactly as given. Batch has no terminal fallback: answer on Telegram.

### Lazy polling and several sessions

The server does not poll Telegram when it starts. `telegram_notify` only calls `sendMessage`. Long polling starts when an `ask`, `choose`, `choose_batch` or `listen` is waiting and stops as soon as no waiter remains, so any number of Claude Code sessions can be open at once and send notifications without fighting over `getUpdates`.

Only one session can WAIT at a time. If a session starts waiting while another session is already polling the same bot, Telegram answers with a 409 conflict and the waiting tool returns an error saying another session is polling this bot, instead of hanging. Retry once the other session stops waiting. Replies sent while nobody was waiting are discarded when polling starts, so an old message never answers a new question.

## Updating

```bash
npx @thxmxx/telegram-mcp@latest init
```

Re-runs the setup with the latest version — updates the MCP server and the `/use-telegram` slash command automatically.

## Requirements

- Node.js 18+
- [Claude Code](https://docs.claude.ai/claude-code) installed and logged in
- A Telegram bot token — get one free from [@BotFather](https://t.me/botfather)
- Your Telegram user ID — message [@userinfobot](https://t.me/userinfobot)

## Permissions

On first use, Claude Code will ask you to approve the tools this MCP server registers (`telegram_notify`, `telegram_ask`, `telegram_choose`, `telegram_choose_batch`, `telegram_listen`). This is standard Claude Code behaviour, so you can review exactly what is being granted before accepting.


## Always-on per project

To activate Telegram automatically every time you open Claude Code in a project, add to your `CLAUDE.md`:

```markdown
## Communication

Always use /use-telegram in this session.
```

**Per project** — inside the repo (can be committed and shared with the team):
```
/your-project/CLAUDE.md
```

**Global** — applies to every project on your machine:
```
~/.claude/CLAUDE.md
```

## Security

- The MCP server only accepts responses from your configured Telegram user ID
- Credentials are stored in `~/.claude.json` by Claude Code — never in this repo
- If your token is ever exposed, revoke it immediately via @BotFather `/revoke` then re-run `init`

## License

MIT