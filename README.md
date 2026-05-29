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

## Secrets

```
wrangler secret put TELEGRAM_BOT_TOKEN   # @yammbo_alerts_bot
wrangler secret put ALERT_PATH           # legacy n8n webhook path
```

## Deploy

```
npm install
npm run deploy
```

## Migration note

Replaced n8n `site-healthcheck-alert` on 2026-05-29. The n8n Error Trigger
catch-all (`system-notify-errors`) stays on n8n until the last workflow leaves.
