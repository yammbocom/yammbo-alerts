/**
 * yammbo-alerts — Cloudflare Worker replacing the n8n workflow
 * `site-healthcheck-alert` (siteHealthAlert01).
 *
 * Receives POST alerts from the VPS scripts (site-healthcheck.sh and
 * yammbo-backup-alert.sh), routes by `kind`, formats an HTML message and
 * sends it to Telegram (@yammbo_alerts_bot). Drop-in for the old n8n webhook.
 *
 * Auth: the request path must equal ALERT_PATH (the legacy n8n webhook path,
 * a shared secret) — keeps the endpoint from being spammed by randoms.
 */

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ALERT_PATH: string;
  BACKUPS: R2Bucket;
}

// Dead-man switch (scheduled handler, see bottom of file): R2 prefixes that
// site-backup.sh / site-backup-all.sh are expected to have uploaded into
// today. A missing or stale prefix means either the timer didn't fire or the
// script ran and failed to upload — both are silent today, since
// yammbo-backup-alert.sh only speaks when the script itself runs.
//
// Keep in sync with the active .conf files in /etc/yammbo-backups.d/. pos and
// store were retired 2026-09-05 (their .conf renamed .disabled-*); their R2
// prefixes hold the final decommission tarballs and will never grow again.
const EXPECTED_BACKUP_PREFIXES = [
  'music.yammbo.com/',
  'tv.yammbo.com/',
  'web.yammbo.com/',
  'yammboshop.com/',
  'app.yammbo.com/',
  'vps-config/',
  'agent/',
];

// site-backup.timer runs at 03:30 UTC; this handler runs at 08:00 UTC. 26h
// tolerates one full missed window plus the RandomizedDelaySec/runtime slop
// without false-alarming on a backup that's merely running a bit late.
const MAX_BACKUP_AGE_HOURS = 26;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Mirrors the n8n "Format alert" Code node exactly. */
function formatAlert(b: Record<string, unknown>): string {
  const kind = String(b.kind ?? 'health').toLowerCase();
  const site = String(b.site ?? 'unknown').slice(0, 80);
  const status = String(b.status ?? '?').slice(0, 40);
  const failures = parseInt(String(b.failures ?? 1), 10) || 1;
  const extra = String(b.extra ?? '').slice(0, 600);
  const when = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  let header: string;
  let statusLine: string;
  // Which detail label to use for the status line, and whether to show the
  // "consecutive failed checks" line (only meaningful for health checks).
  let statusLabel = 'HTTP';
  let showFailures = false;
  if (kind === 'backup') {
    const upper = status.toUpperCase();
    if (upper === 'OK') { header = '\u{1F7E2} <b>BACKUP OK</b>'; statusLine = 'OK'; }
    else if (upper === 'RECOVERED') { header = '\u{1F7E2} <b>BACKUP RECOVERED</b>'; statusLine = 'Recovered'; }
    else if (upper === 'LOCAL-ONLY') { header = '\u{1F7E1} <b>BACKUP LOCAL-ONLY</b>'; statusLine = 'Local OK / R2 failed'; }
    else { header = '\u{1F7E0} <b>BACKUP FAILED</b>'; statusLine = upper; }
    statusLabel = 'Status';
    showFailures = true; // keep backup output identical to the pre-change format
  } else if (kind === 'error') {
    // Application error/log alert (e.g. Laravel error channel).
    header = '\u{1F7E0} <b>APP ERROR</b>';
    statusLine = status; // log level: ERROR / CRITICAL / ...
    statusLabel = 'Level';
  } else if (kind === 'cookies') {
    // YouTube global-cookies health.
    const upper = status.toUpperCase();
    header = upper === 'OK'
      ? '\u{1F7E2} <b>YOUTUBE COOKIES OK</b>'
      : '\u{1F36A} <b>YOUTUBE COOKIES EXPIRED</b>';
    statusLine = status;
    statusLabel = 'Status';
  } else if (kind === 'playback') {
    // Music playback dependency (YouTube InnerTube search). Not a site outage:
    // the site stays up, but new tracks stop resolving to a video ID.
    const upper = status.toUpperCase();
    header = upper.includes('OK')
      ? '\u{1F7E2} <b>PLAYBACK OK</b>'
      : '\u{1F7E0} <b>PLAYBACK FAILING</b>';
    statusLine = status;
    statusLabel = 'Status';
  } else if (kind === 'payment') {
    // Payment gateway failure (Stripe/PayPal). Money that did not go through,
    // which does not always surface as an application ERROR.
    header = '\u{1F4B3} <b>PAYMENT FAILED</b>';
    statusLine = status; // gateway name / failure code
    statusLabel = 'Gateway';
  } else {
    header = '\u{1F534} <b>SITE DOWN</b>';
    statusLine = status;
    statusLabel = 'HTTP';
    showFailures = true;
  }

  const lines = [header, `<b>Site:</b> ${esc(site)}`];
  lines.push(`<b>${statusLabel}:</b> ${esc(statusLine)}`);
  if (showFailures) lines.push(`<b>Failed checks:</b> ${failures} consecutive`);
  lines.push(`<b>Time:</b> ${when}`);
  if (extra) lines.push(`<b>${kind === 'error' || kind === 'payment' ? 'Message' : 'Extra'}:</b> ${esc(extra)}`);
  return lines.join('\n');
}

