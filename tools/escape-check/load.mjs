#!/usr/bin/env node
/**
 * Load test of a live escape room (M9 plan §1.2): one host, one screen, a race's
 * public board and N socket.io bots play a sample room on a running Live (Lost
 * Library in races, which take parallel rooms only; Vault Heist, with roles and a
 * combined lock, in a hosted event), through
 * the same events as the phones. Modelled on upstream's
 * apps/backend/scripts/load-test.mjs (same percentiles, CPU/RSS/Redis measures),
 * with a `ps` / `docker stats` sampler (macOS has no /proc).
 *
 *   node load.mjs --url http://localhost:3000 --scenario race-teams --players 500 \
 *     [--join-rate 10] [--burst] [--think 10-40] [--duration-min 12] [--teams 100] \
 *     [--server-pid <pid> | --container <name>] [--redis redis://localhost:16379] \
 *     [--host-cookie '<Live session cookie>'] [--cpu-cap '1 vCPU'] [--seed 1] \
 *     [--criteria local|uk] [--out result.json]
 *
 * Scenarios: `race-teams` (teams of up to 3 by team code, a scheduled start),
 * `race-solo` (one-player teams, a scheduled start), `hosted` (a hosted event,
 * `escape:teams` auto into `--teams` teams, started by the host).
 * The host is `x-local-user` under AUTH_MODE=none, or `--host-cookie` (REST and
 * the host socket) under OIDC. The answers come from the host's REST template
 * detail, never from a phone frame. Exits non-zero when a `--criteria` fails.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { Redis } from 'ioredis';
import { io } from 'socket.io-client';
import {
  answerFor,
  botPlan,
  classifyAck,
  criteriaFailed,
  parseDockerStats,
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
};
const note = (where, e) => {
  if (m.errors.length < 50)
    m.errors.push(`${where}: ${typeof e === 'string' ? e : JSON.stringify(e)}`);
};
const count = (bucket, key) => (bucket[key] = (bucket[key] ?? 0) + 1);

// ── Server-side samplers ──

const run = promisify(execFile);

/** CPU (% of one core) and RSS (MB) every second, from `ps` or `docker stats`, until stopped. */
function sampler() {
  if (!args['server-pid'] && !args.container) return () => null;
  let on = true;
  (async () => {
    while (on) {
      const at = Date.now();
      try {
        const s = args['server-pid']
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
    });
    s.on('exception', (e) => note(`bot${i} exception`, e));
    s.on('error', (e) => note(`bot${i} error`, e));
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
  else note(`bot${b.i} sync`, synced ?? 'lost');
  return true;
}

/** race-teams: every third bot starts a team; the next two join it by its code. */
async function formTeam(b, leader) {
  if (b === leader) {
    const ack = await ask(b.socket, 'escape:new-team', { pin: b.pin, name: `Team ${b.i}` });
    if (!ack?.ok) note(`bot${b.i} new-team`, ack ?? 'lost');
    else m.teamsJoined++;
    return ack?.ok ? ack.code : null;
  }
  const code = await leader.code;
  if (!code) return null;
  const ack = await ask(b.socket, 'escape:join-team', { pin: b.pin, code });
  if (!ack?.ok) note(`bot${b.i} join-team`, ack ?? 'lost');
  else m.teamsJoined++;
  return null;
}

async function reconnect(b) {
  b.socket.disconnect();
  sockets.delete(b.socket);
  await sleep(500);
  const t0 = t();
  const s = connect();
  b.socket = s;
  b.listen(s);
  try {
    await connected(s);
  } catch (e) {
    m.reconnectFailed++;
    note(`bot${b.i} reconnect`, e.message);
    return;
  }
  const re = await ask(s, 'player:reconnect', { sessionToken: b.token });
  const synced = re?.ok ? await ask(s, 'escape:sync', { pin: b.pin }) : undefined;
  if (synced?.ok) m.reconnectMs.push(t() - t0);
  else {
    m.reconnectFailed++;
    note(`bot${b.i} reconnect`, re ?? 'lost');
  }
}

const done = (b) =>
  b.finale ||
  b.state?.phase === 'finale' ||
  b.state?.team?.escaped ||
  b.state?.team?.timedOut ||
  stopAt < Date.now();
let stopAt = Infinity;

/** The bot's plan, one action per think time, until its team is out or the run ends. */
async function play(b) {
  for (const a of b.plan) {
    // A random first wait spreads the bots' first moves over a think time.
    await sleep(a.thinkMs);
    if (done(b)) {
      m.doneAt.push(t());
      return;
    }
    if (!b.socket.connected) continue;
    if (a.kind === 'drop') {
      await reconnect(b);
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
  const c = stale ? 'expected' : classifyAck(intended, ack);
  if (c === 'ok') m.acks.ok++;
  else count(m.acks[c], `${intended}:${ack.ok ? ack.outcome : ack.reason}`);
}

// ── The run ──

function machine() {
  const cpus = os.cpus();
  let commit = null;
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dirname(new URL(import.meta.url).pathname),
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
  };
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
  const tookSeat = await claimSeat();
  const tpl = await sampleTemplate(TEMPLATE);
  const content = tpl.content;
  const redis = args.redis ? new Redis(args.redis, { lazyConnect: true }) : null;
  if (redis) await redis.connect();
  const stopSampler = sampler();
  const stopReady = readyPoller();

  // Host: creates the room, syncs (host room), counts its frames.
  const host = connect({ host: true });
  host.onAny((event, ...payload) =>
    m.hostFrames.push({ at: t(), event, bytes: JSON.stringify(payload).length }),
  );
  host.on('exception', (e) => note('host exception', e));
  let hostFinale = false;
  host.on('escape:finale', () => (hostFinale = true));
  await connected(host);
  const createdAt = Date.now();
  const joinEstimateMs = (PLAYERS / JOIN_RATE) * 1000 * 1.2;
  const startsAt = createdAt + Math.max(RACE_LEAD_MS + 5_000, joinEstimateMs + 15_000);
  const durationMin = Math.max(5, Math.ceil(DURATION_MS / 60_000) + 5);
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

  // The big screen (the host's own projection) and, in a race, the public board.
  const screen = connect({ host: true });
  await connected(screen);
  await ask(screen, 'spectator:join', { pin });
  await ask(screen, 'escape:sync', { pin });
  const boardAt = [];
  if (RACE) {
    const board = connect();
    await connected(board);
    await ask(board, 'spectator:join', { pin, follow: true });
    await ask(board, 'escape:sync', { pin });
    board.on('escape:board', () => boardAt.push(t()));
  } else {
    screen.on('escape:board', () => boardAt.push(t()));
  }

  // Joins: paced at --join-rate, or (--burst) 50 at once.
  const bots = Array.from({ length: PLAYERS }, (_, i) => newBot(i, pin, content));
  const commandsBefore = redis ? await redisCommands(redis) : null;
  const joinT0 = t();
  const formed = [];
  const joinOne = async (b) => {
    const leader = bots[b.i - (b.i % 3)];
    if (!(await join(b))) {
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

  // Play until every team is out or --duration-min, then the finale.
  stopAt = Date.now() + DURATION_MS;
  const playing = Promise.all(joined.map(play));
  await Promise.race([playing, sleep(DURATION_MS + 60_000)]);
  const runT1 = t();
  if (!hostFinale) {
    const ended = await ask(host, 'escape:end', { pin });
    if (!ended?.ok) note('host end', ended ?? 'lost');
  }
  for (let k = 0; k < 40 && m.finaleAt.size < joined.length; k++) await sleep(250);
  const commandsAfter = redis ? await redisCommands(redis) : null;
  stopReady();
  const server = stopSampler();
  host.emit('host:end', { pin });
  await sleep(300);
  for (const s of sockets) s.disconnect();
  if (redis) redis.disconnect();
  if (tookSeat) await releaseSeat();

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
  let redisPerSubmit = null;
  let redisTop = null;
  if (commandsBefore) {
    const delta = Object.entries(commandsAfter)
      .map(([k, v]) => [k, v - (commandsBefore[k] ?? 0)])
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    const total = delta.reduce((s, [, v]) => s + v, 0);
    redisPerSubmit = m.submits ? Math.round(total / m.submits) : null;
    redisTop = Object.fromEntries(delta.slice(0, 10));
  }
  const unexpected = Object.values(m.acks.unexpected).reduce((s, n) => s + n, 0);
  const summary = {
    race: RACE,
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
    redisTopCommands: redisTop,
    errors: m.errors,
  };
  const failed = args.criteria ? criteriaFailed(summary, args.criteria) : [];
  const result = {
    setup: {
      startedAt,
      machine: machine(),
      cpuCap: args['cpu-cap'],
      scenario: args.scenario,
      options: { ...args, 'host-cookie': args['host-cookie'] ? '(set)' : undefined },
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
    ['host frames/s, KB/s', `${s.hostFramesPerS}, ${s.hostKbPerS}`],
    ...Object.entries(s.hostPerEvent).map(([e, v]) => [`  ${e}`, `${v.perS}/s, ${v.kbPerS} KB/s`]),
    ['/health/ready ms', `${p(s.readyMs)} (failed ${s.readyFailed})`],
    ['backend CPU %', p(s.cpuPct)],
    ['backend RSS MB', s.rssMb ? `${s.rssMb.start} → max ${s.rssMb.max}` : '—'],
    ['Redis commands/submit', String(s.redisCommandsPerSubmit ?? '—')],
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
  (err) => {
    console.error(err);
    for (const s of sockets) s.disconnect();
    process.exit(2);
  },
);
