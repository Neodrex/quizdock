#!/usr/bin/env node
/**
 * Load test of a live escape room (M9 plan §1.2): one host, one screen, a race's
 * public board and N socket.io bots play a sample room on a running Live (Lost
 * Library in races, which take parallel rooms only; Vault Heist, with roles and a
 * combined lock, in a hosted event), through
 * the same events as the phones. Modelled on upstream's
 * apps/backend/scripts/load-test.mjs (same percentiles, CPU/RSS/Redis measures),
 * with a CPU/RSS sampler: `/proc/<pid>/stat` deltas on Linux, `ps` on macOS (no
 * /proc), or `docker stats` for a container.
 *
 *   node load.mjs --url http://localhost:3000 --scenario race-teams --players 500 \
 *     [--join-rate 10] [--burst] [--think 10-40] [--duration-min 12] [--teams 100] \
 *     [--sustain] [--server-pid <pid> | --container <name>] [--redis redis://localhost:16379] \
 *     [--host-cookie '<Live session cookie>'] [--cpu-cap '1 vCPU'] [--seed 1] \
 *     [--backend-commit <sha>] [--criteria local|uk] [--out result.json]
 *
 * `--sustain`: the room's time limit is `--duration-min` and the run ends at
 * time-up (no host end); a bot whose team is out keeps its rhythm with what a
 * finished phone still does (a resync, as a reload, or a drop and reconnect), so
 * the room keeps a load until the end. Phones whose socket the server drops
 * (a backend restart) come back with their session token and are timed.
 *
 * Scenarios: `race-teams` (teams of up to 3 by team code, a scheduled start),
 * `race-solo` (one-player teams, a scheduled start), `hosted` (a hosted event,
 * `escape:teams` auto into `--teams` teams, started by the host).
 * The host is `x-local-user` under AUTH_MODE=none, or `--host-cookie` (REST and
 * the host socket) under OIDC. The answers come from the host's REST template
 * detail, never from a phone frame. Exits non-zero when a `--criteria` fails.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { Redis } from 'ioredis';
import { io } from 'socket.io-client';
import {
  answerFor,
  botPlan,
  classifyAck,
  cpuBetween,
  criteriaFailed,
  maskUrl,
  parseDockerStats,
  parseProcStat,
  parsePs,
  stats,
  wrongFor,
} from './load-lib.mjs';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    scenario: { type: 'string', default: 'race-teams' },
    players: { type: 'string', default: '500' },
    'join-rate': { type: 'string', default: '10' },
    burst: { type: 'boolean', default: false },
    think: { type: 'string', default: '10-40' },
    'duration-min': { type: 'string', default: '12' },
    teams: { type: 'string', default: '100' },
    sustain: { type: 'boolean', default: false },
    'backend-commit': { type: 'string' },
    'server-pid': { type: 'string' },
    container: { type: 'string' },
    redis: { type: 'string' },
    'host-cookie': { type: 'string' },
    'cpu-cap': { type: 'string', default: 'none' },
    seed: { type: 'string', default: '1' },
    criteria: { type: 'string' },
    out: { type: 'string' },
  },
});

const SCENARIOS = ['race-teams', 'race-solo', 'hosted'];
if (!SCENARIOS.includes(args.scenario)) throw new Error(`--scenario: one of ${SCENARIOS}`);
const URL_BASE = args.url.replace(/\/$/, '');
// lib.mjs reads the address and the cookie from the environment.
process.env.URL = URL_BASE;
if (args['host-cookie']) process.env.HOST_COOKIE = args['host-cookie'];
const { HOST, claimSeat, releaseSeat, sampleTemplate, sleep, log } = await import('./lib.mjs');

const PLAYERS = Number(args.players);
const JOIN_RATE = Number(args['join-rate']);
const [THINK_MIN, THINK_MAX] = args.think.split('-').map((s) => Number(s) * 1000);
const DURATION_MS = Number(args['duration-min']) * 60_000;
const TEAMS = Number(args.teams);
const SUSTAIN = args.sustain;
const SEED = Number(args.seed);
const RACE = args.scenario !== 'hosted';
// Races take parallel templates only (M7 SESSION_RULES); a hosted event plays the roles sample.
const TEMPLATE = RACE ? 'Lost Library' : 'Vault Heist';
const ACK_TIMEOUT_MS = 10_000;
// A scheduled race starts at least a minute after its create (M9 §5 item 6).
const RACE_LEAD_MS = 60_000;

const t = () => performance.now();
const sockets = new Set();

function connect({ host = false } = {}) {
  const auth = !host
    ? {}
    : args['host-cookie']
      ? { extraHeaders: { cookie: args['host-cookie'] } }
      : { auth: { localUser: HOST } };
  const s = io(`${URL_BASE}/game`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    ...auth,
  });
  sockets.add(s);
  return s;
}

const connected = (s) =>
  s.connected
    ? Promise.resolve()
    : new Promise((ok, ko) => {
        const timer = setTimeout(() => ko(new Error('no connect within 10 s')), 10_000);
        s.once('connect', () => (clearTimeout(timer), ok()));
        s.once('connect_error', (e) => (clearTimeout(timer), ko(e)));
      });

/** An ack that says ok, or a throw. */
const must = async (s, event, payload) => {
  const ack = await ask(s, event, payload);
  if (!ack?.ok) throw new Error(`${event}: ${JSON.stringify(ack ?? 'lost')}`);
  return ack;
};

