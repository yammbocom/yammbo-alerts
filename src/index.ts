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
 *
 * It is also the external watcher of the VPS: yammbo-autofix on the VPS posts
 * a `heartbeat` (stored in KV, never sent to Telegram) and a 2-minute cron
 * probes the sites from outside — see vpsWatch() and src/vps.ts.
 */

import { type VpsObs, decide, actionFailed, hhmm, parseVpsState, validateHeartbeat } from './vps';
import { actionOutcome, cloudflareIndicator, contaboPower, contaboStatus, hasContaboSecrets, shortError } from './contabo';

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ALERT_PATH: string;
  BACKUPS: R2Bucket;
  STATE: KVNamespace;
  VPS_IP: string;
  AUTO_RESTART: string; // "on" enables the Contabo power cycle; anything else = alert only
  CONTABO_CLIENT_ID?: string;
  CONTABO_CLIENT_SECRET?: string;
  CONTABO_API_USER?: string;
  CONTABO_API_PASSWORD?: string;
}

// Sites that live on the VPS, probed from outside every 2 minutes. A probe
// counts as DOWN only for Cloudflare's "origin unreachable" family (52x/530)
// or a fetch that throws/times out; app-level errors (500, 403 challenge...)
// are the on-VPS watcher's business.
const VPS_PROBES = [
  { name: 'music', url: 'https://music.yammbo.com/' },
  { name: 'tv', url: 'https://tv.yammbo.com/api/app-tv/version-movil' },
  { name: 'web', url: 'https://web.yammbo.com/login' },
  { name: 'app', url: 'https://app.yammbo.com/' },
];
const ORIGIN_DOWN_CODES = new Set([520, 521, 522, 523, 524, 525, 526, 530]);

// Dead-man switch (scheduled handler, see bottom of file): R2 prefixes that
// site-backup.sh / site-backup-all.sh are expected to have uploaded into
// today. A missing or stale prefix means either the timer didn't fire or the
// script ran and failed to upload — both are silent today, since
// yammbo-backup-alert.sh only speaks when the script itself runs.
//
// Keep in sync with the active .conf files in /etc/yammbo-backups.d/. pos and
// store were retired 2026-09-05 (their .conf renamed .disabled-*); their R2
// prefixes hold the final decommission tarballs and will never grow again.
// yammboshop.com was removed 2026-10-16 with no final backup (prefix purged).
const EXPECTED_BACKUP_PREFIXES = [
  'music.yammbo.com/',
  'tv.yammbo.com/',
  'web.yammbo.com/',
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
    signal: AbortSignal.timeout(10_000),
  });
  return resp.ok;
}

/** One external probe. code is null when the fetch threw or timed out. */
async function probeSite(p: { name: string; url: string }): Promise<{ name: string; code: number | null }> {
  const u = new URL(p.url);
  u.searchParams.set('vpscheck', String(Date.now()));
  try {
    // `cache` is honoured by workerd but missing from workers-types' RequestInit.
    const init: RequestInit & { cache: 'no-store' } = {
      redirect: 'manual',
      cache: 'no-store',
      headers: { 'user-agent': 'yammbo-alerts-vpscheck' },
      signal: AbortSignal.timeout(10_000),
    };
    const resp = await fetch(u.toString(), init);
    return { name: p.name, code: resp.status };
  } catch {
    return { name: p.name, code: null };
  }
}

/**
 * External VPS watcher, runs every 2 minutes. All the judgement lives in the
 * pure decide() (src/vps.ts); this function only does the I/O around it:
 * probes, heartbeat/state in KV, Contabo, Telegram.
 */
async function vpsWatch(env: Env): Promise<void> {
  const now = Date.now();
  const prev = parseVpsState(await env.STATE.get('vps', 'json'));
  const hb = await env.STATE.get<{ received?: unknown; disabled?: unknown }>('hb', 'json');
  const hbSeen = !!hb && typeof hb.received === 'number';

  const results = await Promise.all(VPS_PROBES.map(probeSite));
  const isDown = (r: { code: number | null }): boolean => r.code === null || ORIGIN_DOWN_CODES.has(r.code);
  const obs: VpsObs = {
    now,
    down: results.filter(isDown).map(({ name, code }) => ({ name, code })),
    up: results.filter((r) => !isDown(r)).map((r) => r.name),
    hbAge: hbSeen ? now - (hb!.received as number) : null,
    hbDisabled: hbSeen && hb!.disabled === true,
    cfIndicator: null,
    contaboStatus: undefined,
    autoRestart: env.AUTO_RESTART === 'on' && hasContaboSecrets(env),
  };

  let d = decide(prev, obs);
  if (d.needContaboStatus) {
    // Second phase: only now (a power decision is pending) touch Contabo/CF.
    const [cf, st] = await Promise.all([
      cloudflareIndicator(),
      contaboStatus(env).then(
        (status) => ({ status, error: undefined as string | undefined }),
        (e) => ({ status: null, error: shortError(e) }),
      ),
    ]);
    d = decide(prev, { ...obs, cfIndicator: cf, contaboStatus: st.status, contaboError: st.error });
  }

  const changed = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);
  const messages = [...d.messages];
  let next = d.next;
  if (d.contaboAction) {
    // Never forget our own shutdown: the new step (and the recorded cycle) go
    // to KV BEFORE the Contabo POST, and if that write fails nothing is sent
    // (the next tick recomputes the same decision from the unchanged state).
    if (changed(d.next, prev)) await env.STATE.put('vps', JSON.stringify(d.next));
    try {
      await contaboPower(env, d.contaboAction);
      messages.push(...d.actionMessages);
    } catch (e) {
      const failed = actionFailed(prev, d.next, d.contaboAction, shortError(e), actionOutcome(e));
      next = failed.next;
      messages.push(...failed.messages);
    }
    if (changed(next, d.next)) {
      try {
        await env.STATE.put('vps', JSON.stringify(next));
      } catch (e) {
        // Do not lose the failure announcement because the revert write failed.
        console.error('vpsWatch: could not persist state after a Contabo failure', e);
        messages.push('⚠️ No pude guardar el estado tras el fallo de Contabo; el próximo tick puede confundirse.');
      }
    }
  } else if (changed(next, prev)) {
    // Only on change (KV write budget); persist before announcing.
    await env.STATE.put('vps', JSON.stringify(next));
  }
  for (const m of messages) {
    try {
      if (!(await sendTelegram(env, m))) console.error('vpsWatch: telegram rejected a message');
    } catch (e) {
      console.error('vpsWatch: telegram send failed', e);
    }
  }
}

