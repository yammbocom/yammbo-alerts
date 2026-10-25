import { describe, expect, it } from 'vitest';
import {
  VPS_CFG,
  actionFailed,
  decide,
  initialVpsState,
  parseVpsState,
  validateHeartbeat,
  type VpsDecision,
  type VpsObs,
  type VpsState,
} from '../src/vps';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0); // 13:00 in Europe/Madrid (CET, UTC+1: DST ended that morning)
const SITES = ['music', 'tv', 'web', 'app'];

/** Observation builder: `downN` first sites down with code 522, the rest up. */
function obs(over: Partial<VpsObs> & { downN?: number } = {}): VpsObs {
  const { downN = 0, ...rest } = over;
  return {
    now: T0,
    down: SITES.slice(0, downN).map((name) => ({ name, code: 522 })),
    up: SITES.slice(downN),
    hbAge: 30_000,
    hbDisabled: false,
    cfIndicator: 'none',
    contaboStatus: undefined,
    autoRestart: false,
    ...rest,
  };
}

/** Tiny driver: keeps state between ticks and a simulated clock. */
class Sim {
  state: VpsState = initialVpsState();
  now = T0;
  hbLast: number | null | 'live' = 'live'; // time of last heartbeat; null = never; 'live' = always 30 s old
  actions: string[] = [];
  all: string[] = [];

  tick(o: Partial<VpsObs> & { downN?: number } = {}, advance = 2 * MIN): VpsDecision {
    this.now += advance;
    const full = obs({
      ...o,
      now: this.now,
      hbAge: 'hbAge' in o ? (o.hbAge as number | null) : this.hbLast === 'live' ? 30_000 : this.hbLast === null ? null : this.now - this.hbLast,
    });
    let d = decide(this.state, full);
    if (d.needContaboStatus) {
      d = decide(this.state, { ...full, contaboStatus: o.contaboStatus ?? full.contaboStatus, cfIndicator: o.cfIndicator ?? 'none' });
    }
    this.state = d.next;
    this.all.push(...d.messages, ...d.actionMessages);
    if (d.contaboAction) this.actions.push(d.contaboAction);
    return d;
  }
}

/** Keeps the VPS down (3 sites, no fresh heartbeat) for n ticks of 2 min. */
function downFor(sim: Sim, n: number, over: Partial<VpsObs> = {}): VpsDecision {
  let d!: VpsDecision;
  for (let i = 0; i < n; i++) d = sim.tick({ downN: 3, ...over });
  return d;
}

/** Sim whose last heartbeat is 7 min old, so 3 down sites count as vpsDown. */
function staleSim(): Sim {
  const s = new Sim();
  s.hbLast = T0 - 7 * MIN;
  return s;
}