/** An ack, or `undefined` when none came within ACK_TIMEOUT_MS (a lost ack). */
const ask = (s, event, payload) =>
  s
    .timeout(ACK_TIMEOUT_MS)
    .emitWithAck(event, payload)
    .catch(() => undefined);

// ── What the run measures ──

const m = {
  errors: [],
  joinMs: [],
  syncMs: [],
  joinRefused: [],
  submitMs: [],
  submitBy: {},
  doneAt: [],
  hintMs: [],
  reconnectMs: [],
  reconnectFailed: 0,
  lost: 0,
  acks: { ok: 0, expected: {}, unexpected: {} },
  submits: 0,
  fanoutMs: [],
  startAt: new Map(),
  finaleAt: new Map(),
  boardAt: [],
  hostFrames: [],
  readyMs: [],
  readyFailed: 0,
  samples: [],
  teamsJoined: 0,
  // Sockets the server dropped (a restart): when, and each phone's way back.
  dropped: [],
  recoverMs: [],
  recoveredAt: [],
  recoverFailed: 0,
  stateLost: [],
  sustainSyncMs: [],
  timerHintsAt: [],
};
/** Set once the run is being ended (time-up, the host's end, or the tool's stop). */
let ending = false;
let tookSeat = false;
const note = (where, e) => {
  if (m.errors.length < 50)
    m.errors.push(`${where}: ${typeof e === 'string' ? e : JSON.stringify(e)}`);
};
const count = (bucket, key) => (bucket[key] = (bucket[key] ?? 0) + 1);

// ── Server-side samplers ──

const run = promisify(execFile);