// Consecutive vpsWatch() crashes, kept in KV so a permanently broken watcher
// is not silent: one alert at WATCH_ERR_ALERT_AT failures, one on recovery.
const WATCH_ERR_KEY = 'watch_err';
const WATCH_ERR_ALERT_AT = 3;
interface WatchErr { n: number; since: number; alerted: boolean }

async function trySend(env: Env, text: string): Promise<boolean> {
  try {
    return await sendTelegram(env, text);
  } catch (e) {
    console.error('telegram send failed', e);
    return false;
  }
}

const watchErrText = (env: Env, since: number, e: unknown): string => {
  const name = e instanceof Error ? e.name : 'Error';
  let msg = e instanceof Error ? e.message : String(e);
  if (env.TELEGRAM_BOT_TOKEN) msg = msg.split(env.TELEGRAM_BOT_TOKEN).join('***');
  return `\u26A0\uFE0F El vigilante externo (yammbo-alerts) falla desde ${hhmm(since)}: ${esc(name)}: ${esc(msg.slice(0, 120))}`;
};

/** Runs vpsWatch and tracks consecutive failures; never throws. */
async function guardedVpsWatch(env: Env): Promise<void> {
  try {
    await vpsWatch(env);
  } catch (e) {
    console.error('vpsWatch failed', e);
    let sent = false;
    try {
      const cur = await env.STATE.get<WatchErr>(WATCH_ERR_KEY, 'json');
      const st: WatchErr = { n: (cur?.n ?? 0) + 1, since: cur?.since ?? Date.now(), alerted: cur?.alerted === true };
      if (st.n >= WATCH_ERR_ALERT_AT && !st.alerted) {
        sent = await trySend(env, watchErrText(env, st.since, e));
        st.alerted = sent;
      }
      await env.STATE.put(WATCH_ERR_KEY, JSON.stringify(st));
    } catch (kvErr) {
      // KV itself is broken, so the counter cannot work: alert at most about
      // once an hour (the cron fires on even minutes, so minute 0 only).
      console.error('watch_err counter failed', kvErr);
      if (!sent && new Date().getUTCMinutes() < 2) await trySend(env, watchErrText(env, Date.now(), e));
    }
    return;
  }
  try {
    const cur = await env.STATE.get<WatchErr>(WATCH_ERR_KEY, 'json');
    if (!cur) return;
    if (cur.alerted) await trySend(env, '\u{1F7E2} El vigilante externo vuelve a funcionar.');
    await env.STATE.delete(WATCH_ERR_KEY);
  } catch (kvErr) {
    console.error('watch_err reset failed', kvErr);
  }
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

    // Heartbeat from yammbo-autofix: store it, never alert. Must run before
    // formatAlert, which turns any unknown kind into "SITE DOWN".
    if (String(body?.kind ?? '').toLowerCase() === 'heartbeat') {
      const hb = validateHeartbeat(body);
      if (!hb) return new Response('invalid heartbeat', { status: 400 });
      await env.STATE.put('hb', JSON.stringify({ received: Date.now(), ...hb }));
      return new Response(null, { status: 204 });
    }

    const text = formatAlert(body);
    const ok = await sendTelegram(env, text);
    if (!ok) return new Response('telegram send failed', { status: 502 });
    return new Response('OK', { status: 200 });
  },

  /**
   * Cron-triggered. The 2-minute cron runs the external VPS watcher; the
   * daily 08:00 UTC one is the backup dead-man switch described below.
   *
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
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (controller.cron === '*/2 * * * *') {
      await guardedVpsWatch(env);
      return;
    }
    if (controller.cron !== '0 8 * * *') {
      console.error('scheduled: unknown cron', controller.cron);
      return;
    }

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
