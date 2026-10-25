/**
 * Pure logic of the external VPS watcher (no I/O, unit-tested in test/).
 *
 * The Worker (src/index.ts vpsWatch) gathers observations every 2 minutes and
 * feeds them to decide(), which returns the next persisted state, the
 * Telegram messages to send and (rarely) a Contabo power action to perform.
 * The Worker has no alert dedup of its own: "once per state change" comes
 * entirely from the state machine below.
 */

/** Tunables, in ms. Passed to decide() so tests can override them. */
export const VPS_CFG = {
  minDownSites: 3, // sites down at once to call it "the VPS is down"
  confirmTicks: 2, // consecutive ticks vpsDown must hold before alerting
  hbDownMs: 6 * 60_000, // heartbeat older than this = on-VPS watcher not reporting
  hbFreshMs: 4 * 60_000, // heartbeat younger than this = fresh (recovery)
  hbSilentMs: 10 * 60_000, // heartbeat older than this with sites up = watcher silent
  downBeforeActionMs: 10 * 60_000, // vpsDown must last this long before any power action
  shutdownGraceMs: 4 * 60_000, // ACPI shutdown not done after this -> forced restart
  giveUpMs: 15 * 60_000, // start/restart sent and still down after this -> give up
  minCycleGapMs: 6 * 3_600_000, // brake: min gap between cycles
  maxCycles24h: 2, // brake: max cycles in 24 h
  maxFailsPerStep: 3, // Contabo failures in one step before giving up
};
export type VpsConfig = typeof VPS_CFG;

const DAY_MS = 24 * 3_600_000;

export type CycleStep = 'idle' | 'shutdown_sent' | 'start_sent' | 'restart_sent' | 'gave_up';
/** The only power actions that exist anywhere in the code. */
export type PowerAction = 'shutdown' | 'start' | 'restart';
/** Result of a failed Contabo POST: refused for sure, or maybe executed. */
export type ActionOutcome = 'not_done' | 'unknown';

export interface VpsState {
  downSince: number | null; // first tick of the current vpsDown episode
  downTicks: number; // consecutive ticks vpsDown held (capped at confirmTicks)
  upTicks: number; // consecutive ticks with the sites back during an alerted episode
  downAlerted: boolean; // "VPS no responde" already sent for this episode
  silentAlerted: boolean; // "vigilante sin señales" already sent
  cycle: { step: CycleStep; stepAt: number; fails: number }; // stepAt = last action time
  cycles: number[]; // start timestamps of power cycles (last 24 h), for the brakes
  notes: string[]; // once-per-episode message keys already sent
}

export interface VpsObs {
  now: number;
  down: { name: string; code: number | null }[]; // code null = fetch threw / timed out
  up: string[];
  hbAge: number | null; // ms since last heartbeat, null = never received
  hbDisabled: boolean; // autofix kill-switch reported by the heartbeat
  cfIndicator: string | null; // cloudflarestatus indicator, null = unknown/failed
  /** undefined = not fetched yet; null = fetch failed / instance not found. */
  contaboStatus?: string | null;
  contaboError?: string;
  autoRestart: boolean; // AUTO_RESTART=on AND all Contabo secrets present
}

export interface VpsDecision {
  next: VpsState;
  /** Always sent. */
  messages: string[];
  /** Announce `contaboAction`; sent only if the Contabo POST succeeded. */
  actionMessages: string[];
  contaboAction: PowerAction | null;
  /** Re-run decide() with obs.contaboStatus (+ cfIndicator) filled in. */
  needContaboStatus: boolean;
}

export const initialVpsState = (): VpsState => ({
  downSince: null,
  downTicks: 0,
  upTicks: 0,
  downAlerted: false,
  silentAlerted: false,
  cycle: { step: 'idle', stepAt: 0, fails: 0 },
  cycles: [],
  notes: [],
});

