# Discord Pi research agent

A mention-driven Discord bot that answers questions using a local GitHub checkout and relevant Discord discussions. Built with Node.js 24 LTS, TypeScript, discord.js, Pi, and Node's built-in SQLite (FTS5). Gemini Flash is the default.

## Architecture

```text
Discord mention → allowlist + cooldown → bounded request queue
  → persistent Pi session per guild/channel (threads have their own IDs)
    → repo_search / repo_read → guarded Pi built-in grep/read → local checkout
    → sync_repository (explicit update requests only) → origin fetch + fast-forward
    → discord_search / discord_context → SQLite FTS5 → excerpts + message URLs
  → Discord replies

Discord events + bounded REST backfill → SQLite
Pi response usage → SQLite → /usage
```

The four research tools are read-only. A fifth tool, `sync_repository`, is enabled only for an explicit update command in the current Discord message. There is no shell, general file editing, arbitrary HTTP, extensions, skills, or automatic repository instructions. Trusted host code runs fixed Git commands for the sync tool; Pi's grep uses ripgrep as a fixed search utility, without a shell.

## Setup

1. Install **Node.js 24 LTS**, npm, Git, and ripgrep (`sudo apt install git ripgrep` on Ubuntu). Node 24 includes SQLite/FTS5; it may print an experimental SQLite warning. No database server or native npm SQLite module is required.
2. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and bot. Enable **Message Content Intent**. Copy the bot token.
3. Invite the bot to one server with OAuth2 scopes **`bot`** and **`applications.commands`**. Grant **View Channels**, **Read Message History**, **Send Messages**, and **Send Messages in Threads** in the approved channels. Administrator and member-list intents are unnecessary. Enable Developer Mode in Discord to copy server/channel IDs.
4. Create a Google AI Studio API key with access to Gemini. The configured default is `google` / `gemini-2.5-flash`; both are configurable using Pi catalog IDs.
5. Clone the research repository into a **separate directory**. Use an existing checkout with an `origin` remote, a clean working tree, and the branch selected by `REPO_BRANCH`:

   ```bash
   git clone --branch main https://github.com/OWNER/REPOSITORY.git /path/to/research-repo
   ```

6. In this application's directory:

   ```bash
   npm ci
   cp .env.example .env
   chmod 600 .env
   # Edit .env: tokens, guild/channel IDs, REPO_PATH, and branch.
   npm run check
   npm test
   npm run dev
   ```

Use `@bot Where is authentication checked?` or `@bot How does the retry code compare with the rollout discussion?`. For project orientation, the agent can search filenames for `README` before reading relevant sections. `/usage` is registered automatically as a guild command and shows this channel/thread's persisted token totals and estimated USD cost, privately to the caller.

### Updating the research repository

Updates are on demand. Start a Discord request with a direct command such as:

- `@bot pull from main`
- `@bot pull from origin/main`
- `@bot sync repository`
- `@bot can you please update the repo?`
- `@bot pull from main and summarize the changes`

The agent can then invoke `sync_repository` for `REPO_BRANCH` (default `main`). The tool fetches that branch from `origin` and fast-forwards the local checkout. It returns `status`, `branch`, `previousCommit`, and `updatedCommit`; matching hashes produce `status=already_up_to_date`. An update uses one of the five allowed tool executions.

Only the configured branch is accepted. Dirty working trees (including staged and untracked files), changed checkout branches, and non-fast-forward updates are rejected. The tool never pushes, resets, switches branches, rebases, or stashes. Requests for other branches are rejected even if the agent supplies the configured branch as its tool argument. Quoted commands, questions about pulling, prior conversation, and retrieved content do not enable the tool.

There is no repository fetch at startup or on a timer. `REPO_SYNC_SECONDS` has been removed and can be deleted from existing `.env` files. Discord history indexing retains its separate `HISTORY_SYNC_SECONDS` schedule.

For a production build:

```bash
npm run build
npm start
```

`dev` and `start` load `.env` with Node's environment-file support. Existing process environment values take precedence. The service template supplies its environment directly and runs the compiled JavaScript.

## Enforced budgets

