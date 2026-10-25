import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { initialVpsState, type VpsState } from '../src/vps';

const MIN = 60_000;
const CRON_WATCH = '*/2 * * * *';
const CRON_BACKUP = '0 8 * * *';

/** In-memory KV that logs into the shared `events` list, with failure switches. */
class MemKV {
  data = new Map<string, string>();
  failGet = new Set<string>();
  failPut = new Set<string>();
  failAll = false;
  constructor(private events: string[]) {}
  async get(key: string, type?: string): Promise<unknown> {
    if (this.failAll || this.failGet.has(key)) throw new Error('kv down');
    const v = this.data.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key: string, value: string): Promise<void> {
    if (this.failAll || this.failPut.has(key)) throw new Error('kv down');
    this.events.push(`kv.put:${key}`);
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    if (this.failAll) throw new Error('kv down');
    this.events.push(`kv.delete:${key}`);
    this.data.delete(key);
  }
  json<T>(key: string): T | null {
    const v = this.data.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
}

interface World {
  events: string[];
  kv: MemKV;
  env: Env;
  telegram: string[];
  telegramInits: RequestInit[];
  fetched: string[];
  probe: Record<string, number | 'throw'>; // by hostname prefix: music/tv/web/app
  cf: string;
  contabo: { status: string; post: 'ok' | number | 'throw' };
  backupList: ReturnType<typeof vi.fn>;
}

function makeWorld(over: Partial<Env> = {}): World {
  const events: string[] = [];
  const kv = new MemKV(events);
  const backupList = vi.fn(async () => ({ objects: [{ uploaded: new Date() }], truncated: false }));
  const w: World = {
    events,
    kv,
    telegram: [],
    telegramInits: [],
    fetched: [],
    probe: { music: 200, tv: 200, web: 200, app: 200 },
    cf: 'none',
    contabo: { status: 'running', post: 'ok' },
    backupList,
    env: {
      TELEGRAM_BOT_TOKEN: 'tg-token',
      TELEGRAM_CHAT_ID: '1',
      ALERT_PATH: 'p',
      BACKUPS: { list: backupList } as unknown as R2Bucket,
      STATE: kv as unknown as KVNamespace,
      VPS_IP: '203.0.113.9',
      AUTO_RESTART: 'on',
      CONTABO_CLIENT_ID: 'a',
      CONTABO_CLIENT_SECRET: 'b',
      CONTABO_API_USER: 'c',
      CONTABO_API_PASSWORD: 'd',
      ...over,
    },
  };
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    if (url.hostname === 'api.telegram.org') {
      w.telegram.push((JSON.parse(String(init?.body)) as { text: string }).text);
      w.telegramInits.push(init ?? {});
      return new Response('{}', { status: 200 });
    }
    if (url.hostname.endsWith('.yammbo.com')) {
      w.fetched.push(url.toString());
      const r = w.probe[url.hostname.split('.')[0]];
      if (r === 'throw') throw new DOMException('timed out', 'TimeoutError');
      return new Response('x', { status: r });
    }
    if (url.hostname === 'www.cloudflarestatus.com') {
      events.push('GET cloudflarestatus');
      return Response.json({ status: { indicator: w.cf } });
    }
    if (url.hostname === 'auth.contabo.com') return Response.json({ access_token: 'tok' });
    if (url.hostname === 'api.contabo.com') {
      if (method === 'GET') {
        events.push('GET contabo instances');
        return Response.json({ data: [{ instanceId: 77, status: w.contabo.status, ipConfig: { v4: { ip: '203.0.113.9' } } }] });
      }
      const action = url.pathname.split('/').pop();
      events.push(`POST contabo ${action}`);
      w.fetched.push(`${method} ${url.pathname} ${String(init?.body)} ${JSON.stringify(init?.headers)}`);
      if (w.contabo.post === 'throw') throw new DOMException('timed out', 'TimeoutError');
      if (w.contabo.post === 'ok') return new Response('{}', { status: 201 });
      return new Response('{"message":"nope"}', { status: w.contabo.post });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  });
  return w;
}

