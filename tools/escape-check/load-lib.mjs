/**
 * The escape load test's pure helpers (load.mjs): percentiles as upstream's
 * apps/backend/scripts/load-test.mjs, a bot's seeded plan, the input a phone
 * enters for a lock, the CPU/RSS sampler's parsing, the ack classes and the
 * pass criteria of the M9 plan §1.2. Tested by load-lib.test.mjs (node --test).
 */

/** p-th percentile (0..100) of `xs`, rounded to the ms; null when empty (upstream's). */
export function pct(xs, p) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
}

export const stats = (xs) => ({
  n: xs.length,
  p50: pct(xs, 50),
  p95: pct(xs, 95),
  p99: pct(xs, 99),
  max: pct(xs, 100),
});

/** A seeded PRNG (mulberry32): the same seed, the same numbers. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A bot's actions, in order: each waits `thinkMs` (drawn from `thinkMs` [min, max]),
 * then is a right answer, a wrong one, a hint asked, or a dropped socket (then a
 * reconnect with its session token). `pick` (0..1) chooses among the open locks.
 */
export function botPlan(seed, { actions, thinkMs: [min, max], wrong, hint, drop }) {
  const r = rng(seed);
  return Array.from({ length: actions }, () => {
    const thinkMs = Math.round(min + r() * (max - min));
    const x = r();
    const kind =
      x < wrong ? 'wrong' : x < wrong + hint ? 'hint' : x < wrong + hint + drop ? 'drop' : 'right';
    return { thinkMs, kind, pick: r() };
  });
}

/** The template's lock `id` (the host's REST content, answers included). */
function templateLock(content, id) {
  for (const stage of content.stages) {
    const lock = stage.locks.find((l) => l.id === id);
    if (lock) return lock;
  }
  return null;
}

/**
 * The combined lock's part this phone enters: `roleId` when it holds it and it
 * is not in yet; without a role, the first of its parts not yet in. Null: none.
 */
function partRole(lock, roleId) {
  const mine = (lock.myParts ?? []).filter((r) => !(lock.partsDone ?? []).includes(r));
  if (roleId) return mine.includes(roleId) ? roleId : null;
  return mine[0] ?? null;
}

/**
 * What a phone enters to open `lock` (its EscapePlayerLockView), from the
 * template's answers: `{ lockId, input, roleId? }`, or null when it has nothing
 * to enter (solved, unknown, or a combined lock with none of its parts left).
 */
export function answerFor(lock, roleId, content) {
  if (lock.solved) return null;
  const tpl = templateLock(content, lock.id);
  if (!tpl) return null;
  switch (tpl.kind) {
    case 'code':
      return { lockId: lock.id, input: tpl.answer };
    case 'phrase':
      return { lockId: lock.id, input: tpl.answers[0] };
    case 'choice':
      return { lockId: lock.id, input: [...tpl.correct] };
    case 'sequence':
      return { lockId: lock.id, input: [...tpl.order] };
    case 'combined': {
      const role = partRole(lock, roleId);
      const part = role && tpl.parts.find((p) => p.roleId === role);
      return part ? { lockId: lock.id, roleId: role, input: part.answer } : null;
    }
    default:
      return null;
  }
}

/** An input of the lock's shape that does not open it; null for a solved or unknown lock. */
export function wrongFor(lock, content) {
  if (lock.solved) return null;
  const tpl = templateLock(content, lock.id);
  if (!tpl) return null;
  const otherDigits = (answer) => (answer === '9999' ? '1111' : '9999');
  switch (tpl.kind) {
    case 'code':
      return { lockId: lock.id, input: otherDigits(tpl.answer) };
    case 'phrase':
      return { lockId: lock.id, input: 'not the answer' };
    case 'choice': {
      const other = (lock.options ?? []).map((o) => o.id).find((id) => !tpl.correct.includes(id));
      return other ? { lockId: lock.id, input: [other] } : null;
    }
    case 'sequence':
      return { lockId: lock.id, input: [...tpl.order].reverse() };
    case 'combined': {
      const role = partRole(lock, null);
      const part = role && tpl.parts.find((p) => p.roleId === role);
      return part ? { lockId: lock.id, roleId: role, input: otherDigits(part.answer) } : null;
    }
    default:
      return null;
  }
}

/** `ps -o %cpu=,rss= -p <pid>`: CPU (% of one core) and RSS (MB); null when the process is gone. */
export function parsePs(text) {
  const m = /^\s*([\d.,]+)\s+(\d+)/.exec(text);
  if (!m) return null;
  return { cpu: Number(m[1].replace(',', '.')), rssMb: Math.round(Number(m[2]) / 1024) };
}

/**
 * Linux `/proc/<pid>/stat`: the CPU time used so far (utime + stime, in clock
 * ticks) and the RSS (pages). `ps %cpu` there is a lifetime average, so the
 * sampler takes the ticks' delta per second. Null when unreadable.
 */
export function parseProcStat(text) {
  // The command name (field 2) may hold spaces and parentheses: fields start after the last ')'.
  const rest = text
    .slice(text.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  // rest[0] is field 3 (state): utime is field 14, stime 15, rss 24.
  const [utime, stime, rss] = [rest[11], rest[12], rest[21]].map(Number);
  if (![utime, stime, rss].every(Number.isFinite)) return null;
  return { ticks: utime + stime, rssPages: rss };
}

/** CPU (% of one core) between two parseProcStat readings `ms` apart. */
export function cpuBetween(before, after, ms, ticksPerS = 100) {
  return +((100 * (after.ticks - before.ticks)) / ticksPerS / (ms / 1000)).toFixed(1);
}

/** A URL or connection string with its user and password hidden (for the output JSON). */
export function maskUrl(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/(\/\/)[^/@\s]+@/g, '$1***@');
}

