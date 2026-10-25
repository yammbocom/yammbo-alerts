/**
 * Minimal Contabo API client for the VPS watcher.
 *
 * SAFETY: the ONLY calls that exist here are
 *   - POST  auth.contabo.com/.../token                (OAuth password grant)
 *   - GET   /v1/compute/instances                     (read status)
 *   - POST  /v1/compute/instances/{id}/actions/{shutdown|start|restart}
 * Never add reinstall / cancel / stop / rescue / PUT / PATCH / DELETE. The
 * action function only accepts the PowerAction union and re-checks it at
 * runtime. Error strings carry the HTTP status and a short message only,
 * never tokens or secrets.
 */

import type { ActionOutcome, PowerAction } from './vps';

export interface ContaboEnv {
  VPS_IP: string;
  CONTABO_CLIENT_ID?: string;
  CONTABO_CLIENT_SECRET?: string;
  CONTABO_API_USER?: string;
  CONTABO_API_PASSWORD?: string;
}

const AUTH_URL = 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token';
const API_BASE = 'https://api.contabo.com';
const ALLOWED_ACTIONS: readonly string[] = ['shutdown', 'start', 'restart'];
const TIMEOUT_MS = 15_000;

/**
 * Error whose message is already safe to show (status + short text).
 * `outcome` matters only for the final action POST: "unknown" means the order
 * may have been executed (timeout, network error, 5xx); everything else is
 * "not_done" (nothing was sent, or Contabo clearly refused it with a 4xx).
 */
export class ContaboError extends Error {
  constructor(
    message: string,
    readonly outcome: ActionOutcome = 'not_done',
  ) {
    super(message);
  }
}

export const actionOutcome = (e: unknown): ActionOutcome => (e instanceof ContaboError ? e.outcome : 'not_done');

export const hasContaboSecrets = (env: ContaboEnv): boolean =>
  !!(env.CONTABO_CLIENT_ID && env.CONTABO_CLIENT_SECRET && env.CONTABO_API_USER && env.CONTABO_API_PASSWORD);

/** Short, secret-free description of anything thrown by this module. */
export function shortError(e: unknown): string {
  if (e instanceof ContaboError) return e.message;
  return e instanceof Error ? e.name : 'error';
}

async function apiMessage(resp: Response): Promise<string> {
  try {
    const j = (await resp.json()) as { message?: unknown };
    return typeof j.message === 'string' ? ` ${j.message.slice(0, 100)}` : '';
  } catch {
    return '';
  }
}

async function getToken(env: ContaboEnv): Promise<string> {
  const resp = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: env.CONTABO_CLIENT_ID ?? '',
      client_secret: env.CONTABO_CLIENT_SECRET ?? '',
      username: env.CONTABO_API_USER ?? '',
      password: env.CONTABO_API_PASSWORD ?? '',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new ContaboError(`auth HTTP ${resp.status}`);
  const j = (await resp.json()) as { access_token?: unknown };
  if (typeof j.access_token !== 'string' || !j.access_token) throw new ContaboError('auth: no token');
  return j.access_token;
}

function headers(token: string, json = false): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'x-request-id': crypto.randomUUID(),
  };
  if (json) h['content-type'] = 'application/json';
  return h;
}

/** The instance whose primary IPv4 is env.VPS_IP, or null if none matches. */
async function findInstance(env: ContaboEnv, token: string): Promise<{ id: string; status: string } | null> {
  const resp = await fetch(`${API_BASE}/v1/compute/instances?size=100`, {
    headers: headers(token),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) throw new ContaboError(`list HTTP ${resp.status}${await apiMessage(resp)}`);
  const j = (await resp.json()) as {
    data?: { instanceId?: unknown; status?: unknown; ipConfig?: { v4?: { ip?: unknown } } }[];
  };
  const inst = (j.data ?? []).find((i) => i.ipConfig?.v4?.ip === env.VPS_IP);
  if (!inst || inst.instanceId === undefined) return null;
  return { id: String(inst.instanceId), status: String(inst.status ?? '') };
}

/** Contabo status string of the VPS ("running", "stopped", ...). */
export async function contaboStatus(env: ContaboEnv): Promise<string> {
  const token = await getToken(env);
  const inst = await findInstance(env, token);
  if (!inst) throw new ContaboError('instancia no encontrada por IP');
  return inst.status;
}

/** Sends one power action to the VPS instance. Throws ContaboError on failure. */
export async function contaboPower(env: ContaboEnv, action: PowerAction): Promise<void> {
  if (!ALLOWED_ACTIONS.includes(action)) throw new ContaboError(`acción no permitida: ${String(action)}`);
  const token = await getToken(env);
  const inst = await findInstance(env, token);
  if (!inst) throw new ContaboError('instancia no encontrada por IP');
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}/v1/compute/instances/${encodeURIComponent(inst.id)}/actions/${action}`, {
      method: 'POST',
      headers: headers(token, true),
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // The request may have reached Contabo: we cannot tell if it was executed.
    throw new ContaboError(`${action}: ${e instanceof Error ? e.name : 'error'}`, 'unknown');
  }
  if (!resp.ok) {
    throw new ContaboError(
      `${action} HTTP ${resp.status}${await apiMessage(resp)}`,
      resp.status >= 400 && resp.status < 500 ? 'not_done' : 'unknown',
    );
  }
}

/** Cloudflare status indicator ("none"|"minor"|"major"|"critical"), null on any failure. */
export async function cloudflareIndicator(): Promise<string | null> {
  try {
    const resp = await fetch('https://www.cloudflarestatus.com/api/v2/status.json', {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const j = (await resp.json()) as { status?: { indicator?: unknown } };
    return typeof j.status?.indicator === 'string' ? j.status.indicator : null;
  } catch {
    return null;
  }
}
