# yammbo-alerts

Cloudflare Worker that replaces the n8n workflow **site-healthcheck-alert**
(`siteHealthAlert01`). Receives alert POSTs from the VPS scripts and forwards
them to Telegram (@yammbo_alerts_bot).

## Emitters (VPS)

- `/root/scripts/site-healthcheck.sh` — site down (`kind` omitted → `health`)
- `/root/scripts/yammbo-backup-alert.sh` — backups (`kind: "backup"`, status OK/RECOVERED/LOCAL-ONLY/FATAL)

Both POST `{ kind?, site, status, failures, extra }` to
`<worker-url>/<ALERT_PATH>`. The path equals the legacy n8n webhook path
(`/root/.yammbo-healthcheck-webhook-path`), kept as a shared secret.

## Routing (`kind`)

| kind | status | message |
|---|---|---|
| health (default) | HTTP code | 🔴 SITE DOWN |
| backup | OK | 🟢 BACKUP OK |
| backup | RECOVERED | 🟢 BACKUP RECOVERED |
| backup | LOCAL-ONLY | 🟡 BACKUP LOCAL-ONLY |
| backup | FATAL / other | 🟠 BACKUP FAILED |
| heartbeat | (none) | stored in KV, **no** Telegram (see below) |

## Secrets

```
npx wrangler secret put TELEGRAM_BOT_TOKEN   # @yammbo_alerts_bot
npx wrangler secret put ALERT_PATH           # legacy n8n webhook path
# Only needed for AUTO_RESTART (all four, or the power cycle stays disabled):
npx wrangler secret put CONTABO_CLIENT_ID
npx wrangler secret put CONTABO_CLIENT_SECRET
npx wrangler secret put CONTABO_API_USER
npx wrangler secret put CONTABO_API_PASSWORD
```

Plain vars live in `wrangler.toml` `[vars]`: `TELEGRAM_CHAT_ID`, `VPS_IP`
(public IPv4 of the VPS, used to find the instance in Contabo) and
`AUTO_RESTART`.

## Backup dead-man switch

Cron `0 8 * * *`: checks that every expected R2 prefix got a fresh upload in
the last 26 h and alerts only when one is missing or stale.

## External VPS watcher

The Worker is the watcher of the VPS (Contabo) that hosts music/tv/web/app,
from outside it. Cron `*/2 * * * *` runs `vpsWatch()`; all the judgement is in
the pure function `decide()` (`src/vps.ts`), covered by `npm test`. Every
message is sent once per state change (the state machine is the dedup); state
is stored in KV (`STATE`, key `vps`) and only rewritten when it changes.

### Heartbeat

`yammbo-autofix` (on the VPS) POSTs to `/<ALERT_PATH>`:

```json
{ "kind": "heartbeat", "ts": 1761393600, "open": ["music"], "disabled": false, "host": "vps1" }
```