/** Tolerant parse of the persisted KV value; anything odd -> fresh state. */
export function parseVpsState(raw: unknown): VpsState {
  const base = initialVpsState();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<VpsState>;
  return {
    downSince: typeof r.downSince === 'number' ? r.downSince : null,
    downTicks: typeof r.downTicks === 'number' ? r.downTicks : 0,
    upTicks: typeof r.upTicks === 'number' ? r.upTicks : 0,
    downAlerted: r.downAlerted === true,
    silentAlerted: r.silentAlerted === true,
    cycle: {
      step: (['idle', 'shutdown_sent', 'start_sent', 'restart_sent', 'gave_up'] as string[]).includes(r.cycle?.step as string)
        ? (r.cycle!.step as CycleStep)
        : 'idle',
      stepAt: typeof r.cycle?.stepAt === 'number' ? r.cycle.stepAt : 0,
      fails: typeof r.cycle?.fails === 'number' ? r.cycle.fails : 0,
    },
    cycles: Array.isArray(r.cycles) ? r.cycles.filter((t) => typeof t === 'number') : [],
    notes: Array.isArray(r.notes) ? r.notes.filter((t) => typeof t === 'string') : [],
  };
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HH:MM in Europe/Madrid. */
export function hhmm(ts: number): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ts);
}

const mins = (ms: number): number => Math.max(0, Math.round(ms / 60_000));

const clone = (s: VpsState): VpsState => JSON.parse(JSON.stringify(s)) as VpsState;

/** Pushes `msg` only the first time `key` is seen in this episode. */
function once(s: VpsState, key: string, msg: string, out: string[]): void {
  if (s.notes.includes(key)) return;
  s.notes.push(key);
  out.push(msg);
}

/**
 * Counts one Contabo failure in the current step: announces the first one
 * (`firstMsg`) and, after maxFailsPerStep, gives up (no more actions until
 * the episode closes).
 */
function contaboFailure(s: VpsState, firstMsg: string, out: string[], cfg: VpsConfig): void {
  s.cycle.fails += 1;
  if (s.cycle.fails === 1) out.push(firstMsg);
  if (s.cycle.fails >= cfg.maxFailsPerStep) {
    s.cycle.step = 'gave_up';
    out.push('⛔ Contabo falla de forma repetida. No hago nada más: mira la consola VNC/panel de Contabo.');
  }
}

const couldNotTalk = (err: string): string => `⚠️ No pude hablar con Contabo: ${esc(err)}`;

/**
 * Called by the Worker when the Contabo POST announced by decide() failed.
 *  - "not_done" (auth/list failure, or a clear 4xx): the order was refused, so
 *    the step does NOT advance (retry next tick) and the cycle is not recorded
 *    against the brakes.
 *  - "unknown" (timeout, network error, 5xx): the order may well have been
 *    executed. The step stays as sent (a later "stopped" must still lead to
 *    "start" - we must never forget our own shutdown) and it counts as one
 *    failure towards maxFailsPerStep.
 */
export function actionFailed(
  prev: VpsState,
  decided: VpsState,
  action: PowerAction,
  err: string,
  outcome: ActionOutcome = 'not_done',
  cfg: VpsConfig = VPS_CFG,
): { next: VpsState; messages: string[] } {
  const next = clone(decided);
  const messages: string[] = [];
  if (outcome === 'unknown') {
    contaboFailure(
      next,
      `⚠️ Contabo no confirmó la orden de ${action} (${esc(err)}); la doy por enviada y compruebo el estado.`,
      messages,
      cfg,
    );
    return { next, messages };
  }
  next.cycle = { ...prev.cycle };
  if (action === 'shutdown') next.cycles = next.cycles.slice(0, -1); // the cycle we just recorded
  contaboFailure(next, couldNotTalk(err), messages, cfg);
  return { next, messages };
}