const run = (w: World, cron: string) =>
  worker.scheduled!({ cron, scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledController, w.env, {} as ExecutionContext);

/** Seed: alerted outage lasting 12 min, stale heartbeat, ready to power-cycle. */
function seedDown(w: World, over: Partial<VpsState> = {}): VpsState {
  const st: VpsState = { ...initialVpsState(), downSince: Date.now() - 12 * MIN, downTicks: 2, downAlerted: true, ...over };
  w.kv.data.set('vps', JSON.stringify(st));
  w.kv.data.set('hb', JSON.stringify({ received: Date.now() - 12 * MIN, disabled: false, open: [], host: 'v' }));
  w.probe = { music: 522, tv: 522, web: 522, app: 522 };
  return st;
}

beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scheduled(): cron branch selection', () => {
  it('"*/2 * * * *" runs the VPS watcher (4 probes with cache-buster), not the backup check', async () => {
    const w = makeWorld();
    await run(w, CRON_WATCH);
    expect(w.backupList).not.toHaveBeenCalled();
    expect(w.fetched).toHaveLength(4);
    for (const u of w.fetched) expect(u).toMatch(/^https:\/\/(music|tv|web|app)\.yammbo\.com\/.*[?&]vpscheck=\d+/);
    expect(w.fetched.find((u) => u.includes('tv.yammbo.com'))).toContain('/api/app-tv/version-movil?vpscheck=');
  });

  it('"0 8 * * *" still runs the backup check and not the probes', async () => {
    const w = makeWorld();
    await run(w, CRON_BACKUP);
    expect(w.backupList).toHaveBeenCalledTimes(6);
    expect(w.fetched).toEqual([]);
    expect(w.telegram).toEqual([]); // all fresh: silent
  });

  it('"0 8 * * *" with a missing prefix alerts once', async () => {
    const w = makeWorld();
    w.backupList.mockResolvedValue({ objects: [], truncated: false });
    await run(w, CRON_BACKUP);
    expect(w.telegram).toHaveLength(1);
    expect(w.telegram[0]).toContain('BACKUP DEAD-MAN SWITCH');
  });

  it('unknown cron does nothing', async () => {
    const w = makeWorld();
    await run(w, '5 5 * * *');
    expect(w.backupList).not.toHaveBeenCalled();
    expect(w.fetched).toEqual([]);
    expect(w.telegram).toEqual([]);
  });
});