`ts` number, `open` array of at most 50 strings (each at most 100 chars),
`disabled` boolean (autofix kill switch), `host` string (at most 100 chars).
Valid: stored as KV `hb` = `{received, disabled, open, host}` (`received` is
the Worker's clock) and answered `204`, no Telegram. Invalid: `400`, nothing
stored. This is handled before the alert formatter, which would otherwise turn
any unknown kind into "SITE DOWN". About 1 KV write per heartbeat: with a
1-minute heartbeat that is over the free-plan limit (1000 writes/day), fine on
Workers Paid.

### Probes

Every tick, in parallel (10 s timeout, no redirects, no cache, UA
`yammbo-alerts-vpscheck`, cache-busting `?vpscheck=<ms>`): `music /`,
`tv /api/app-tv/version-movil`, `web /login`, `app /`. A probe is DOWN only on
HTTP 520-526 / 530 (Cloudflare cannot reach the origin) or when the fetch
throws/times out. Any other status (2xx/3xx/4xx, a 403 challenge, a 500) is UP
for this purpose: application errors are the on-VPS watcher's job.

### Alerts

| State | Condition | Message |
|---|---|---|
| VPS down | at least 3 probes DOWN and (no heartbeat ever, or heartbeat older than 6 min), on **2 consecutive ticks** | 🔴 VPS no responde desde HH:MM (Europe/Madrid) ... |
| VPS recovered | at most 1 probe DOWN on **2 consecutive ticks**, whatever the heartbeat says; only if the down alert was sent | 🟢 VPS responde de nuevo (caído N min) |
| Watcher silent | not "VPS down", at most 1 probe DOWN, heartbeat seen at least once and older than 10 min | 🟠 El vigilante del VPS (yammbo-autofix) no da señales ... |
| Watcher back | heartbeat younger than 4 min again | 🟢 El vigilante vuelve a dar señales. |

The heartbeat only matters to *declare* the VPS down; recovery looks at the
sites alone, so a VPS that booted with a dead autofix still closes the episode
(the watcher-silent alert covers the missing heartbeat) and a new outage can
alert again. A single failed tick never alerts. A VPS that has never sent a heartbeat never
raises the "watcher silent" alert.

### Power cycle through Contabo (AUTO_RESTART)

Off by default (`AUTO_RESTART = "off"`). It only acts when **all** hold:
`AUTO_RESTART = "on"`, the four `CONTABO_*` secrets exist, the last heartbeat
did not report `disabled: true` (autofix kill switch), and the Cloudflare
status indicator (cloudflarestatus.com) is not `major`/`critical` (an
unreachable status page counts as unknown, which is allowed).

1. "VPS down" has lasted at least 10 min, no cycle in progress, brakes allow.
2. Contabo status of the instance whose primary IPv4 equals `VPS_IP`:
   - `running`: clean ACPI **shutdown** (step `shutdown_sent`).
   - `stopped`: it does nothing and says so once (someone may have stopped it
     on purpose). Any other status: says it once, does nothing.
3. `shutdown_sent`: once Contabo reports `stopped` -> **start** (`start_sent`).
   Site recovery does **not** close the cycle in this step. Not stopped 4 min
   after the shutdown: if the sites are answering, the cycle is cancelled
   ("↩️ ... cancelo el reinicio", no hard restart); otherwise **restart**
   (forced, `restart_sent`; the disk is not touched).
4. `start_sent` / `restart_sent`: the sites being back on 2 ticks ends the
   cycle ("tras reiniciarlo"), even if autofix never sends a heartbeat again.
   Still down 15 min after the last action -> message and `gave_up`: nothing
   more happens until the episode closes. Check the VNC console / Contabo panel.

Invariant: from the idle step a Contabo `stopped` never leads to a start (the
owner may have powered the VPS off on purpose). A late ACPI shutdown of our
own is covered by staying in `shutdown_sent`.

Ordering and uncertainty: the new step (and the recorded cycle) is written to
KV **before** the Contabo POST, and if that write fails no POST is sent. A
clear 4xx from Contabo means "not done" (step reverted, cycle un-recorded). A
timeout, network error or 5xx means "unknown": the step stays as sent (so a
later `stopped` still leads to `start`) and it counts as a failure.

Brakes: no new cycle if one started in the last 6 h, or if 2 cycles started in
the last 24 h (timestamps kept in the `vps` state). Announced once per
episode ("Freno"), as is a Cloudflare incident. A failed Contabo call is
announced once, does not advance the step, is retried on the next tick and
after 3 failures in the same step becomes `gave_up`.

The Contabo client (`src/contabo.ts`) can only call: the OAuth token endpoint,
`GET /v1/compute/instances`, and `POST .../actions/{shutdown|start|restart}`.
There is deliberately no reinstall/cancel/stop/rescue/PUT/PATCH/DELETE, and
the action function only accepts that union type. Error messages carry the
HTTP status and a short message, never tokens or secrets.

### Watcher failures

`vpsWatch()` crashes are counted in KV key `watch_err` `{n, since, alerted}`.
At 3 consecutive failures one Telegram message ("⚠️ El vigilante externo
(yammbo-alerts) falla desde HH:MM: ...", token redacted) is sent, and one
"🟢 El vigilante externo vuelve a funcionar." when a tick succeeds again. If KV
itself is down the counter cannot work, so the alert is sent only on the tick
at minute 0-1 of the hour (about once an hour). Telegram sends have a 10 s
timeout. Each healthy tick does one extra KV read for this counter.

To turn the power cycle on (after setting the four secrets): change
`AUTO_RESTART = "on"` in `wrangler.toml` and redeploy; set it back to `"off"`
to disable. Switching it off in the middle of a cycle stops the cycle (and
says so), so check the panel if that happens.

## Tests

```
npm test            # vitest: decide() state machine, heartbeat validator, handler
npx tsc --noEmit
```

## Deploy

```
npm install
npm run deploy
```

## Migration note

Replaced n8n `site-healthcheck-alert` on 2026-05-29. The n8n Error Trigger
catch-all (`system-notify-errors`) stays on n8n until the last workflow leaves.