describe('VPS down / recovery alerts', () => {
  it('a single blip does not alert', () => {
    const s = staleSim();
    expect(s.tick({ downN: 3 }).messages).toEqual([]);
    expect(s.tick({ downN: 0, hbAge: 30_000 }).messages).toEqual([]);
    expect(s.state).toEqual({ ...initialVpsState(), cycles: [] });
  });

  it('non-consecutive ticks do not add up', () => {
    const s = staleSim();
    s.tick({ downN: 3 });
    s.tick({ downN: 2 }); // lapses: counter resets
    expect(s.tick({ downN: 3 }).messages).toEqual([]);
  });

  it('two consecutive ticks alert exactly once, with names, codes and time', () => {
    const s = staleSim();
    expect(s.tick({ downN: 3 }).messages).toEqual([]);
    const d = s.tick({ downN: 3 });
    expect(d.messages).toHaveLength(1);
    expect(d.messages[0]).toMatch(/^🔴 VPS no responde desde 13:0\d \(Europe\/Madrid\): music 522, tv 522, web 522\./);
    expect(d.messages[0]).toContain('Último latido del vigilante hace 11 min.');
    expect(d.messages[0]).toContain('(reinicio automático desactivado)');
    expect(downFor(s, 5).messages).toEqual([]);
  });

  it('timeouts are reported as "sin respuesta"', () => {
    const s = staleSim();
    s.tick({ down: [{ name: 'music', code: null }, { name: 'tv', code: null }, { name: 'web', code: 521 }] });
    const d = s.tick({ down: [{ name: 'music', code: null }, { name: 'tv', code: null }, { name: 'web', code: 521 }] });
    expect(d.messages[0]).toContain('music sin respuesta, tv sin respuesta, web 521');
  });

  it('no heartbeat ever + 3 down still counts as down', () => {
    const s = new Sim();
    s.hbLast = null;
    s.tick({ downN: 3 });
    const d = s.tick({ downN: 3 });
    expect(d.messages[0]).toContain('Sin latidos del vigilante registrados.');
  });

  it('a fresh heartbeat with 3 sites down is NOT vpsDown (autofix handles it)', () => {
    const s = new Sim(); // hb 30 s old
    expect(downFor(s, 6).messages).toEqual([]);
  });

  it('mentions the kill switch when autoRestart is on but hb says disabled', () => {
    const s = staleSim();
    s.tick({ downN: 3, autoRestart: true, hbDisabled: true });
    const d = s.tick({ downN: 3, autoRestart: true, hbDisabled: true });
    expect(d.messages[0]).toContain('(autofix desactivado con el interruptor: no reinicio)');
  });

  it('recovery is announced once, only after the down alert', () => {
    const s = staleSim();
    downFor(s, 2);
    expect(s.tick({ downN: 1, hbAge: 20_000 }).messages).toEqual([]); // 1st tick with sites back: not yet
    const rec = s.tick({ downN: 0, hbAge: 20_000 }); // 2nd consecutive
    expect(rec.messages).toHaveLength(1);
    expect(rec.messages[0]).toMatch(/^🟢 VPS responde de nuevo \(caído \d+ min\)\.$/);
    expect(s.tick({ downN: 0, hbAge: 20_000 }).messages).toEqual([]);
    expect(s.state.downSince).toBeNull();
  });

  it('recovers when the heartbeat was never seen', () => {
    const s = new Sim();
    s.hbLast = null;
    downFor(s, 2);
    s.tick({ downN: 0 });
    expect(s.tick({ downN: 0 }).messages.filter((m) => m.startsWith('🟢 VPS'))).toHaveLength(1);
  });

  it('S1: heartbeat stays stale after the outage: episode still closes (sites alone), and a 2nd outage alerts again', () => {
    const s = staleSim(); // hb never refreshed: age keeps growing
    downFor(s, 2);
    expect(s.state.downAlerted).toBe(true);
    s.tick({ downN: 0 });
    const rec = s.tick({ downN: 0 });
    expect(rec.messages.filter((m) => m.startsWith('🟢 VPS responde de nuevo'))).toHaveLength(1);
    expect(s.state.downSince).toBeNull();
    expect(s.state.downAlerted).toBe(false);
    // second outage, heartbeat still stale
    expect(s.tick({ downN: 3 }).messages.filter((m) => m.startsWith('🔴'))).toEqual([]);
    expect(s.tick({ downN: 3 }).messages.filter((m) => m.startsWith('🔴'))).toHaveLength(1);
  });

  it('sites back for one tick only keeps the episode open (needs 2 consecutive)', () => {
    const s = staleSim();
    downFor(s, 2);
    s.tick({ downN: 0 });
    s.tick({ downN: 3 }); // flaps down again
    expect(s.state.downAlerted).toBe(true);
    expect(s.tick({ downN: 0 }).messages.filter((m) => m.startsWith('🟢 VPS'))).toEqual([]);
    expect(s.tick({ downN: 0 }).messages.filter((m) => m.startsWith('🟢 VPS'))).toHaveLength(1);
  });

  it('two sites down with a stale heartbeat keeps the episode open without new alerts', () => {
    const s = staleSim();
    downFor(s, 2);
    for (let i = 0; i < 3; i++) expect(s.tick({ downN: 2 }).messages.filter((m) => m.startsWith('🔴') || m.startsWith('🟢 VPS'))).toEqual([]);
    expect(s.state.downAlerted).toBe(true);
  });
});

