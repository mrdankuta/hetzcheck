# Hetzner CX33 Availability Monitor

Monitors the availability of one or more **Hetzner Cloud** server types
(defaults to **CX33 (Cost Optimized)**) across multiple locations (`fsn1`,
`nbg1`, `hel1` by default) and notifies you the moment any of them becomes
available — in the console (with a large green banner) and, optionally, via
**Telegram**.

- Written in **Node.js + TypeScript**.
- Uses the **official Hetzner Cloud API** (`axios`) — no HTML/browser scraping.
- Checks every **60 seconds** (configurable).
- Reads secrets from a `.env` file via `dotenv`.

## How availability is detected (no resources created)

Hetzner does not expose a single boolean "available" flag on a server type, and
there is no "dry-run" for server creation. The correct, side-effect-free way to
check availability is the [`/datacenters`](https://docs.hetzner.cloud/#datacenters)
endpoint: every datacenter reports which server types are currently
`available` for creation.

This project:

1. Resolves the server type name (`cx33`) to its numeric id via
   [`/server_types`](https://docs.hetzner.cloud/#server-types).
2. Fetches all datacenters and, for the datacenters belonging to your chosen
   locations, checks whether the `cx33` id is present in `server_types.available`.

No servers are ever created, so you are never billed for this check.

## Requirements

- Node.js 18+ (developed and tested on Node 20/22).
- A Hetzner Cloud account and project.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your `.env` from the template and fill it in:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Edit `.env`:

```env
API_TOKEN=your_hetzner_api_token
TELEGRAM_BOT_TOKEN=your_bot_token   # optional
TELEGRAM_CHAT_ID=your_chat_id       # optional
```

If you leave the two Telegram values empty, the monitor still runs and prints to
the console; it just won't send Telegram messages.

## How to get a Hetzner API Token

1. Log in to the [Hetzner Cloud Console](https://console.hetzner.cloud/).
2. Select (or create) a **Project**.
3. Open **Security → API Tokens**.
4. Click **Generate API Token**.
5. Give it a description (e.g. `cx33-monitor`) and choose **Read** permission
   (read access is enough for availability checks).
6. Copy the token immediately — it is shown only once — and paste it into `.env`
   as `API_TOKEN`.

## How to create a Telegram Bot

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts (choose a name and a username ending in
   `bot`).
3. BotFather replies with a token like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxx`.
4. Put that token into `.env` as `TELEGRAM_BOT_TOKEN`.

## How to get the Chat ID

1. Open a chat with your new bot and send it any message (e.g. `hi`).
   (For a group, add the bot to the group and send a message there.)
2. In your browser, open:

```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```

Replace `<YOUR_BOT_TOKEN>` with your real token.

3. In the JSON response, find `"chat":{"id":...}`. That number is your
   `TELEGRAM_CHAT_ID` (it is negative for groups).
4. Put it into `.env` as `TELEGRAM_CHAT_ID`.

> Tip: you can also message [@userinfobot](https://t.me/userinfobot) to get your
> personal chat id quickly.

## Running

Development (runs the TypeScript directly, no build step):

```bash
npm run dev
```

Production (compile once, then run the compiled JavaScript):

```bash
npm run build
npm start
```

## Free 24/7 deployment via GitHub Actions (no VPS, no card)

You can run the monitor for free using **GitHub Actions** — no server and no
credit card required. A ready-to-use workflow is included at
`.github/workflows/monitor.yml`.

### How it stays continuous (and why not a 5-minute cron)

GitHub's short cron schedules (like `*/5`) are unreliable — GitHub frequently
delays or skips them under load. So instead, each workflow run **stays alive
for ~5 hours and checks every 60 seconds**. A coarse schedule (every 2 hours)
keeps a fresh run queued; because a `concurrency` group serializes runs, the
next run takes over seamlessly the moment the current one ends. The result is
**~60-second detection latency, 24/7, for free** on a public repository.

The "already notified" state is persisted between run handoffs via the Actions
cache, so Telegram still fires only once per availability episode. Your
computer/browser does not need to be on — everything runs on GitHub's servers.

### Steps

1. **Create a GitHub repository** and push this project to it:

```bash
git init
git add .
git commit -m "Hetzner CX33 monitor"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

> `.env` is git-ignored and will NOT be pushed — your tokens stay local. You'll
> provide them to GitHub as encrypted secrets in the next step.

2. **Add your secrets** in the repo:
   `Settings → Secrets and variables → Actions → Secrets → New repository secret`.
   Add:
   - `API_TOKEN` — your Hetzner Cloud token
   - `TELEGRAM_BOT_TOKEN` — your Telegram bot token
   - `TELEGRAM_CHAT_ID` — your chat id

3. **(Optional) Override defaults** under the *Variables* tab (same page):
   - `SERVER_TYPES` — e.g. `cx33,cx23` (default `cx33`)
   - `LOCATIONS` — e.g. `fsn1,nbg1,hel1` (default `fsn1,nbg1,hel1`)

4. **Enable Actions**: open the **Actions** tab and enable workflows if prompted.
   Trigger the first run manually with **Run workflow** (the workflow has
   `workflow_dispatch`). After that it self-sustains: each run lasts ~5h and the
   schedule keeps the next one queued, so monitoring continues automatically.

### Good to know

- Public repos get **unlimited free Actions minutes** — required here, since
  the monitor runs continuously. A private repo's ~2000 free minutes/month
  would be exhausted, so **use a public repo** for 24/7 monitoring.
- Secrets are **encrypted** and safe even in public repositories.
- Each run self-exits cleanly after `MAX_RUNTIME_SECONDS` (5h) so it finishes
  green rather than being force-cancelled at GitHub's 6h hard limit.
- Scheduled workflows are automatically disabled after **60 days** of repo
  inactivity; just push a commit or re-enable to resume.
- To check less often (e.g. to save minutes on a private repo), raise
  `CHECK_INTERVAL_SECONDS` and/or switch to the one-shot `RUN_ONCE` mode.

### Run it as a single check locally

The same single-check mode powers the workflow. You can reproduce it locally:

```bash
RUN_ONCE=true STATE_FILE=.state/state.json npm run dev
```

On Windows PowerShell:

```powershell
$env:RUN_ONCE="true"; $env:STATE_FILE=".state/state.json"; npm run dev
```

## Configuration options

All configuration lives in `.env` (see `.env.example`):

| Variable                 | Required | Default            | Description                                                        |
| ------------------------ | -------- | ------------------ | ------------------------------------------------------------------ |
| `API_TOKEN`              | yes      | —                  | Hetzner Cloud API token (Read is enough for monitoring; Read & Write required for auto-provisioning). |
| `TELEGRAM_BOT_TOKEN`     | no       | —                  | Telegram bot token. Enables Telegram when set.                     |
| `TELEGRAM_CHAT_ID`       | no       | —                  | Telegram chat id. Enables Telegram when set.                       |
| `SERVER_TYPES`           | no       | `cx33`             | Comma-separated Hetzner server type names, e.g. `cx33,cx23,cpx31`. |
| `LOCATIONS`              | no       | `fsn1,nbg1,hel1`   | Comma-separated Hetzner location names.                            |
| `CHECK_INTERVAL_SECONDS` | no       | `60`               | Seconds between checks (ignored when `RUN_ONCE=true`).            |
| `RUN_ONCE`               | no       | `false`            | Run one check and exit (one-shot / cron style).                 |
| `MAX_RUNTIME_SECONDS`    | no       | `0`                | Loop mode: exit cleanly after N seconds (`0` = forever).        |
| `STATE_FILE`             | no       | —                  | Path to persist "notified" + "provisioned" state across runs / handoffs. |
| `PROVISION_ENABLED`      | no       | `false`            | When `true`, create one server per type on first availability. Billing starts immediately. |
| `PROVISION_IMAGE`        | when provisioning | —       | OS image, e.g. `ubuntu-24.04`. Required when `PROVISION_ENABLED=true`. |
| `PROVISION_SSH_KEYS`     | no       | —                  | Comma-separated SSH key names already uploaded to Hetzner Cloud.   |
| `PROVISION_NAME_PREFIX`  | no       | `hetzcheck-`       | Server name = `<prefix><type>`, e.g. `hetzcheck-cx33`. Doubles as idempotency key. |
| `PROVISION_DRY_RUN`      | no       | `false`            | When `true`, log what would be created without calling `POST /servers`. |

> Watching several server types adds **no extra API requests** — one
> `/datacenters` call per cycle covers all of them. Each type is tracked
> independently, so you get one Telegram message per type when it appears.

## Auto-provisioning (optional)

When `PROVISION_ENABLED=true`, the monitor creates **one server per watched
type** the first time it becomes available, then keeps monitoring the
remaining types:

- **Target comes from `SERVER_TYPES`/`LOCATIONS`.** For each type, the first
  available location in your `LOCATIONS` order wins (e.g. `fsn1` before
  `nbg1`). Server name is `<PROVISION_NAME_PREFIX><type>`
  (e.g. `hetzcheck-cx33`).
- **Exactly once per type.** A `provisioned:<type>` flag in `STATE_FILE`
  is authoritative — even if you later delete the server, nothing is
  recreated unless you clear the state. A remote `GET /servers?name=`
  check guards against duplicates when the state file is lost (e.g. Actions
  cache miss). A duplicate-name race between check and create is also
  treated as done, not retried.
- **Failures retry.** If creation fails (sold out between check and create,
  rate limit, network), the flag stays unset and the next 60s cycle retries.
- **Token scope.** Monitoring works with a Read-only token; provisioning
  needs **Read & Write**. Auth failures are logged with this hint.
- **Test safely first:** set `PROVISION_DRY_RUN=true` to log
  `[DRY RUN] Would provision ...` lines without creating anything, and
  confirm the target type/location/name look right.

GitHub Actions wiring: set `PROVISION_ENABLED`, `PROVISION_IMAGE`,
`PROVISION_NAME_PREFIX` as Variables and `PROVISION_SSH_KEYS` as a Secret
(see `.github/workflows/monitor.yml`). Your `API_TOKEN` secret must be the
Read & Write token.

## Example output

When available (with hardware specs and location price):

```
===================================
CX33 AVAILABLE!
Location: fsn1
CPU: 4 vCPU (shared)
RAM: 8 GB
SSD: 80 GB
Price: €9.03/mo (€0.0142/h)
Time: 2026-07-22 20:30
===================================
```

And, once per availability episode, a Telegram message:

```
🚀 Hetzner CX33 AVAILABLE!

Location: fsn1

CPU: 4 vCPU (shared)
RAM: 8 GB
SSD: 80 GB
Price: €9.03/mo (€0.0142/h)

Time: 2026-07-22 20:30
```

When unavailable:

```
CX33 unavailable
```

## Notification behavior

- The Telegram message is sent **only once** when the server transitions from
  *unavailable* to *available*.
- When it becomes *unavailable* again, the internal state resets, so the next
  time it becomes available you get notified again.

## License

MIT