| Boundary | Default | Enforcement |
|---|---:|---|
| Tool executions per mention | 5 | Pi before-tool hook; tools removed at the limit, excess calls blocked/aborted |
| Distinct repository files read | 3 | Per-request set; read requires a preceding search hit |
| Repository read size | 100 lines / 6,000 UTF-8 bytes returned | Tool schema + output clipping; file size capped at 1 MB |
| Repository search | 40 content hits or 30 filename hits / 6,000 bytes | Guarded built-in literal grep or tracked filename filtering |
| Retrieved Discord messages | 10 total | Shared search/context counter, deduplication |
| Retrieved Discord tokens | at most 2,000 | Shared **2,000 UTF-8-byte** budget including message links/metadata; deliberately more conservative than typical token counting |
| Previous conversation | 3 short turns | Old tool payloads/thinking removed; dialogue clipped and trimmed before every model call |
| Model context | 48,000 serialized UTF-8 bytes | Hard check before every call; fails closed if the current turn cannot fit |
| Model output | 1,500 tokens/call | Provider `maxTokens` option |
| Model calls / wall time | 9 / 120 seconds | Includes tool turns and automatic retries; wall-time abort |
| Load | 2 active / 10 queued | Bounded queue; same-channel requests serialized; 10-second per-user cooldown |

Hard ceilings for tool calls, files and Discord retrieval cannot be raised through `.env`. Other limits have validated ranges. All supported settings and defaults are in [`.env.example`](.env.example). `CONTEXT_TURNS=0` disables prior dialogue; sessions still persist. Sessions keep full transcripts **on disk**, but only bounded context is sent to the API. Usage is provider-reported, including failed responses when usage is available; cached tokens are listed separately. Catalog prices are estimates, not billing data.

## Discord history and access

- Only `DISCORD_GUILD_ID` and `DISCORD_ALLOWED_CHANNEL_IDS` are accepted. Public/announcement threads inherit approval from an approved parent; a public thread can also be explicitly approved. **Private threads and DMs are excluded.** Approve only discussion channels appropriate for bot-assisted sharing.
- Non-bot text messages are stored on create/update and removed on observed delete/bulk-delete events. Attachments are not downloaded; bot replies are not indexed, avoiding self-retrieval loops.
- Startup and periodic background indexing fetch the newest `HISTORY_BACKFILL_MESSAGES` messages per approved channel/public thread, in REST pages of at most 100. Active threads and up to `HISTORY_ARCHIVED_THREADS` archived public threads per approved parent are discovered, with at most `HISTORY_MAX_SCOPES` channel/thread scopes per pass (default 100). Forum posts are public threads. Backfill is bounded, so gaps beyond the configured window, older archived threads, and deletions while offline may not be reflected. Restart backfill repairs recent edits. Set backfill to 0 for live-only indexing.
- Retrieval uses FTS5 keyword ranking and match-centered snippets across up to `HISTORY_MAX_SCOPES` recently active indexed channels/threads. An optional `channel_id` search filter targets a specific approved channel. Follow-up history retrieval requires a search result anchor. No entire channel history is put in context.
- Each retrieval rechecks current server membership, channel visibility and history permissions for both the requester and the bot. Removed approvals take effect immediately for retrieval, even though older rows remain in SQLite. Discord links are returned as `https://discord.com/channels/GUILD/CHANNEL/MESSAGE` for citation.
- Sessions are shared by participants in the same channel/thread, matching that discussion's audience, and isolated from other channels. Old tool results are not replayed on future requests. This is not a personal-DM assistant.

## Repository and credential boundaries

- Only tracked, regular files beneath the canonical repository root are readable. Path traversal, symlinks (including symlink directories), binary reads, oversized files, `.git`, `.env*`, credential/secret-named files, and common key/database files are blocked. Searches respect Git ignore rules and filter results against the tracked-file policy.
- `REPO_PATH` and `DATA_DIR` must not overlap, including through symlink aliases. Keep the bot's `.env`, state, SSH keys, and credentials outside the research checkout. Known environment secret values and common credential formats are redacted before stored/retrieved text enters model context or replies. Pattern redaction is defense in depth; the checkout should contain source material, not credentials hidden in arbitrary source files.
- The API key is supplied to Pi's model runtime, never to its prompt or tools. Raw API/Git errors and message contents are not logged. All repository and Discord tool content is explicitly labeled untrusted in the system instructions. Tool capabilities and budgets remain enforced regardless of prompt injection.
- `sync_repository` is the sole mutating agent tool and is gated in code by a direct update command in the current Discord request. It fetches only `refs/heads/REPO_BRANCH` from `origin`, verifies commit ancestry, and performs a **fast-forward-only** merge of the fetched commit. Hooks, autostashing, recursive submodule fetches and filesystem-monitor execution are disabled. Dirty checkouts, changed branches, non-fast-forward targets, and authentication/network errors are reported through sanitized tool errors. No push, reset, force checkout, dependency installation, or repository scripts run. Tool reads/searches are serialized with Git updates; search hits are invalidated after an update so subsequent file reads need fresh evidence.
- For private repositories, configure a **read-only deploy key** or host credential helper. Do not embed credentials in remote URLs or `.env` repository paths. Git runs with a reduced environment and interactive credential prompts disabled; SSH keys/known_hosts should be configured for unattended use. Repository permissions on GitHub should be read-only.