describe('watcher silent', () => {
  it('exact flow: silent -> one alert -> no repeats -> one recovery', () => {
    const s = new Sim();
    s.hbLast = T0 - 5 * MIN;
    expect(s.tick({ downN: 0 }, 2 * MIN).messages).toEqual([]); // age 7 min
    const d = s.tick({ downN: 0 }, 4 * MIN); // age 11 min
    expect(d.messages).toHaveLength(1);
    expect(d.messages[0]).toMatch(/^🟠 El vigilante del VPS \(yammbo-autofix\) no da señales desde 12:55; los sitios responden\.$/);
    expect(s.tick({ downN: 0 }).messages).toEqual([]);
    expect(s.tick({ downN: 1 }).messages).toEqual([]);
    const back = s.tick({ downN: 0, hbAge: 30_000 });
    expect(back.messages).toEqual(['🟢 El vigilante vuelve a dar señales.']);
    expect(s.tick({ downN: 0, hbAge: 30_000 }).messages).toEqual([]);
  });

  it('never having seen a heartbeat does not trigger the silent alert', () => {
    const s = new Sim();
    s.hbLast = null;
    for (let i = 0; i < 10; i++) expect(s.tick({ downN: 0 }).messages).toEqual([]);
  });

  it('is not raised while the VPS is down (that is the other alert)', () => {
    const s = new Sim();
    s.hbLast = T0 - 20 * MIN;
    s.tick({ downN: 3 });
    const d = s.tick({ downN: 3 });
    expect(d.messages).toHaveLength(1);
    expect(d.messages[0]).toContain('🔴 VPS no responde');
  });

  it('with 2 sites down and a stale heartbeat the silent alert is suppressed', () => {
    const s = new Sim();
    s.hbLast = T0 - 20 * MIN;
    expect(s.tick({ downN: 2 }).messages).toEqual([]);
  });
});