/**
 * Most recent `uploaded` timestamp under `prefix`, or null if the prefix has
 * no objects at all (missing backup, not just an old one). R2 list() pages
 * at up to 1000 objects per call and does not guarantee any ordering by
 * date, so every page has to be scanned rather than trusting the last one.
 */
async function newestUpload(bucket: R2Bucket, prefix: string): Promise<Date | null> {
  let cursor: string | undefined;
  let newest: Date | null = null;
  for (;;) {
    const listing = await bucket.list({ prefix, cursor });
    for (const obj of listing.objects) {
      if (!newest || obj.uploaded > newest) newest = obj.uploaded;
    }
    if (!listing.truncated) break;
    cursor = listing.cursor;
  }
  return newest;
}

/** Checks every expected backup prefix, returns a human line per failure. */
async function checkBackupFreshness(env: Env): Promise<string[]> {
  const failures: string[] = [];
  for (const prefix of EXPECTED_BACKUP_PREFIXES) {
    const newest = await newestUpload(env.BACKUPS, prefix);
    if (!newest) {
      failures.push(`${prefix} — no objects found`);
      continue;
    }
    const ageHours = (Date.now() - newest.getTime()) / 3_600_000;
    if (ageHours > MAX_BACKUP_AGE_HOURS) {
      failures.push(`${prefix} — last object ${ageHours.toFixed(1)}h old`);
    }
  }
  return failures;
}

async function sendTelegram(env: Env, text: string): Promise<boolean> {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  return resp.ok;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const seg = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');

    // Liveness probe of the Worker itself (GET / -> 200, no auth).
    if (req.method === 'GET' && seg === '') {
      return new Response('yammbo-alerts ok', { status: 200 });
    }
    if (req.method !== 'POST') {
      return new Response('method not allowed', { status: 405 });
    }
    // Path must match the shared secret.
    if (!env.ALERT_PATH || seg !== env.ALERT_PATH) {
      return new Response('not found', { status: 404 });
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      // Tolerate bad/empty JSON: still fire a generic alert rather than swallow it.
      body = { status: 'malformed-payload' };
    }

    const text = formatAlert(body);
    const ok = await sendTelegram(env, text);
    if (!ok) return new Response('telegram send failed', { status: 502 });
    return new Response('OK', { status: 200 });
  },

  /**
   * Dead-man switch, cron-triggered (see wrangler.toml). Runs outside the
   * VPS, so it catches both "the timer never fired" and "it fired but
   * uploaded nothing" — silence in the VPS-side alerter reads as success in
   * both cases. Silence here is the normal outcome too: only speaks up when
   * a prefix is actually missing or stale, one message per run, no retries.
   *
   * The message text intentionally carries no per-run id/timestamp beyond
   * the (slow-changing, hour-granularity) staleness age — a unique token per
   * run would defeat the alert throttle that dedupes by message text.
   */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const failures = await checkBackupFreshness(env);
    if (failures.length === 0) return; // all prefixes fresh — say nothing

    const lines = [
      '\u{1F534} <b>BACKUP DEAD-MAN SWITCH</b>',
      `<b>Missing/stale prefixes:</b> ${failures.length}`,
      ...failures.map((f) => esc(f)),
    ];
    await sendTelegram(env, lines.join('\n'));
  },
};