Pi's current package is `@earendil-works/pi-coding-agent` (1.3.0 APIs), with `@earendil-works/pi-ai`. Implementation was verified against the installed SDK declarations and the [SDK documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md). `package-lock.json` pins the dependency tree.

## Oracle Cloud Always Free deployment

Use an Always Free-eligible Ubuntu VM, such as an Ampere A1 allocation available within your tenancy's free limits. This bot requires outbound HTTPS to Discord, Google and GitHub; it needs **no inbound application port**. Keep SSH access restricted using your Oracle networking/security configuration.

1. Install Node 24 LTS system-wide, Git and ripgrep. Verify `/usr/bin/node --version` or adjust the service's `ExecStart` path.
2. Create a dedicated account and directories:

   ```bash
   sudo useradd --system --home /var/lib/discord-agent --shell /usr/sbin/nologin discord-agent
   sudo mkdir -p /opt/discord-agent/app /opt/discord-agent/repository /var/lib/discord-agent
   sudo chown -R discord-agent:discord-agent /opt/discord-agent /var/lib/discord-agent
   ```

3. Put the application in `/opt/discord-agent/app`, and clone the research repository into `/opt/discord-agent/repository` as the service user. From the app directory, install dependencies with `npm ci`, run checks/tests, and build with `npm run build`. Create a mode-600 `.env`, owned by `discord-agent`, with the deployment paths, Discord settings and API key. Set `DATA_DIR=/var/lib/discord-agent` (also supplied by the template).
4. For private GitHub access, put `.ssh` under `/var/lib/discord-agent`, with mode 700, a read-only deploy key mode 600, and verified GitHub `known_hosts`. The service uses this directory as `HOME`; it cannot read a login user's home. Run a fetch as the service account before enabling the service.
5. Install the template:

   ```bash
   sudo cp deploy/discord-agent.service /etc/systemd/system/discord-agent.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now discord-agent
   sudo systemctl status discord-agent
   sudo journalctl -u discord-agent -f
   ```

The service restarts on crashes and after reboot, uses a private state directory, and permits filesystem writes only to state and the configured checkout for explicit sync requests. The agent's only mutation capability is the guarded `sync_repository` tool. Rebuild and `sudo systemctl restart discord-agent` after application upgrades. Back up `/var/lib/discord-agent` (SQLite plus Pi JSONL sessions) while the service is stopped; it contains discussion data. Disk history is append-only until you apply your own retention policy.

## Verification

### Safe request diagnostics

The bot writes structured JSON diagnostics to stdout/stderr (or `journalctl -u discord-agent` under systemd). `model_call_started` and `model_call_finished` identify the provider/model, a random request ID, the per-request model-call count, elapsed `durationMs`, and the model stop reason. Model-call duration includes provider transport/retry time; the count tracks Pi stream invocations, including Pi-level retries and tool turns. `request_finished` includes total request duration and tool/retrieval counters.

Provider errors are classified using numeric HTTP status and allowlisted reasons such as `API_KEY_INVALID`, `RESOURCE_EXHAUSTED`, or `INVALID_ARGUMENT`. Raw error bodies, headers, URLs, API keys, prompts, retrieved text and model replies are never included in these diagnostics. `request_timeout` and `limit_exceeded`/`limit_reached` distinguish deadlines and named budgets from provider errors. A `discord_request_failed` event includes the processing stage; a failure before the model starts reports zero model calls.

For a failing question, share only the JSON diagnostics for its request ID. They distinguish authentication/quota/model/API failures, SDK errors, timeouts, and enforced limits without exposing discussion content.

```bash
npm run check
npm test
npm run build
```

Targeted tests exercise SQLite ranking/isolation, repository guards and bounded reads, explicit-sync authorization, commit results and update rejection cases, Discord retrieval budgets, queue behavior, and actual Pi sessions with mocked model responses. They do not require live API keys or a Discord login. For the live smoke test, start with one approved channel, mention the bot, ask a mixed code/discussion question, check citations and `/usage`, request `pull from main`, restart, and verify channel session continuity and rejection in an unapproved channel.