describe('power cycle', () => {
  /** Down alerted and 10 min elapsed -> next tick may act. */
  function readyToAct(s: Sim, over: Partial<VpsObs> = {}): void {
    // ticks at +2,+4,...: downSince at first tick; need now - downSince >= 10 min
    downFor(s, 5, { autoRestart: true, ...over }); // 5th tick is 8 min after the first
  }

  it('does nothing before 10 minutes of outage', () => {
    const s = staleSim();
    const d = downFor(s, 5, { autoRestart: true, contaboStatus: 'running' });
    expect(d.contaboAction).toBeNull();
    expect(d.needContaboStatus).toBe(false);
  });

  it('running -> shutdown -> stopped -> start -> recovered "tras reiniciarlo"', () => {
    const s = staleSim();
    readyToAct(s);
    // tick 6: 10 min down -> asks for the Contabo status, then shuts down
    const p1 = decide(s.state, obs({ now: s.now + 2 * MIN, downN: 3, hbAge: 9 * MIN, autoRestart: true }));
    expect(p1.needContaboStatus).toBe(true);
    expect(p1.contaboAction).toBeNull();

    const d1 = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
    expect(d1.contaboAction).toBe('shutdown');
    expect(d1.actionMessages).toEqual(['🔁 Contabo dice que el VPS está encendido pero no responde: envío apagado limpio (ACPI).']);
    expect(s.state.cycle.step).toBe('shutdown_sent');
    expect(s.state.cycles).toHaveLength(1);

    // still shutting down: wait, no action
    const d2 = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
    expect(d2.contaboAction).toBeNull();
    expect(s.state.cycle.step).toBe('shutdown_sent');

    const d3 = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' });
    expect(d3.contaboAction).toBe('start');
    expect(d3.actionMessages).toEqual(['▶️ Apagado limpio hecho; lo enciendo.']);
    expect(s.state.cycle.step).toBe('start_sent');

    expect(s.tick({ downN: 0, hbAge: 15_000, autoRestart: true }).messages).toEqual([]); // 1st tick up
    const d4 = s.tick({ downN: 0, hbAge: 15_000, autoRestart: true });
    expect(d4.messages).toHaveLength(1);
    expect(d4.messages[0]).toMatch(/^🟢 VPS responde de nuevo tras reiniciarlo \(caído \d+ min\)\.$/);
    expect(s.state.cycle.step).toBe('idle');
    expect(s.state.cycles).toHaveLength(1); // history kept for the brakes
    expect(s.actions).toEqual(['shutdown', 'start']);
  });

  it('shutdown not done after 4 min -> forced restart', () => {
    const s = staleSim();
    readyToAct(s);
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' }); // shutdown at t
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' }); // t+2
    expect(s.state.cycle.step).toBe('shutdown_sent');
    const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' }); // t+4
    expect(d.contaboAction).toBe('restart');
    expect(d.actionMessages).toEqual(['⚡ No se apagó limpio en 4 min: reinicio forzado (el disco no se toca).']);
    expect(s.state.cycle.step).toBe('restart_sent');
    expect(s.actions).toEqual(['shutdown', 'restart']);
    // recovered after restart
    s.tick({ downN: 0, hbAge: 10_000 });
    expect(s.tick({ downN: 0, hbAge: 10_000 }).messages[0]).toContain('tras reiniciarlo');
  });

  it('still down 15 min after the last action -> gave_up, then nothing more', () => {
    const s = staleSim();
    readyToAct(s);
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' }); // start at t+2
    let gaveUp: VpsDecision | undefined;
    const msgs: string[] = [];
    for (let i = 0; i < 10; i++) {
      const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' });
      msgs.push(...d.messages);
      expect(d.contaboAction).toBeNull();
      if (s.state.cycle.step === 'gave_up' && !gaveUp) gaveUp = d;
    }
    expect(gaveUp).toBeDefined();
    expect(msgs).toEqual(['⛔ Sigue caído tras el reinicio. No hago nada más: mira la consola VNC/panel de Contabo.']);
    expect(s.actions).toEqual(['shutdown', 'start']);
    expect(s.state.cycle.step).toBe('gave_up');
  });

  it('gave_up is not left until a recovery; a later outage can cycle again only if brakes allow', () => {
    const s = staleSim();
    readyToAct(s);
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' });
    for (let i = 0; i < 9; i++) s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' });
    expect(s.state.cycle.step).toBe('gave_up');
    s.tick({ downN: 0, hbAge: 10_000 });
    s.tick({ downN: 0, hbAge: 10_000 });
    expect(s.state.cycle.step).toBe('idle');
  });

  describe('brakes', () => {
    function stateWithCycles(cycles: number[]): Sim {
      const s = staleSim();
      s.state.cycles = cycles;
      return s;
    }

    it('a cycle started <6 h ago blocks the action; announced once', () => {
      const s = stateWithCycles([T0 - 3 * HOUR]);
      readyToAct(s);
      const msgs: string[] = [];
      for (let i = 0; i < 4; i++) {
        const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
        expect(d.contaboAction).toBeNull();
        expect(d.needContaboStatus).toBe(false);
        msgs.push(...d.messages);
      }
      expect(msgs).toEqual(['⏸️ Freno: ya reinicié el VPS hace poco; solo aviso.']);
    });

    it('2 cycles in the last 24 h block even if the latest is >6 h old', () => {
      const s = stateWithCycles([T0 - 7 * HOUR, T0 - 20 * HOUR]);
      readyToAct(s);
      const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
      expect(d.contaboAction).toBeNull();
      expect(s.all.filter((m) => m.startsWith('⏸️ Freno'))).toHaveLength(1);
    });

    it('1 cycle 7 h ago does not block', () => {
      const s = stateWithCycles([T0 - 7 * HOUR]);
      readyToAct(s);
      const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
      expect(d.contaboAction).toBe('shutdown');
    });

    it('cycles older than 24 h are forgotten', () => {
      const s = stateWithCycles([T0 - 25 * HOUR, T0 - 30 * HOUR]);
      readyToAct(s);
      const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
      expect(d.contaboAction).toBe('shutdown');
      expect(d.next.cycles).toEqual([s.now]);
    });
  });

  it('S2: VPS boots, sites 200, autofix dead (hb stale): recovery message, never "sigue caído" nor gave_up', () => {
    const s = staleSim(); // heartbeat never refreshed
    readyToAct(s);
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' }); // shutdown
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' }); // start
    expect(s.state.cycle.step).toBe('start_sent');
    // boot takes a long while; sites come back right at the 15 min mark and stay
    s.now += 14 * MIN;
    const a = s.tick({ downN: 0, autoRestart: true });
    const b = s.tick({ downN: 0, autoRestart: true });
    const text = [...a.messages, ...b.messages];
    expect(text.filter((m) => m.startsWith('⛔'))).toEqual([]);
    expect(text.filter((m) => m.startsWith('🟢 VPS responde de nuevo tras reiniciarlo'))).toHaveLength(1);
    expect(s.state.cycle.step).toBe('idle');
    expect(s.state.downSince).toBeNull();
  });

  it('S2b: start_sent with sites back for one tick at 15 min does not give up', () => {
    const s = staleSim();
    readyToAct(s);
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' });
    s.now += 14 * MIN;
    const d = s.tick({ downN: 0, autoRestart: true });
    expect(d.messages.filter((m) => m.startsWith('⛔'))).toEqual([]);
    expect(s.state.cycle.step).toBe('start_sent');
  });

  it('S3: shutdown POST timed out (unknown) -> step kept, next tick "stopped" -> start', () => {
    const s = staleSim();
    readyToAct(s);
    const before = s.state;
    const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
    expect(d.contaboAction).toBe('shutdown');
    const f = actionFailed(before, d.next, 'shutdown', 'shutdown: TimeoutError', 'unknown');
    expect(f.messages).toEqual(['⚠️ Contabo no confirmó la orden de shutdown (shutdown: TimeoutError); la doy por enviada y compruebo el estado.']);
    expect(f.next.cycle.step).toBe('shutdown_sent');
    expect(f.next.cycle.fails).toBe(1);
    expect(f.next.cycles).toEqual(d.next.cycles); // still recorded
    s.state = f.next;
    const d2 = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' });
    expect(d2.contaboAction).toBe('start');
    expect(s.state.cycle.step).toBe('start_sent');
  });

  it('actionFailed: 4xx (not_done) reverts the step, 5xx/timeout (unknown) keeps it', () => {
    const s = staleSim();
    readyToAct(s);
    const before = s.state;
    const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
    const refused = actionFailed(before, d.next, 'shutdown', 'shutdown HTTP 403', 'not_done');
    expect(refused.next.cycle).toEqual({ ...before.cycle, fails: 1 });
    expect(refused.next.cycles).toEqual([]);
    expect(refused.messages).toEqual(['⚠️ No pude hablar con Contabo: shutdown HTTP 403']);
    const unknown = actionFailed(before, d.next, 'shutdown', 'shutdown HTTP 503', 'unknown');
    expect(unknown.next.cycle.step).toBe('shutdown_sent');
    expect(unknown.next.cycles).toHaveLength(1);
    // default outcome is the safe "not_done" for existing callers
    expect(actionFailed(before, d.next, 'shutdown', 'x').next.cycle.step).toBe('idle');
  });

  it('actionFailed unknown x3 in the same step -> gave_up', () => {
    const s = staleSim();
    readyToAct(s);
    let st = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' }).next;
    const msgs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const f = actionFailed(st, st, 'start', 'start HTTP 502', 'unknown');
      st = f.next;
      msgs.push(...f.messages);
    }
    expect(st.cycle.step).toBe('gave_up');
    expect(msgs.filter((m) => m.startsWith('⚠️'))).toHaveLength(1);
  });

  it('S4a: sites recover while shutdown_sent -> cycle is NOT closed; "stopped" still leads to start', () => {
    const s = staleSim();
    readyToAct(s);
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' }); // shutdown
    const a = s.tick({ downN: 0, autoRestart: true, contaboStatus: 'running' });
    const b = s.tick({ downN: 0, autoRestart: true, contaboStatus: 'running' }, MIN); // 2 ticks up, only 3 min in
    expect([...a.messages, ...b.messages].filter((m) => m.startsWith('🟢 VPS'))).toEqual([]);
    expect(s.state.cycle.step).toBe('shutdown_sent');
    expect(s.state.downAlerted).toBe(true);
    const c = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' }, MIN); // the shutdown did happen
    expect(c.contaboAction).toBe('start');
    expect(s.state.cycle.step).toBe('start_sent');
  });

  it('S4b: 4 min after shutdown still running and sites up -> cancel (no hard restart), then episode closes', () => {
    const s = staleSim();
    readyToAct(s);
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' }); // shutdown at t
    s.tick({ downN: 0, autoRestart: true, contaboStatus: 'running' }); // t+2, up 1
    const d = s.tick({ downN: 0, autoRestart: true, contaboStatus: 'running' }); // t+4, up 2
    expect(d.contaboAction).toBeNull();
    expect(d.messages).toContain('↩️ El VPS volvió a responder solo antes de apagarse; cancelo el reinicio.');
    expect(d.messages.filter((m) => m.startsWith('🟢 VPS responde de nuevo (caído'))).toHaveLength(1);
    expect(s.state.cycle.step).toBe('idle');
    expect(s.state.cycles).toHaveLength(1); // still counts for the brakes
    expect(s.actions).toEqual(['shutdown']);
  });

  it('S4c: 4 min after shutdown still running and sites down -> hard restart', () => {
    const s = staleSim();
    readyToAct(s);
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
    expect(s.tick({ downN: 2, autoRestart: true, contaboStatus: 'running' }).contaboAction).toBe('restart');
  });

  it('invariant: from idle, Contabo "stopped" never leads to start, even with a past cycle in cycles[]', () => {
    // 7 h ago: outside the 6 h brake, so Contabo is asked and answers "stopped".
    const s = staleSim();
    s.state.cycles = [T0 - 7 * HOUR];
    readyToAct(s);
    for (let i = 0; i < 4; i++) {
      const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' });
      expect(d.contaboAction).toBeNull();
    }
    expect(s.actions).toEqual([]);
    expect(s.all.filter((m) => m.includes('¿lo apagaste tú?'))).toEqual([
      '⛔ El VPS está APAGADO en Contabo: no lo enciendo yo (¿lo apagaste tú?).',
    ]);
    expect(s.state.cycle.step).toBe('idle');
  });

  it('invariant: a cycle <6 h ago (brake) with Contabo "stopped" also never starts', () => {
    const s = staleSim();
    s.state.cycles = [T0 - 10 * MIN];
    readyToAct(s);
    for (let i = 0; i < 4; i++) {
      expect(s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' }).contaboAction).toBeNull();
    }
    expect(s.actions).toEqual([]);
    expect(s.all.filter((m) => m.startsWith('⏸️ Freno'))).toHaveLength(1);
  });

  it('Contabo says stopped: never starts it, says so once', () => {
    const s = staleSim();
    readyToAct(s);
    for (let i = 0; i < 5; i++) {
      const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' });
      expect(d.contaboAction).toBeNull();
    }
    expect(s.all.filter((m) => m.includes('APAGADO en Contabo'))).toEqual([
      '⛔ El VPS está APAGADO en Contabo: no lo enciendo yo (¿lo apagaste tú?).',
    ]);
    expect(s.state.cycles).toEqual([]);
  });

  it('any other status: says it once, no action', () => {
    const s = staleSim();
    readyToAct(s);
    for (let i = 0; i < 3; i++) {
      expect(s.tick({ downN: 3, autoRestart: true, contaboStatus: 'provisioning' }).contaboAction).toBeNull();
    }
    expect(s.all.filter((m) => m.includes('provisioning'))).toHaveLength(1);
  });

  it('hbDisabled: never asks Contabo nor acts', () => {
    const s = staleSim();
    downFor(s, 12, { autoRestart: true, hbDisabled: true, contaboStatus: 'running' });
    expect(s.actions).toEqual([]);
    expect(s.state.cycle.step).toBe('idle');
  });

  it('autoRestart off: never asks Contabo nor acts', () => {
    const s = staleSim();
    let asked = false;
    for (let i = 0; i < 12; i++) {
      const d = s.tick({ downN: 3, autoRestart: false, contaboStatus: 'running' });
      asked ||= d.needContaboStatus;
    }
    expect(asked).toBe(false);
    expect(s.actions).toEqual([]);
  });

  it.each(['major', 'critical'])('Cloudflare %s: no action, announced once', (ind) => {
    const s = staleSim();
    readyToAct(s);
    for (let i = 0; i < 4; i++) {
      expect(s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running', cfIndicator: ind }).contaboAction).toBeNull();
    }
    expect(s.all.filter((m) => m.startsWith('⏸️ Cloudflare'))).toEqual([`⏸️ Cloudflare tiene una incidencia (${ind}): no reinicio.`]);
  });

  it('Cloudflare minor or unknown (null) does not block', () => {
    for (const ind of ['minor', null]) {
      const s = staleSim();
      readyToAct(s);
      const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running', cfIndicator: ind });
      expect(d.contaboAction).toBe('shutdown');
    }
  });

  describe('Contabo errors', () => {
    it('status error: announced once, retried, gave_up after 3', () => {
      const s = staleSim();
      readyToAct(s);
      const out: VpsDecision[] = [];
      for (let i = 0; i < 5; i++) {
        out.push(s.tick({ downN: 3, autoRestart: true, contaboStatus: null, contaboError: 'auth HTTP 401' }));
      }
      expect(out.every((d) => d.contaboAction === null)).toBe(true);
      expect(s.all.filter((m) => m.startsWith('⚠️'))).toEqual(['⚠️ No pude hablar con Contabo: auth HTTP 401']);
      expect(s.state.cycle.step).toBe('gave_up');
      expect(s.all.filter((m) => m.startsWith('⛔ Contabo falla'))).toHaveLength(1);
    });

    it('error text is HTML-escaped', () => {
      const s = staleSim();
      readyToAct(s);
      const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: null, contaboError: '<b>x</b>' });
      expect(d.messages[0]).toBe('⚠️ No pude hablar con Contabo: &lt;b&gt;x&lt;/b&gt;');
    });

    it('action POST failure: step does not advance, cycle not recorded, retried', () => {
      const s = staleSim();
      readyToAct(s);
      const before = s.state;
      const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
      expect(d.contaboAction).toBe('shutdown');
      const f = actionFailed(before, d.next, 'shutdown', 'shutdown HTTP 500');
      expect(f.messages).toEqual(['⚠️ No pude hablar con Contabo: shutdown HTTP 500']);
      expect(f.next.cycle.step).toBe('idle');
      expect(f.next.cycle.fails).toBe(1);
      expect(f.next.cycles).toEqual([]);
    });

    it('action POST failing 3 times in the same step -> gave_up, message only on the first', () => {
      const s = staleSim();
      readyToAct(s);
      const texts: string[] = [];
      for (let i = 0; i < 3; i++) {
        const before = s.state;
        const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
        expect(d.contaboAction).toBe('shutdown');
        const f = actionFailed(before, d.next, 'shutdown', 'shutdown HTTP 500');
        s.state = f.next;
        texts.push(...f.messages);
      }
      expect(texts.filter((t) => t.startsWith('⚠️'))).toHaveLength(1);
      expect(texts.at(-1)).toContain('⛔');
      expect(s.state.cycle.step).toBe('gave_up');
      expect(s.state.cycles).toEqual([]);
      expect(s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' }).contaboAction).toBeNull();
    });

    it('failed "start" keeps shutdown_sent so the next tick retries it', () => {
      const s = staleSim();
      readyToAct(s);
      s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
      const before = s.state;
      const d = s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' });
      expect(d.contaboAction).toBe('start');
      s.state = actionFailed(before, d.next, 'start', 'start HTTP 503').next;
      expect(s.state.cycle.step).toBe('shutdown_sent');
      expect(s.state.cycles).toHaveLength(1); // the cycle itself stays recorded
      expect(s.tick({ downN: 3, autoRestart: true, contaboStatus: 'stopped' }).contaboAction).toBe('start');
    });
  });

  it('AUTO_RESTART switched off mid-cycle: stops, says so once', () => {
    const s = staleSim();
    readyToAct(s);
    s.tick({ downN: 3, autoRestart: true, contaboStatus: 'running' });
    const d = s.tick({ downN: 3, autoRestart: false });
    expect(d.contaboAction).toBeNull();
    expect(d.messages).toHaveLength(1);
    expect(s.state.cycle.step).toBe('gave_up');
  });

  it('decide() does not mutate its input state', () => {
    const s = staleSim();
    const snapshot = JSON.stringify(s.state);
    decide(s.state, obs({ downN: 3, hbAge: 8 * MIN }));
    expect(JSON.stringify(s.state)).toBe(snapshot);
  });
});