describe('vpsWatch I/O', () => {
  it('healthy ticks write nothing to KV (put only on change)', async () => {
    const w = makeWorld();
    w.kv.data.set('hb', JSON.stringify({ received: Date.now() - 20_000, disabled: false, open: [], host: 'v' }));
    await run(w, CRON_WATCH);
    await run(w, CRON_WATCH);
    expect(w.events.filter((e) => e.startsWith('kv.'))).toEqual([]);
    expect(w.telegram).toEqual([]);
  });

  it('403 challenge / 500 are UP; only 52x and throws are DOWN', async () => {
    const w = makeWorld();
    w.probe = { music: 403, tv: 500, web: 522, app: 'throw' };
    w.kv.data.set('hb', JSON.stringify({ received: Date.now() - 20 * MIN, disabled: false, open: [], host: 'v' }));
    await run(w, CRON_WATCH);
    expect(w.kv.json<VpsState>('vps')).toBeNull(); // only 2 down -> no episode, nothing written
    w.probe = { music: 522, tv: 530, web: 'throw', app: 200 };
    await run(w, CRON_WATCH);
    expect(w.kv.json<VpsState>('vps')?.downTicks).toBe(1);
  });

  it('two-phase: Contabo/CF only queried when needed, state saved BEFORE the shutdown POST', async () => {
    const w = makeWorld();
    seedDown(w);
    await run(w, CRON_WATCH);
    const i = (e: string) => w.events.indexOf(e);
    expect(i('GET contabo instances')).toBeGreaterThanOrEqual(0);
    expect(i('GET cloudflarestatus')).toBeGreaterThanOrEqual(0);
    expect(i('kv.put:vps')).toBeGreaterThan(i('GET contabo instances'));
    expect(i('POST contabo shutdown')).toBeGreaterThan(i('kv.put:vps'));
    expect(w.events.filter((e) => e === 'kv.put:vps')).toHaveLength(1); // success: no second write
    const post = w.fetched.find((f) => f.startsWith('POST /v1/compute/instances/77/actions/shutdown'))!;
    expect(post).toContain(' {} ');
    expect(post).toContain('Bearer tok');
    expect(post).toContain('x-request-id');
    const st = w.kv.json<VpsState>('vps')!;
    expect(st.cycle.step).toBe('shutdown_sent');
    expect(st.cycles).toHaveLength(1);
    expect(w.telegram).toEqual(['🔁 Contabo dice que el VPS está encendido pero no responde: envío apagado limpio (ACPI).']);
  });

  it('no Contabo/CF call while the outage is younger than 10 min', async () => {
    const w = makeWorld();
    seedDown(w, { downSince: Date.now() - 5 * MIN });
    await run(w, CRON_WATCH);
    expect(w.events.filter((e) => e.startsWith('GET') || e.startsWith('POST'))).toEqual([]);
  });

  it('AUTO_RESTART off: never touches Contabo even when the outage is old', async () => {
    const w = makeWorld({ AUTO_RESTART: 'off' });
    seedDown(w);
    await run(w, CRON_WATCH);
    expect(w.events.filter((e) => e.includes('contabo'))).toEqual([]);
  });

  it('missing Contabo secrets: never touches Contabo', async () => {
    const w = makeWorld({ CONTABO_API_PASSWORD: undefined });
    seedDown(w);
    await run(w, CRON_WATCH);
    expect(w.events.filter((e) => e.includes('contabo'))).toEqual([]);
  });

  it('if the KV write before the POST fails, NO POST is sent and the tick is counted as failed', async () => {
    const w = makeWorld();
    seedDown(w);
    w.kv.failPut.add('vps');
    await run(w, CRON_WATCH);
    expect(w.events).not.toContain('POST contabo shutdown');
    expect(w.telegram).toEqual([]);
    expect(w.kv.json<{ n: number }>('watch_err')?.n).toBe(1);
  });

  it('POST 403 (clear refusal): step reverted and cycle un-recorded in KV', async () => {
    const w = makeWorld();
    seedDown(w);
    w.contabo.post = 403;
    await run(w, CRON_WATCH);
    const st = w.kv.json<VpsState>('vps')!;
    expect(st.cycle.step).toBe('idle');
    expect(st.cycles).toEqual([]);
    expect(st.cycle.fails).toBe(1);
    expect(w.events.filter((e) => e === 'kv.put:vps')).toHaveLength(2); // before + revert
    expect(w.telegram).toHaveLength(1);
    expect(w.telegram[0]).toMatch(/^⚠️ No pude hablar con Contabo: shutdown HTTP 403/);
  });

  it('POST refused and the revert write fails: failure messages are still sent, plus a state-lost warning', async () => {
    const w = makeWorld();
    seedDown(w);
    w.contabo.post = 403;
    const realPut = w.kv.put.bind(w.kv);
    let vpsPuts = 0;
    vi.spyOn(w.kv, 'put').mockImplementation(async (key: string, value: string) => {
      if (key === 'vps' && ++vpsPuts === 2) throw new Error('kv down');
      return realPut(key, value);
    });
    await run(w, CRON_WATCH);
    expect(w.events).toContain('POST contabo shutdown');
    expect(w.telegram).toHaveLength(2);
    expect(w.telegram[0]).toMatch(/^⚠️ No pude hablar con Contabo: shutdown HTTP 403/);
    expect(w.telegram[1]).toBe('⚠️ No pude guardar el estado tras el fallo de Contabo; el próximo tick puede confundirse.');
    expect(w.kv.data.has('watch_err')).toBe(false); // the tick itself did not crash
  });

  it.each([
    ['5xx', 503 as const],
    ['timeout', 'throw' as const],
  ])('POST %s (unknown outcome): step kept as shutdown_sent, cycle stays recorded', async (_n, post) => {
    const w = makeWorld();
    seedDown(w);
    w.contabo.post = post;
    await run(w, CRON_WATCH);
    const st = w.kv.json<VpsState>('vps')!;
    expect(st.cycle.step).toBe('shutdown_sent');
    expect(st.cycle.fails).toBe(1);
    expect(st.cycles).toHaveLength(1);
    expect(w.telegram).toHaveLength(1);
    expect(w.telegram[0]).toContain('Contabo no confirmó la orden de shutdown');
    // next tick: Contabo reports stopped -> start
    w.contabo = { status: 'stopped', post: 'ok' };
    await run(w, CRON_WATCH);
    expect(w.events).toContain('POST contabo start');
    expect(w.kv.json<VpsState>('vps')!.cycle.step).toBe('start_sent');
  });

  it('Telegram sends carry a timeout signal', async () => {
    const w = makeWorld();
    seedDown(w);
    await run(w, CRON_WATCH);
    expect(w.telegramInits.length).toBeGreaterThan(0);
    expect(w.telegramInits[0].signal).toBeDefined();
  });
});