/** Linux: `/proc/<pid>/stat` read every second; CPU from the ticks' delta (ps %cpu is a lifetime average). */
function procSampler(pid) {
  const conf = (name, dflt) => {
    try {
      return Number(execFileSync('getconf', [name], { encoding: 'utf8' }).trim()) || dflt;
    } catch {
      return dflt;
    }
  };
  const ticksPerS = conf('CLK_TCK', 100);
  const pageMb = conf('PAGESIZE', 4096) / 1024 / 1024;
  let last = null;
  return () => {
    const now = { at: Date.now(), ...parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8')) };
    if (now.ticks === undefined) return null;
    const prev = last;
    last = now;
    if (!prev) return null;
    return {
      cpu: cpuBetween(prev, now, now.at - prev.at, ticksPerS),
      rssMb: Math.round(now.rssPages * pageMb),
    };
  };
}

/** CPU (% of one core) and RSS (MB) every second, from /proc, `ps` or `docker stats`, until stopped. */
function sampler() {
  if (!args['server-pid'] && !args.container) return () => null;
  const proc =
    args['server-pid'] && os.platform() === 'linux' ? procSampler(args['server-pid']) : null;
  let on = true;
  (async () => {
    while (on) {
      const at = Date.now();
      try {
        const s = proc
          ? proc()
          : args['server-pid']
            ? parsePs((await run('ps', ['-o', '%cpu=,rss=', '-p', args['server-pid']])).stdout)
            : parseDockerStats(
                (
                  await run('docker', [
                    'stats',
                    '--no-stream',
                    '--format',
                    '{{.CPUPerc}};{{.MemUsage}}',
                    args.container,
                  ])
                ).stdout,
              );
        if (s) m.samples.push({ at, ...s });
      } catch {
        // the process is gone: nothing to sample this time
      }
      await sleep(Math.max(0, 1000 - (Date.now() - at)));
    }
  })();
  return () => {
    on = false;
    return m.samples.length
      ? {
          cpuPct: stats(m.samples.map((s) => s.cpu)),
          rssMb: {
            start: m.samples[0].rssMb,
            max: Math.max(...m.samples.map((s) => s.rssMb)),
          },
        }
      : null;
  };
}

/** `/health/ready` latency every second (an event-loop proxy), until stopped. */
function readyPoller() {
  let on = true;
  (async () => {
    while (on) {
      const at = t();
      try {
        const res = await fetch(`${URL_BASE}/health/ready`, { signal: AbortSignal.timeout(5000) });
        await res.arrayBuffer();
        if (res.ok) m.readyMs.push(t() - at);
        else m.readyFailed++;
      } catch {
        m.readyFailed++;
      }
      await sleep(Math.max(0, 1000 - (t() - at)));
    }
  })();
  return () => (on = false);
}

async function redisCommands(redis) {
  const stats = await redis.info('commandstats');
  const out = {};
  for (const [, name, calls] of stats.matchAll(/^cmdstat_([^:]+):calls=(\d+)/gm)) {
    out[name] = Number(calls);
  }
  return out;
}

// ── The bots ──

/** A phone: joins, syncs, keeps its state, plays its plan, reconnects when it drops. */
function newBot(i, pin, content) {
  const b = {
    i,
    nickname: `bot${i}`,
    socket: null,
    state: null,
    token: null,
    playerId: null,
    teamId: null,
    finale: false,
    plan: botPlan(SEED * 100_003 + i, {
      actions: 400,
      thinkMs: [THINK_MIN, THINK_MAX],
      wrong: 0.1,
      hint: 0.05,
      drop: 0.05,
    }),
  };
  // race-teams: the team code this bot starts (a leader), once it has one (null: none).
  b.code = new Promise((resolve) => (b.setCode = resolve));
  b.listen = (s) => {
    s.on('escape:state', (st) => {
      b.state = st;
      if (st.phase === 'running' && !m.startAt.has(i)) m.startAt.set(i, t());
    });
    s.on('escape:finale', () => {
      if (!m.finaleAt.has(i)) m.finaleAt.set(i, t());
      b.finale = true;
    });
    s.on('escape:team-update', (u) => {
      const sent = pending.get(u.by);
      if (sent && u.by !== b.playerId && sent.teamId === u.teamId) m.fanoutMs.push(t() - sent.t0);
      if (u.kind === 'hint' && u.source === 'timer') m.timerHintsAt.push(t());
    });
    s.on('exception', (e) => note(`bot${i} exception`, e));
    s.on('error', (e) => note(`bot${i} error`, e));
    // The server dropped it (a restart): back with the session token, timed.
    s.on('disconnect', (reason) => {
      if (reason === 'io client disconnect' || ending || s !== b.socket) return;
      void recover(b);
    });
  };
  b.content = content;
  b.pin = pin;
  return b;
}

/** Submits in flight, by player id: what teammates' team-updates are timed against. */
const pending = new Map();

async function join(b) {
  const s = connect();
  b.socket = s;
  b.listen(s);
  await connected(s);
  const t0 = t();
  const ack = await ask(s, 'player:join', { pin: b.pin, nickname: b.nickname });
  if (!ack?.playerId) {
    m.joinRefused.push(ack?.error?.code ?? (ack ? JSON.stringify(ack) : 'lost'));
    return false;
  }
  m.joinMs.push(t() - t0);
  b.token = ack.sessionToken;
  b.playerId = ack.playerId;
  const t1 = t();
  const synced = await ask(s, 'escape:sync', { pin: b.pin });
  if (synced?.ok) m.syncMs.push(t() - t1);
  else setupFailed(b, 'sync', synced);
  return true;
}

/** A sync, team create or team join refused or lost: unexpected (the game should take it). */
function setupFailed(b, what, ack) {
  note(`bot${b.i} ${what}`, ack ?? 'lost');
  count(m.acks.unexpected, `${what}:${ack ? (ack.error?.code ?? JSON.stringify(ack)) : 'lost'}`);
}

/** race-teams: every third bot starts a team; the next two join it by its code. */
async function formTeam(b, leader) {
  if (b === leader) {
    const ack = await ask(b.socket, 'escape:new-team', { pin: b.pin, name: `Team ${b.i}` });
    if (!ack?.ok) setupFailed(b, 'new-team', ack);
    else m.teamsJoined++;
    return ack?.ok ? ack.code : null;
  }
  const code = await leader.code;
  if (!code) return null;
  const ack = await ask(b.socket, 'escape:join-team', { pin: b.pin, code });
  if (!ack?.ok) setupFailed(b, 'join-team', ack);
  else m.teamsJoined++;
  return null;
}

/** A new socket for the bot, back in its seat with its session token and synced; why not, or null. */
async function rejoin(b) {
  const s = connect();
  b.socket = s;
  b.listen(s);
  try {
    await connected(s);
  } catch (e) {
    sockets.delete(s);
    return e.message;
  }
  const re = await ask(s, 'player:reconnect', { sessionToken: b.token });
  const synced = re?.ok ? await ask(s, 'escape:sync', { pin: b.pin }) : undefined;
  return synced?.ok ? null : JSON.stringify(re ?? 'lost');
}

/** A planned drop: the bot's socket closed, then back after half a second. */
async function reconnect(b) {
  if (b.recovering) return;
  b.socket.disconnect();
  sockets.delete(b.socket);
  await sleep(500);
  const t0 = t();
  const why = await rejoin(b);
  if (why === null) m.reconnectMs.push(t() - t0);
  else {
    m.reconnectFailed++;
    note(`bot${b.i} reconnect`, why);
  }
}

/** What of the team must survive a restart: its stage, the locks solved there, its finish. */
const progressOf = (st) =>
  st?.team && {
    stage: st.team.stageIndex,
    solved: st.view?.locks.filter((l) => l.solved).length ?? 0,
    out: !!(st.team.escaped || st.team.timedOut),
  };

/** An unplanned drop (the server went away): retry each second (and a jitter) for 90 s. */
async function recover(b) {
  b.recovering = true;
  const t0 = t();
  m.dropped.push(t0);
  const before = progressOf(b.state);
  sockets.delete(b.socket);
  let why = 'not tried';
  while (!ending && t() - t0 < 90_000) {
    await sleep(1000 + Math.random() * 500);
    why = await rejoin(b);
    if (why === null) break;
  }
  b.recovering = false;
  if (why !== null) {
    if (!ending) {
      m.recoverFailed++;
      note(`bot${b.i} recover`, why);
    }
    return;
  }
  m.recoverMs.push(t() - t0);
  m.recoveredAt.push(t());
  const after = progressOf(b.state);
  if (
    before &&
    (!after ||
      after.stage < before.stage ||
      (after.stage === before.stage && after.solved < before.solved) ||
      (before.out && !after.out))
  ) {
    m.stateLost.push({ bot: b.i, before, after });
  }
}

/** The run is over for everyone (the finale, or the tool's stop). */
const over = (b) => ending || b.finale || b.state?.phase === 'finale' || stopAt < Date.now();
/** The bot's team is out (escaped or timed out). */
const out = (b) => !!(b.state?.team?.escaped || b.state?.team?.timedOut);
let stopAt = Infinity;

/** The bot's plan, one action per think time, until its team is out or the run ends. */
async function play(b) {
  for (const a of b.plan) {
    // A random first wait spreads the bots' first moves over a think time.
    await sleep(a.thinkMs);
    if (over(b) || (!SUSTAIN && out(b))) {
      if (!b.doneAt) m.doneAt.push((b.doneAt = t()));
      return;
    }
    if (!b.socket.connected || b.recovering) continue;
    if (a.kind === 'drop') {
      await reconnect(b);
      continue;
    }
    if (out(b)) {
      // --sustain: a finished phone still reloads (a resync) now and then.
      if (!b.doneAt) m.doneAt.push((b.doneAt = t()));
      const t0 = t();
      const ack = await ask(b.socket, 'escape:sync', { pin: b.pin });
      if (ack?.ok) m.sustainSyncMs.push(t() - t0);
      else if (!ack) m.lost++;
      else tally('sync', ack);
      continue;
    }
    const st = b.state;
    if (!st?.view) continue;
    if (a.kind === 'hint') {
      if (!st.nextHint) continue;
      const t0 = t();
      const ack = await ask(b.socket, 'escape:ask-hint', { pin: b.pin, hintId: st.nextHint.id });
      if (!ack) m.lost++;
      else m.hintMs.push(t() - t0);
      tally('hint', ack);
      continue;
    }
    const open = st.view.locks.filter((l) => !l.solved);
    if (!open.length) continue;
    const lock = open[Math.floor(a.pick * open.length)];
    const what = a.kind === 'wrong' ? wrongFor(lock, b.content) : answerFor(lock, null, b.content);
    if (!what) continue;
    const t0 = t();
    pending.set(b.playerId, { t0, teamId: st.team?.id });
    m.submits++;
    const ack = await ask(b.socket, 'escape:submit', { pin: b.pin, ...what });
    if (!ack) m.lost++;
    else {
      m.submitMs.push(t() - t0);
      (m.submitBy[ack.ok ? ack.outcome : ack.reason] ??= []).push(t() - t0);
    }
    // A teammate cleared the stage while this answer was on its way: the lock is gone.
    const moved = b.state?.team?.stageIndex !== st.team?.stageIndex;
    tally(a.kind, ack, moved && ack?.reason === 'unknown-lock');
  }
}

function tally(intended, ack, stale = false) {
  if (!ack) return;
  const c = stale
    ? 'expected'
    : intended === 'sync'
      ? 'unexpected'
      : classifyAck(intended, ack, { ending: ending || stopAt < Date.now() });
  if (c === 'ok') m.acks.ok++;
  else count(m.acks[c], `${intended}:${ack.ok ? ack.outcome : ack.reason}`);
}

// ── The run ──

function machine() {
  const cpus = os.cpus();
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: 'utf8',
    }).trim();
  } catch {
    // not a checkout
  }
  return {
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: `${cpus[0]?.model} × ${cpus.length}`,
    memGb: Math.round(os.totalmem() / 1024 ** 3),
    node: process.version,
    commit,
    // The backend measured: --backend-commit, else this checkout (marked when it has changes).
    backendCommit: args['backend-commit'] ?? (commit && dirty() ? `${commit}+changes` : commit),
  };
}