describe('state persistence helpers', () => {
  it('idle ticks with nothing happening do not change the state (no KV writes)', () => {
    const s = new Sim();
    const before = JSON.stringify(s.state);
    for (let i = 0; i < 5; i++) s.tick({ downN: 0 });
    expect(JSON.stringify(s.state)).toBe(before);
  });

  it('parseVpsState survives garbage', () => {
    expect(parseVpsState(null)).toEqual(initialVpsState());
    expect(parseVpsState('x')).toEqual(initialVpsState());
    expect(parseVpsState({ cycle: { step: 'bogus' }, cycles: 'no', notes: [1, 'a'] })).toEqual({
      ...initialVpsState(),
      notes: ['a'],
    });
  });

  it('config constants match the spec', () => {
    expect(VPS_CFG.hbDownMs).toBe(6 * MIN);
    expect(VPS_CFG.hbSilentMs).toBe(10 * MIN);
    expect(VPS_CFG.minCycleGapMs).toBe(6 * HOUR);
  });
});

describe('validateHeartbeat', () => {
  const ok = { kind: 'heartbeat', ts: 1761393600, open: ['music', 'tv'], disabled: false, host: 'vps1' };

  it('accepts a valid payload and returns only the stored fields', () => {
    expect(validateHeartbeat(ok)).toEqual({ disabled: false, open: ['music', 'tv'], host: 'vps1' });
    expect(validateHeartbeat({ ...ok, open: [], disabled: true })).toEqual({ disabled: true, open: [], host: 'vps1' });
  });

  it.each([
    ['null', null],
    ['array', []],
    ['string', 'x'],
    ['ts missing', { ...ok, ts: undefined }],
    ['ts string', { ...ok, ts: '123' }],
    ['ts NaN', { ...ok, ts: NaN }],
    ['open missing', { ...ok, open: undefined }],
    ['open not array', { ...ok, open: 'music' }],
    ['open item not string', { ...ok, open: ['a', 1] }],
    ['open item too long', { ...ok, open: ['x'.repeat(101)] }],
    ['open too many', { ...ok, open: Array.from({ length: 51 }, () => 'a') }],
    ['disabled string', { ...ok, disabled: 'false' }],
    ['disabled missing', { ...ok, disabled: undefined }],
    ['host number', { ...ok, host: 5 }],
    ['host too long', { ...ok, host: 'h'.repeat(101) }],
  ])('rejects %s', (_name, payload) => {
    expect(validateHeartbeat(payload)).toBeNull();
  });

  it('accepts the boundaries (50 items, 100 chars)', () => {
    expect(validateHeartbeat({ ...ok, open: Array.from({ length: 50 }, () => 'x'.repeat(100)), host: 'h'.repeat(100) })).not.toBeNull();
  });
});