export function decide(prev: VpsState, obs: VpsObs, cfg: VpsConfig = VPS_CFG): VpsDecision {
  const next = clone(prev);
  const messages: string[] = [];
  const actionMessages: string[] = [];
  let contaboAction: PowerAction | null = null;
  let needContaboStatus = false;

  const { now, down, hbAge } = obs;
  const sitesUp = down.length <= 1;
  const hbStale = hbAge === null || hbAge >= cfg.hbDownMs;
  // The heartbeat only matters to DECLARE the VPS down. Recovery is judged on
  // the sites alone: a booted VPS whose autofix is dead is covered by the
  // "watcher silent" alert below, and must not keep an episode open forever.
  const vpsDown = down.length >= cfg.minDownSites && hbStale;
  next.cycles = next.cycles.filter((t) => now - t < DAY_MS);

  // --- Down episode: alert after confirmTicks consecutive ticks.
  if (vpsDown) {
    if (next.downSince === null) {
      next.downSince = now;
      next.downTicks = 0;
    }
    next.downTicks = Math.min(next.downTicks + 1, cfg.confirmTicks);
    next.upTicks = 0;
    if (next.downTicks >= cfg.confirmTicks && !next.downAlerted) {
      const list = down.map((d) => `${d.name} ${d.code ?? 'sin respuesta'}`).join(', ');
      const hb = hbAge === null ? 'Sin latidos del vigilante registrados.' : `Último latido del vigilante hace ${mins(hbAge)} min.`;
      const suffix = !obs.autoRestart
        ? ' (reinicio automático desactivado)'
        : obs.hbDisabled
          ? ' (autofix desactivado con el interruptor: no reinicio)'
          : '';
      messages.push(`🔴 VPS no responde desde ${hhmm(next.downSince)} (Europe/Madrid): ${esc(list)}. ${hb}${suffix}`);
      next.downAlerted = true;
    }
  } else if (next.downSince !== null) {
    if (!next.downAlerted) {
      // Not alerted yet and the condition lapsed: it was a blip, not consecutive.
      next.downSince = null;
      next.downTicks = 0;
      next.upTicks = 0;
    } else {
      // Alerted: the episode stays open until the sites are back on
      // confirmTicks consecutive ticks (closed at the end of this function).
      next.upTicks = sitesUp ? Math.min(next.upTicks + 1, cfg.confirmTicks) : 0;
    }
  }

  // --- On-VPS watcher silent while the sites respond.
  const watcherSilent = !vpsDown && sitesUp && hbAge !== null && hbAge >= cfg.hbSilentMs;
  if (watcherSilent && !next.silentAlerted) {
    messages.push(`🟠 El vigilante del VPS (yammbo-autofix) no da señales desde ${hhmm(now - hbAge!)}; los sitios responden.`);
    next.silentAlerted = true;
  } else if (next.silentAlerted && hbAge !== null && hbAge < cfg.hbFreshMs) {
    messages.push('🟢 El vigilante vuelve a dar señales.');
    next.silentAlerted = false;
  }

  // --- Power cycle (only while a down episode is open).
  if (next.downSince !== null) {
    const step = next.cycle.step;
    const statusPending = obs.contaboStatus === undefined && !obs.contaboError;
    const statusFailed = !statusPending && (!!obs.contaboError || obs.contaboStatus === null);
    const statusErr = obs.contaboError ?? 'estado no disponible';
    const status = (obs.contaboStatus ?? '').toLowerCase();

    if (step === 'shutdown_sent') {
      // Site recovery does NOT close the cycle here: we asked for a shutdown
      // and must see it through (or explicitly cancel it).
      if (!obs.autoRestart) {
        // Switched off (or secrets gone) mid-cycle: we cannot continue.
        once(next, 'abandoned', '⏸️ AUTO_RESTART está en off a mitad de un reinicio: no sigo. Mira el panel de Contabo.', messages);
        next.cycle.step = 'gave_up';
      } else if (statusPending) {
        needContaboStatus = true;
      } else if (statusFailed) {
        contaboFailure(next, couldNotTalk(statusErr), messages, cfg);
      } else if (status === 'stopped') {
        contaboAction = 'start';
        next.cycle = { step: 'start_sent', stepAt: now, fails: 0 };
        actionMessages.push('▶️ Apagado limpio hecho; lo enciendo.');
      } else if (now - next.cycle.stepAt >= cfg.shutdownGraceMs) {
        if (sitesUp) {
          // Still running and answering: it recovered by itself. No hard restart.
          messages.push('↩️ El VPS volvió a responder solo antes de apagarse; cancelo el reinicio.');
          next.cycle = { step: 'idle', stepAt: 0, fails: 0 };
        } else {
          contaboAction = 'restart';
          next.cycle = { step: 'restart_sent', stepAt: now, fails: 0 };
          actionMessages.push(`⚡ No se apagó limpio en ${mins(cfg.shutdownGraceMs)} min: reinicio forzado (el disco no se toca).`);
        }
      } else {
        next.cycle.fails = 0; // status read fine, just waiting
      }
    } else if (step === 'start_sent' || step === 'restart_sent') {
      // Nothing to call: just wait for the sites. If they are answering, the
      // episode closes below instead of giving up.
      if (!sitesUp && now - next.cycle.stepAt >= cfg.giveUpMs) {
        messages.push('⛔ Sigue caído tras el reinicio. No hago nada más: mira la consola VNC/panel de Contabo.');
        next.cycle.step = 'gave_up';
      }
    } else if (
      step === 'idle' &&
      vpsDown &&
      next.downAlerted &&
      obs.autoRestart &&
      !obs.hbDisabled &&
      now - next.downSince >= cfg.downBeforeActionMs
    ) {
      const last = next.cycles.length ? Math.max(...next.cycles) : 0;
      const braked = next.cycles.length >= cfg.maxCycles24h || (last > 0 && now - last < cfg.minCycleGapMs);
      // Invariant: from idle, a Contabo "stopped" NEVER leads to a start (the
      // owner may have powered it off). Our own late-ACPI shutdown is handled
      // by staying in shutdown_sent, not here.
      if (braked) {
        once(next, 'brake', '⏸️ Freno: ya reinicié el VPS hace poco; solo aviso.', messages);
      } else if (statusPending) {
        needContaboStatus = true;
      } else if (obs.cfIndicator === 'major' || obs.cfIndicator === 'critical') {
        once(next, 'cf', `⏸️ Cloudflare tiene una incidencia (${esc(obs.cfIndicator)}): no reinicio.`, messages);
      } else if (statusFailed) {
        contaboFailure(next, couldNotTalk(statusErr), messages, cfg);
      } else if (status === 'running') {
        contaboAction = 'shutdown';
        next.cycle = { step: 'shutdown_sent', stepAt: now, fails: 0 };
        next.cycles.push(now);
        actionMessages.push('🔁 Contabo dice que el VPS está encendido pero no responde: envío apagado limpio (ACPI).');
      } else if (status === 'stopped') {
        once(next, 'stopped', '⛔ El VPS está APAGADO en Contabo: no lo enciendo yo (¿lo apagaste tú?).', messages);
      } else {
        once(next, `status:${status}`, `⛔ El VPS está en estado «${esc(status)}» en Contabo: no hago nada.`, messages);
      }
    }
  }

  // --- Close the episode: sites back on confirmTicks consecutive ticks. Not
  // while our shutdown is still pending (see above).
  if (next.downSince !== null && next.downAlerted && next.upTicks >= cfg.confirmTicks && next.cycle.step !== 'shutdown_sent') {
    const afterCycle = next.cycle.step === 'start_sent' || next.cycle.step === 'restart_sent';
    messages.push(`🟢 VPS responde de nuevo${afterCycle ? ' tras reiniciarlo' : ''} (caído ${mins(now - next.downSince)} min).`);
    next.downSince = null;
    next.downTicks = 0;
    next.upTicks = 0;
    next.downAlerted = false;
    next.notes = [];
    next.cycle = { step: 'idle', stepAt: 0, fails: 0 };
  }

  return { next, messages, actionMessages, contaboAction, needContaboStatus };
}

// --- Heartbeat payload (POST /<ALERT_PATH>, kind "heartbeat") ---------------

export interface Heartbeat {
  disabled: boolean;
  open: string[];
  host: string;
}

/** Returns the sanitized heartbeat, or null if the payload is invalid. */
export function validateHeartbeat(b: unknown): Heartbeat | null {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  if (typeof o.ts !== 'number' || !Number.isFinite(o.ts)) return null;
  if (typeof o.disabled !== 'boolean') return null;
  if (typeof o.host !== 'string' || o.host.length > 100) return null;
  if (!Array.isArray(o.open) || o.open.length > 50) return null;
  if (!o.open.every((s) => typeof s === 'string' && s.length <= 100)) return null;
  return { disabled: o.disabled, open: o.open as string[], host: o.host };
}
