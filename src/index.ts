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
}

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
  if (extra) lines.push(`<b>${kind === 'error' ? 'Message' : 'Extra'}:</b> ${esc(extra)}`);
  return lines.join('\n');
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
};
