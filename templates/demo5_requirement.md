# Goal

Build a practical Discord bot called "TigerBot" that aggregates async standups and syncs GitHub activity to a channel. The bot must run reliably and reduce context switching for distributed dev teams.

## Background

Discord is widely used for team coordination, but there is no built-in way to collect async standups and post a digest. Similarly, teams often want PR/issue updates in Discord without configuring GitHub webhooks manually. A bot that handles both improves daily workflow for remote teams.

We want a minimal but production-ready bot that can be self-hosted and verified by openTiger's autonomous workflow.

## Constraints

- Runtime: Node.js (>=22)
- Library: discord.js v14+
- Package manager: pnpm
- Persistence: SQLite or PostgreSQL (standup storage, GitHub webhook state)
- Use Discord Application Commands (slash commands)
- Bot token auth only; GitHub uses webhook or PAT for read/notify

## Acceptance Criteria

### Async Standup

- [ ] `/standup` - Submit your check-in: what you did, what you'll do, blockers (each optional, max 500 chars)
- [ ] Bot stores submissions keyed by user + date; one submission per user per day (last write wins or first wins, document)
- [ ] `/standup config digest <channel> <time>` - Set channel and cron time (e.g. `09:00`) for daily digest
- [ ] At configured time, bot posts a formatted digest: each participant's three fields in a readable block
- [ ] `/standup show` - Preview today's submissions (for channel mods or self)
- [ ] Submissions persist across bot restarts
- [ ] Timezone: configurable via env (e.g. `TZ=Asia/Tokyo`); document behavior

### GitHub Sync (read-only notifications)

- [ ] Bot registers a webhook endpoint (or uses GitHub App / PAT polling if simpler) for a configured repo
- [ ] When a PR is opened, updated, or merged: post to configured Discord channel with PR title, author, link, and status
- [ ] When an issue is opened or closed: post with title, author, link
- [ ] Configuration: `GITHUB_REPO`, `GITHUB_WEBHOOK_SECRET`, `DISCORD_CHANNEL_ID` (or equivalent)
- [ ] Events are de-duplicated (no duplicate posts for same event)
- [ ] Optional: filter by label or branch (e.g. only `main` PRs) via config

### Reminders (keep: not a Discord built-in)

- [ ] `/remind` - Set reminder: `in 30m` or `at 14:00` (relative: m/h/d; absolute time)
- [ ] Bot DMs the user when reminder fires (or mentions in channel if DM disabled)
- [ ] `/remind list` - List active reminders for the caller
- [ ] `/remind cancel <id>` - Cancel a reminder
- [ ] Reminders persist across bot restarts

### General

- [ ] Slash commands register on bot startup
- [ ] Graceful shutdown: close DB, finish in-flight reminders
- [ ] Clear error messages for invalid input
- [ ] Unit tests: standup aggregation logic, reminder scheduling
- [ ] Integration tests: mock Discord + GitHub where possible

## Scope

### In Scope

- Bot entry point and Discord client setup
- Slash command registration and handlers
- Standup: submit, store, digest scheduling, config
- GitHub: webhook receiver (or polling), event parsing, Discord post
- Reminders: create, list, cancel, scheduler loop
- SQLite or Postgres schema
- Env-based config

### Out of Scope

- OAuth2
- Music/audio
- Moderation
- Creating GitHub issues/PRs from Discord
- Multiple guild-specific configs (single config initially)
- Web dashboard

### Allowed Paths

- `apps/tiger-bot/**`
- `packages/db/**`
- `packages/core/**`
- `docs/**`

## Risk Assessment

| Risk                              | Impact | Mitigation                                     |
| --------------------------------- | ------ | ---------------------------------------------- |
| GitHub webhook delivery failure   | medium | Idempotent handling; optional polling fallback |
| Standup digest timezone confusion | medium | Document TZ; single env for all                |
| Reminder drift when bot is down   | low    | Reconcile DB on startup                        |

## Notes

Standup digest: use `node-cron` or `setInterval` aligned to configured time.

GitHub webhook: Express or Hono route at `/webhooks/github`; verify signature with `GITHUB_WEBHOOK_SECRET`.

For openTiger verification: `pnpm run build` and `pnpm run test` must pass; provide mock mode without real Discord/GitHub tokens.