function dirty() {
  try {
    return (
      execFileSync('git', ['status', '--porcelain', '--', '../../apps/backend', '../../packages'], {
        cwd: dirname(fileURLToPath(import.meta.url)),
        encoding: 'utf8',
      }).trim() !== ''
    );
  } catch {
    return false;
  }
}

/** Intervals between consecutive arrivals at or after `from`, ms. */
const intervals = (ats, from, to) => {
  const xs = ats.filter((a) => a >= from && a <= to);
  return xs.slice(1).map((a, k) => a - xs[k]);
};

const spread = (map) => {
  const xs = [...map.values()];
  if (!xs.length) return stats([]);
  const first = Math.min(...xs);
  return stats(xs.map((x) => x - first));
};

async function main() {
  const startedAt = new Date().toISOString();
  log(`${args.scenario}: ${PLAYERS} players on ${URL_BASE}`);
  tookSeat = await claimSeat();
  const tpl = await sampleTemplate(TEMPLATE);
  const content = tpl.content;
  const redis = args.redis ? new Redis(args.redis, { lazyConnect: true }) : null;
  if (redis) await redis.connect();
  const stopSampler = sampler();
  const stopReady = readyPoller();

  // Host: creates the room, syncs (host room), counts its frames (bytes: the
  // payload's JSON length, an approximation of the frame).
  let hostFinale = false;
  const hostSocket = () => {
    const s = connect({ host: true });
    s.onAny((event, ...payload) =>
      m.hostFrames.push({ at: t(), event, bytes: JSON.stringify(payload).length }),
    );
    s.on('exception', (e) => note('host exception', e));
    s.on('escape:finale', () => (hostFinale = true));
    return s;
  };
  const host = hostSocket();
  await connected(host);
  const createdAt = Date.now();
  const joinEstimateMs = (PLAYERS / JOIN_RATE) * 1000 * 1.2;
  const startsAt = createdAt + Math.max(RACE_LEAD_MS + 5_000, joinEstimateMs + 15_000);
  // --sustain: the run ends at time-up; otherwise by escapes or the host's end, never by time.
  const durationMin = SUSTAIN
    ? Math.max(5, Math.round(DURATION_MS / 60_000))
    : Math.max(5, Math.ceil(DURATION_MS / 60_000) + 5);
  const created = await ask(host, 'escape:create', {
    templateId: tpl.id,
    durationMin,
    ...(RACE
      ? {
          sessionType: 'race',
          race: { format: args.scenario === 'race-solo' ? 'solo' : 'teams', startsAt },
        }
      : { sessionType: 'hosted' }),
  });
  if (!created?.pin) throw new Error(`escape:create: ${JSON.stringify(created)}`);
  const { pin } = created;
  log(`room ${pin}${RACE ? `, starts at ${new Date(startsAt).toISOString()}` : ''}`);
  await ask(host, 'escape:sync', { pin });
  const boardAt = [];
  m.side = {};
  /** A host, screen or board socket that comes back on its own when the server drops it. */
  const keep = async (name, make, enter) => {
    const s = make();
    await connected(s);
    await enter(s);
    s.on('disconnect', (reason) => {
      if (reason === 'io client disconnect' || ending) return;
      const t0 = t();
      void (async () => {
        while (!ending && t() - t0 < 90_000) {
          await sleep(1000 + Math.random() * 500);
          const again = make();
          try {
            await connected(again);
            await enter(again);
            m.side[name] = Math.round(t() - t0);
            again.on(
              'disconnect',
              (r) => r !== 'io client disconnect' && !ending && note(name, 'dropped again'),
            );
            return;
          } catch {
            sockets.delete(again);
          }
        }
        note(name, 'not back within 90 s');
      })();
    });
    return s;
  };
  // The host's socket now: after a restart, the one that came back.
  let hostNow = host;
  await keep(
    'host',
    () => (hostNow === host && host.connected ? host : (hostNow = hostSocket())),
    async (s) => {
      if (s === host) return;
      // Back as the room's host (host:attach), then its escape state.
      await must(s, 'host:attach', { pin });
      await must(s, 'escape:sync', { pin });
    },
  );

  // The big screen (the host's own projection) and, in a race, the public board.
  const screen = await keep(
    'screen',
    () => {
      const s = connect({ host: true });
      if (!RACE) s.on('escape:board', () => boardAt.push(t()));
      return s;
    },
    async (s) => {
      await must(s, 'spectator:join', { pin });
      await must(s, 'escape:sync', { pin });
    },
  );
  if (RACE) {
    await keep(
      'board',
      () => {
        const s = connect();
        s.on('escape:board', () => boardAt.push(t()));
        return s;
      },
      async (s) => {
        await must(s, 'spectator:join', { pin, follow: true });
        await must(s, 'escape:sync', { pin });
      },
    );
  }
  void screen;

  // Joins: paced at --join-rate, or (--burst) 50 at once.
  const bots = Array.from({ length: PLAYERS }, (_, i) => newBot(i, pin, content));
  const commandsBefore = redis ? await redisCommands(redis) : null;
  const joinT0 = t();
  const formed = [];
  const joinOne = async (b) => {
    const leader = bots[b.i - (b.i % 3)];
    try {
      if (!(await join(b))) {
        if (b === leader) b.setCode(null);
        return;
      }
    } catch (e) {
      // No connection: a refused join, never a crash of the run.
      m.joinRefused.push(`connect: ${e.message}`);
      if (b === leader) b.setCode(null);
      return;
    }
    if (args.scenario !== 'race-teams') return;
    if (b === leader) b.setCode(await formTeam(b, leader));
    else formed.push(formTeam(b, leader));
  };
  const joins = [];
  if (args.burst) {
    for (let k = 0; k < bots.length; k += 50) {
      await Promise.all(bots.slice(k, k + 50).map(joinOne));
    }
  } else {
    for (const b of bots) {
      joins.push(joinOne(b));
      await sleep(1000 / JOIN_RATE);
    }
  }
  await Promise.all(joins);
  await Promise.all(formed);
  const joinS = (t() - joinT0) / 1000;
  const joined = bots.filter((b) => b.playerId);
  log(`${joined.length}/${PLAYERS} joined in ${joinS.toFixed(1)} s`);

  // Start: a race's own schedule, or the host deals teams and starts.
  if (RACE) {
    const wait = startsAt - Date.now();
    log(`waiting ${Math.round(wait / 1000)} s for the scheduled start`);
    await sleep(Math.max(0, wait));
  } else {
    const teams = await ask(host, 'escape:teams', { pin, mode: 'auto', count: TEAMS });
    if (!teams?.ok) note('host teams', teams ?? 'lost');
    const started = await ask(host, 'escape:start', { pin });
    if (!started?.ok) note('host start', started ?? 'lost');
  }
  // Every phone running, or 30 s.
  for (let k = 0; k < 60 && m.startAt.size < joined.length; k++) await sleep(500);
  const runT0 = m.startAt.size ? Math.min(...m.startAt.values()) : t();
  log(`${m.startAt.size}/${joined.length} phones running`);
  const commandsAtRun = redis ? await redisCommands(redis) : null;
  const submitsAtRun = m.submits;

  // Play until every team is out or --duration-min (with --sustain: time-up), then the finale.
  stopAt = Date.now() + DURATION_MS + (SUSTAIN ? 30_000 : 0);
  const playing = Promise.all(joined.map(play));
  await Promise.race([playing, sleep(DURATION_MS + 60_000)]);
  const runT1 = t();
  ending = true;
  if (!hostFinale) {
    if (SUSTAIN) note('run', 'no finale at time-up: the host ends it');
    const ended = await ask(hostNow, 'escape:end', { pin });
    if (!ended?.ok) note('host end', ended ?? 'lost');
  }
  for (let k = 0; k < 40 && m.finaleAt.size < joined.length; k++) await sleep(250);
  const commandsAfter = redis ? await redisCommands(redis) : null;
  stopReady();
  const server = stopSampler();
  hostNow.emit('host:end', { pin });
  await sleep(300);
  for (const s of sockets) s.disconnect();
  if (redis) redis.disconnect();
  if (tookSeat) await releaseSeat();
  tookSeat = false;

  // ── Summary ──
  const runS = (runT1 - runT0) / 1000;
  const half = [...m.doneAt].sort((a, b) => a - b)[Math.floor(joined.length / 2)];
  const activeEnd = half ?? runT1;
  const inRun = m.hostFrames.filter((f) => f.at >= runT0 && f.at <= runT1);
  const perEvent = {};
  for (const f of inRun) {
    const e = (perEvent[f.event] ??= { frames: 0, bytes: 0 });
    e.frames++;
    e.bytes += f.bytes;
  }
  for (const e of Object.values(perEvent)) {
    e.perS = +(e.frames / runS).toFixed(2);
    e.kbPerS = +(e.bytes / 1024 / runS).toFixed(1);
  }
  // Redis commands per submit: from the run's start (play only), and, as in the
  // first baseline, from the first join (joins and syncs included).
  const redisDelta = (before) => {
    const delta = Object.entries(commandsAfter)
      .map(([k, v]) => [k, v - (before[k] ?? 0)])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    return { delta, total: delta.reduce((s, [, v]) => s + v, 0) };
  };
  let redisPerSubmit = null;
  let redisPerSubmitWithJoins = null;
  let redisTop = null;
  if (commandsBefore) {
    const run = redisDelta(commandsAtRun);
    const runSubmits = m.submits - submitsAtRun;
    redisPerSubmit = runSubmits ? Math.round(run.total / runSubmits) : null;
    redisTop = Object.fromEntries(run.delta.slice(0, 10));
    const all = redisDelta(commandsBefore);
    redisPerSubmitWithJoins = m.submits ? Math.round(all.total / m.submits) : null;
  }
  const firstDrop = m.dropped.length ? Math.min(...m.dropped) : null;
  const unexpected = Object.values(m.acks.unexpected).reduce((s, n) => s + n, 0);
  const summary = {
    race: RACE,
    sustain: SUSTAIN,
    players: PLAYERS,
    joined: joined.length,
    joinRefused: m.joinRefused.length,
    joinS: +joinS.toFixed(1),
    runS: Math.round(runS),
    joinAckMs: stats(m.joinMs),
    syncAckMs: stats(m.syncMs),
    submits: m.submits,
    submitAckMs: stats(m.submitMs),
    submitAckByOutcomeMs: Object.fromEntries(
      Object.entries(m.submitBy).map(([k, xs]) => [k, stats(xs)]),
    ),
    hintAckMs: stats(m.hintMs),
    lostAcks: m.lost,
    acks: m.acks,
    unexpected,
    teamUpdateFanoutMs: stats(m.fanoutMs),
    reconnectMs: stats(m.reconnectMs),
    reconnectFailed: m.reconnectFailed,
    startSpreadMs: spread(m.startAt),
    phonesStarted: m.startAt.size,
    finaleSpreadMs: spread(m.finaleAt),
    phonesFinale: m.finaleAt.size,
    // While at least half the bots still play: a board with nothing new is not sent.
    boardIntervalMs: stats(intervals(boardAt, runT0, activeEnd)),
    hostFramesPerS: +(inRun.length / runS).toFixed(2),
    hostKbPerS: +(inRun.reduce((s, f) => s + f.bytes, 0) / 1024 / runS).toFixed(1),
    hostPerEvent: perEvent,
    readyMs: stats(m.readyMs),
    readyFailed: m.readyFailed,
    cpuPct: server?.cpuPct ?? null,
    rssMb: server?.rssMb ?? null,
    redisCommandsPerSubmit: redisPerSubmit,
    redisCommandsPerSubmitWithJoins: redisPerSubmitWithJoins,
    redisTopCommands: redisTop,
    sustainSyncAckMs: stats(m.sustainSyncMs),
    // A backend restart: phones the server dropped, and their way back.
    restart:
      firstDrop === null
        ? null
        : {
            dropped: m.dropped.length,
            recovered: m.recoverMs.length,
            recoverFailed: m.recoverFailed,
            recoverMs: stats(m.recoverMs),
            // From the first drop to the last phone back.
            fullRecoveryMs: m.recoveredAt.length
              ? Math.round(Math.max(...m.recoveredAt) - firstDrop)
              : null,
            host: m.side,
            stateLost: m.stateLost,
            timerHintsAfter: m.timerHintsAt.filter((a) => a > firstDrop).length,
            atRunS: Math.round((firstDrop - runT0) / 1000),
          },
    finaleAtRunS: m.finaleAt.size
      ? Math.round((Math.min(...m.finaleAt.values()) - runT0) / 1000)
      : null,
    errors: m.errors,
  };
  const failed = args.criteria ? criteriaFailed(summary, args.criteria) : [];
  const result = {
    setup: {
      startedAt,
      machine: machine(),
      cpuCap: args['cpu-cap'],
      scenario: args.scenario,
      options: Object.fromEntries(
        Object.entries({ ...args, 'host-cookie': args['host-cookie'] ? '(set)' : undefined }).map(
          ([k, v]) => [k, maskUrl(v)],
        ),
      ),
      template: TEMPLATE,
    },
    summary,
    criteria: args.criteria ? { where: args.criteria, failed } : null,
  };
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  }
  report(summary, failed);
  return failed.length === 0 && joined.length === PLAYERS ? 0 : 1;
}