const UNIT_MB = {
  B: 1 / 1024 / 1024,
  KIB: 1 / 1024,
  MIB: 1,
  GIB: 1024,
  KB: 1000 / 1024 / 1024,
  MB: 1e6 / 1024 / 1024,
  GB: 1e9 / 1024 / 1024,
};

/** `docker stats --no-stream --format '{{.CPUPerc}};{{.MemUsage}}'`: CPU % and memory used (MB). */
export function parseDockerStats(line) {
  const m = /^\s*([\d.]+)%;\s*([\d.]+)\s*([a-z]+)/i.exec(line);
  if (!m) return null;
  const unit = UNIT_MB[m[3].toUpperCase()];
  if (unit === undefined) return null;
  return { cpu: Number(m[1]), rssMb: Math.round(Number(m[2]) * unit) };
}

/** Refusals the game gives a fair bot: a teammate was quicker, the team waits, or time is up. */
const EXPECTED_REFUSALS = new Set(['rate-limited', 'already-solved', 'escaped', 'time-up']);
/** The run is over or held: expected only once the run is ending (nobody pauses a load run). */
const ENDING_REFUSALS = new Set(['not-running', 'paused']);

/**
 * An ack against what the bot meant (`right`, `wrong` or `hint`): 'ok', an
 * 'expected' refusal (the game's rules), or 'unexpected' (a fault to report).
 * `ending`: the run is being ended (time is up or the host ends it).
 */
export function classifyAck(intended, ack, { ending = false } = {}) {
  if (!ack || typeof ack !== 'object') return 'unexpected';
  if (ack.ok) {
    if (intended === 'hint') return 'ok';
    if (intended === 'wrong') return ack.outcome === 'wrong' ? 'ok' : 'unexpected';
    return ack.outcome === 'wrong' ? 'unexpected' : 'ok';
  }
  if (intended === 'hint' && ack.reason === 'no-hint') return 'expected';
  if (ending && ENDING_REFUSALS.has(ack.reason)) return 'expected';
  return EXPECTED_REFUSALS.has(ack.reason) ? 'expected' : 'unexpected';
}

/** The pass criteria (plan §1.2), per where the run was made. */
const CRITERIA = {
  local: { submitP95: 100, submitP99: 250, joinP95: 1500, boardP95: 1300, readyP95: 100 },
  uk: { submitP95: 300, submitP99: null, joinP95: 2000, boardP95: 1500, readyP95: 300 },
};

/**
 * The criteria a run's summary fails, as readable labels ([] when it passes).
 * A measure the run did not take (null) is skipped; the board and host frame
 * limits apply to races only (`summary.race`), the host frame limit from Task
 * 9.3 on. A broken run fails whatever its timings: a player not joined, a phone
 * without its start or its finale, a failed reconnect or health check, no submit.
 */
export function criteriaFailed(summary, where) {
  const c = CRITERIA[where];
  if (!c) throw new Error(`unknown criteria: ${where}`);
  const out = [];
  const over = (value, limit, label) => {
    if (value !== null && value !== undefined && limit !== null && value > limit) out.push(label);
  };
  const s = summary;
  if (s.players !== undefined && s.joined !== s.players) out.push('every player joined');
  if (s.phonesStarted !== undefined && s.phonesStarted !== s.joined)
    out.push('every phone started');
  if (s.phonesFinale !== undefined && s.phonesFinale !== s.joined)
    out.push('every phone got the finale');
  if (s.reconnectFailed > 0) out.push('reconnects failed = 0');
  // A restart run: every phone back within 30 s, nothing lost (its health checks fail meanwhile).
  if (s.restart) {
    const r = s.restart;
    if (r.recovered !== r.dropped || r.recoverFailed > 0) out.push('every dropped phone back');
    if (r.stateLost?.length) out.push('no team state lost');
    over(r.fullRecoveryMs, 30_000, 'full recovery ≤ 30 s');
  } else if (s.readyFailed > 0) out.push('/health/ready failed = 0');
  if (s.submits !== undefined && !(s.submits > 0)) out.push('submits > 0');
  over(summary.submitAckMs?.p95, c.submitP95, `submit ack p95 ≤ ${c.submitP95} ms`);
  over(summary.submitAckMs?.p99, c.submitP99, `submit ack p99 ≤ ${c.submitP99} ms`);
  if (summary.lostAcks > 0) out.push('lost acks = 0');
  if (summary.unexpected > 0) out.push('unexpected refusals = 0');
  over(summary.joinAckMs?.p95, c.joinP95, `join ack p95 ≤ ${c.joinP95} ms`);
  if (summary.race) {
    over(summary.boardIntervalMs?.p95, c.boardP95, `board interval p95 ≤ ${c.boardP95} ms`);
    over(summary.hostFramesPerS, 3, 'host frames/s ≤ 3');
  }
  over(summary.readyMs?.p95, c.readyP95, `/health/ready p95 ≤ ${c.readyP95} ms`);
  over(summary.rssMb?.max, 1024, 'RSS ≤ 1 GB');
  return out;
}
