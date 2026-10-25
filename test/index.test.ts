import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';

const PATH = 'secret-path';

function makeEnv() {
  const puts: [string, string][] = [];
  const env = {
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHAT_ID: '1',
    ALERT_PATH: PATH,
    STATE: { put: async (k: string, v: string) => void puts.push([k, v]) },
  } as unknown as Env;
  return { env, puts };
}

const post = (path: string, body: unknown) =>
  new Request(`https://alerts.example/${path}`, { method: 'POST', body: JSON.stringify(body) });

afterEach(() => vi.unstubAllGlobals());

describe('fetch handler', () => {
  const hb = { kind: 'heartbeat', ts: 1, open: ['music'], disabled: false, host: 'vps' };

  it('valid heartbeat -> 204, stored in KV, no Telegram', async () => {
    const tg = vi.fn();
    vi.stubGlobal('fetch', tg);
    const { env, puts } = makeEnv();
    const resp = await worker.fetch(post(PATH, hb), env);
    expect(resp.status).toBe(204);
    expect(tg).not.toHaveBeenCalled();
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('hb');
    const stored = JSON.parse(puts[0][1]);
    expect(stored).toMatchObject({ disabled: false, open: ['music'], host: 'vps' });
    expect(typeof stored.received).toBe('number');
  });

  it('invalid heartbeat -> 400, nothing stored, no Telegram', async () => {
    const tg = vi.fn();
    vi.stubGlobal('fetch', tg);
    const { env, puts } = makeEnv();
    const resp = await worker.fetch(post(PATH, { ...hb, disabled: 'no' }), env);
    expect(resp.status).toBe(400);
    expect(tg).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
  });

  it('wrong path -> 404 even for a heartbeat', async () => {
    const { env, puts } = makeEnv();
    expect((await worker.fetch(post('nope', hb), env)).status).toBe(404);
    expect(puts).toEqual([]);
  });

  it('GET / is still the liveness probe', async () => {
    const { env } = makeEnv();
    const resp = await worker.fetch(new Request('https://alerts.example/'), env);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('yammbo-alerts ok');
  });

  it('other kinds still reach Telegram', async () => {
    const tg = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', tg);
    const { env, puts } = makeEnv();
    const resp = await worker.fetch(post(PATH, { kind: 'backup', site: 's', status: 'OK' }), env);
    expect(resp.status).toBe(200);
    expect(tg).toHaveBeenCalledOnce();
    expect(puts).toEqual([]);
  });
});