function report(s, failed) {
  const p = (x) => (x?.n ? `p50 ${x.p50} / p95 ${x.p95} / p99 ${x.p99} / max ${x.max}` : '—');
  const rows = [
    ['players joined', `${s.joined} (refused ${s.joinRefused}) in ${s.joinS} s`],
    ['join ack ms', p(s.joinAckMs)],
    ['submits', `${s.submits} in ${s.runS} s`],
    ['submit ack ms', p(s.submitAckMs)],
    ...Object.entries(s.submitAckByOutcomeMs).map(([k, v]) => [`  ${k} (${v.n})`, p(v)]),
    ['lost acks / unexpected', `${s.lostAcks} / ${s.unexpected}`],
    ['expected refusals', JSON.stringify(s.acks.expected)],
    ['unexpected refusals', JSON.stringify(s.acks.unexpected)],
    ['team-update fan-out ms', p(s.teamUpdateFanoutMs)],
    ['reconnect ms', `${p(s.reconnectMs)} (failed ${s.reconnectFailed})`],
    ['start spread ms', `${p(s.startSpreadMs)} (${s.phonesStarted} phones)`],
    ['finale spread ms', `${p(s.finaleSpreadMs)} (${s.phonesFinale} phones)`],
    ['board interval ms', p(s.boardIntervalMs)],
    ['host frames/s, KB/s (approx.)', `${s.hostFramesPerS}, ${s.hostKbPerS}`],
    ...Object.entries(s.hostPerEvent).map(([e, v]) => [`  ${e}`, `${v.perS}/s, ${v.kbPerS} KB/s`]),
    ['/health/ready ms', `${p(s.readyMs)} (failed ${s.readyFailed})`],
    ['backend CPU %', p(s.cpuPct)],
    ['backend RSS MB', s.rssMb ? `${s.rssMb.start} → max ${s.rssMb.max}` : '—'],
    [
      'Redis commands/submit',
      `${s.redisCommandsPerSubmit ?? '—'} in play (${s.redisCommandsPerSubmitWithJoins ?? '—'} with joins)`,
    ],
    ...(s.restart
      ? [
          [
            'restart: phones back',
            `${s.restart.recovered}/${s.restart.dropped} (failed ${s.restart.recoverFailed}), full in ${s.restart.fullRecoveryMs} ms`,
          ],
          ['restart: recover ms', p(s.restart.recoverMs)],
          ['restart: host, screen, board ms', JSON.stringify(s.restart.host)],
          [
            'restart: state lost, timer hints after',
            `${s.restart.stateLost.length}, ${s.restart.timerHintsAfter}`,
          ],
        ]
      : []),
    ['finale at run s', String(s.finaleAtRunS ?? '—')],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`${k.padEnd(w)}  ${v}`);
  if (s.errors.length) console.log(`errors (first ${s.errors.length}):`, s.errors.slice(0, 5));
  if (args.criteria) {
    console.log(
      failed.length ? `FAIL (${args.criteria}): ${failed.join('; ')}` : `PASS (${args.criteria})`,
    );
  }
}

main().then(
  (code) => process.exit(code),
  async (err) => {
    console.error(err);
    ending = true;
    for (const s of sockets) s.disconnect();
    if (tookSeat) await releaseSeat().catch(() => undefined);
    process.exit(2);
  },
);