describe('watcher failure counter (watch_err)', () => {
  it('alerts once after 3 consecutive failures, then once on recovery', async () => {
    const w = makeWorld();
    w.kv.failGet.add('hb'); // makes vpsWatch throw on every tick
    await run(w, CRON_WATCH);
    await run(w, CRON_WATCH);
    expect(w.telegram).toEqual([]);
    await run(w, CRON_WATCH);
    expect(w.telegram).toHaveLength(1);
    expect(w.telegram[0]).toMatch(/^⚠️ El vigilante externo \(yammbo-alerts\) falla desde \d\d:\d\d: Error: kv down$/);
    await run(w, CRON_WATCH);
    await run(w, CRON_WATCH);
    expect(w.telegram).toHaveLength(1);
    expect(w.kv.json<{ n: number; alerted: boolean }>('watch_err')).toMatchObject({ n: 5, alerted: true });

    w.kv.failGet.clear();
    await run(w, CRON_WATCH);
    expect(w.telegram).toHaveLength(2);
    expect(w.telegram[1]).toBe('🟢 El vigilante externo vuelve a funcionar.');
    expect(w.kv.data.has('watch_err')).toBe(false);
    await run(w, CRON_WATCH);
    expect(w.telegram).toHaveLength(2);
  });

  it('a failure streak that never reaches 3 does not alert, nor announce recovery', async () => {
    const w = makeWorld();
    w.kv.failGet.add('hb');
    await run(w, CRON_WATCH);
    await run(w, CRON_WATCH);
    w.kv.failGet.clear();
    await run(w, CRON_WATCH);
    expect(w.telegram).toEqual([]);
    expect(w.kv.data.has('watch_err')).toBe(false);
  });

  it('the Telegram token never appears in the failure alert', async () => {
    const w = makeWorld();
    w.kv.failGet.add('hb');
    vi.spyOn(w.kv, 'get').mockImplementation(async (key: string) => {
      if (key === 'hb') throw new Error('boom https://api.telegram.org/bottg-token/sendMessage');
      return w.kv.data.has(key) ? JSON.parse(w.kv.data.get(key)!) : null;
    });
    for (let i = 0; i < 3; i++) await run(w, CRON_WATCH);
    expect(w.telegram).toHaveLength(1);
    expect(w.telegram[0]).not.toContain('tg-token');
    expect(w.telegram[0]).toContain('***');
  });

  it('KV itself down: alert only on ticks at minute 0-1 of the hour, never every tick', async () => {
    const w = makeWorld();
    w.kv.failAll = true;
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const t of ['12:02', '12:04', '12:06', '12:58']) {
      vi.setSystemTime(new Date(`2026-10-25T${t}:00Z`));
      await run(w, CRON_WATCH);
    }
    expect(w.telegram).toEqual([]);
    vi.setSystemTime(new Date('2026-10-25T13:00:00Z'));
    await run(w, CRON_WATCH);
    expect(w.telegram).toHaveLength(1);
    expect(w.telegram[0]).toContain('El vigilante externo (yammbo-alerts) falla desde 14:00');
    vi.setSystemTime(new Date('2026-10-25T13:02:00Z'));
    await run(w, CRON_WATCH);
    expect(w.telegram).toHaveLength(1);
  });
});
