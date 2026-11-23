// The load test's pure helpers (load-lib.mjs): node --test load-lib.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  pct,
  stats,
  wrongFor,
} from './load-lib.mjs';

test('pct: nearest rank, rounded to the ms, as upstream load-test.mjs', () => {
  assert.equal(pct([], 50), null);
  assert.equal(pct([5], 99), 5);
  const xs = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1, unsorted
  assert.equal(pct(xs, 50), 50);
  assert.equal(pct(xs, 95), 95);
  assert.equal(pct(xs, 99), 99);
  assert.equal(pct(xs, 100), 100);
  assert.equal(pct([1.4, 2.6], 100), 3);
  assert.equal(pct([10, 20, 30], 50), 20);
  assert.deepEqual(stats([3, 1, 2]), { n: 3, p50: 2, p95: 3, p99: 3, max: 3 });
});

test('botPlan: the same seed gives the same plan, another seed another one', () => {
  const opts = { actions: 50, thinkMs: [10_000, 40_000], wrong: 0.1, hint: 0.05, drop: 0.05 };
  assert.deepEqual(botPlan(7, opts), botPlan(7, opts));
  assert.notDeepEqual(botPlan(7, opts), botPlan(8, opts));
  const plan = botPlan(7, opts);
  assert.equal(plan.length, 50);
  for (const a of plan) {
    assert.ok(a.thinkMs >= 10_000 && a.thinkMs <= 40_000);
    assert.ok(['right', 'wrong', 'hint', 'drop'].includes(a.kind));
    assert.ok(a.pick >= 0 && a.pick < 1);
  }
});

test('botPlan: the rates hold over many actions', () => {
  const plan = botPlan(1, { actions: 20_000, thinkMs: [1, 2], wrong: 0.1, hint: 0.05, drop: 0.05 });
  const share = (k) => plan.filter((a) => a.kind === k).length / plan.length;
  assert.ok(Math.abs(share('wrong') - 0.1) < 0.01);
  assert.ok(Math.abs(share('hint') - 0.05) < 0.01);
  assert.ok(Math.abs(share('drop') - 0.05) < 0.01);
});

const content = {
  stages: [
    {
      locks: [
        { id: 'door', kind: 'code', answer: '0417' },
        { id: 'badge', kind: 'choice', correct: ['blue'] },
        { id: 'word', kind: 'phrase', answers: ['lights out', 'lights off'] },
      ],
    },
    {
      locks: [
        { id: 'dials', kind: 'sequence', order: ['gold', 'silver', 'bronze'] },
        {
          id: 'switch',
          kind: 'combined',
          parts: [
            { roleId: 'hacker', answer: 'falcon' },
            { roleId: 'lookout', answer: 'midnight' },
          ],
        },
      ],
    },
  ],
};

test('answerFor: code, phrase, choice and sequence locks', () => {
  assert.deepEqual(answerFor({ id: 'door', kind: 'code', solved: false }, null, content), {
    lockId: 'door',
    input: '0417',
  });
  assert.deepEqual(answerFor({ id: 'word', kind: 'phrase', solved: false }, null, content), {
    lockId: 'word',
    input: 'lights out',
  });
  assert.deepEqual(answerFor({ id: 'badge', kind: 'choice', solved: false }, null, content), {
    lockId: 'badge',
    input: ['blue'],
  });
  assert.deepEqual(answerFor({ id: 'dials', kind: 'sequence', solved: false }, null, content), {
    lockId: 'dials',
    input: ['gold', 'silver', 'bronze'],
  });
});

test('answerFor: a combined lock gives the role its own part, once', () => {
  const lock = {
    id: 'switch',
    kind: 'combined',
    solved: false,
    myParts: ['hacker', 'lookout'],
    partsDone: ['hacker'],
  };
  assert.deepEqual(answerFor(lock, 'lookout', content), {
    lockId: 'switch',
    roleId: 'lookout',
    input: 'midnight',
  });
  // Without a role: the first of its parts not yet in.
  assert.deepEqual(answerFor(lock, null, content), {
    lockId: 'switch',
    roleId: 'lookout',
    input: 'midnight',
  });
  // A part already in, or a role this phone does not hold: nothing to enter.
  assert.equal(answerFor(lock, 'hacker', content), null);
  assert.equal(answerFor({ ...lock, myParts: ['hacker'] }, 'lookout', content), null);
  assert.equal(answerFor({ ...lock, myParts: [], partsDone: [] }, null, content), null);
});

test('answerFor: a solved or unknown lock gives nothing', () => {
  assert.equal(answerFor({ id: 'door', kind: 'code', solved: true }, null, content), null);
  assert.equal(answerFor({ id: 'nope', kind: 'code', solved: false }, null, content), null);
});

test('wrongFor: an input of the right shape that does not open the lock', () => {
  const code = wrongFor({ id: 'door', kind: 'code', solved: false }, content);
  assert.equal(code.lockId, 'door');
  assert.equal(typeof code.input, 'string');
  assert.notEqual(code.input, '0417');
  assert.match(code.input, /^\d+$/);
  assert.notEqual(
    wrongFor({ id: 'word', kind: 'phrase', solved: false }, content).input,
    'lights out',
  );
  const choice = wrongFor(
    { id: 'badge', kind: 'choice', solved: false, options: [{ id: 'red' }, { id: 'blue' }] },
    content,
  );
  assert.deepEqual(choice.input, ['red']);
  const seq = wrongFor({ id: 'dials', kind: 'sequence', solved: false }, content);
  assert.deepEqual(seq.input, ['bronze', 'silver', 'gold']);
  // A combined lock: a wrong part for one of its roles.
  const part = wrongFor(
    { id: 'switch', kind: 'combined', solved: false, myParts: ['lookout'], partsDone: [] },
    content,
  );
  assert.equal(part.roleId, 'lookout');
  assert.notEqual(part.input, 'midnight');
  assert.match(part.input, /^\d+$/);
  assert.equal(wrongFor({ id: 'door', kind: 'code', solved: true }, content), null);
});

test('parsePs: ps -o %cpu=,rss= (macOS and Linux)', () => {
  assert.deepEqual(parsePs('  12.5 524288\n'), { cpu: 12.5, rssMb: 512 });
  assert.deepEqual(parsePs('103,4  1048576'), { cpu: 103.4, rssMb: 1024 });
  assert.equal(parsePs(''), null);
});

test('parseProcStat and cpuBetween: Linux /proc/<pid>/stat ticks, a delta per second', () => {
  // Fields 14/15 (utime, stime) and 24 (rss); a command name with spaces and a ')'.
  const line = (u, s) =>
    `4242 (node (main) x) S 1 4242 4242 0 -1 4194304 100 0 0 0 ${u} ${s} 0 0 20 0 11 0 500 1000000 131072 18446744073709551615`;
  assert.deepEqual(parseProcStat(line(300, 50)), { ticks: 350, rssPages: 131072 });
  assert.equal(parseProcStat('garbage'), null);
  const a = parseProcStat(line(300, 50));
  const b = parseProcStat(line(340, 60));
  // 50 ticks in 1 s at 100 ticks/s: half a core.
  assert.equal(cpuBetween(a, b, 1000), 50);
  assert.equal(cpuBetween(a, b, 2000, 100), 25);
});

test('maskUrl: no user or password in the output', () => {
  assert.equal(maskUrl('redis://:secret@redis.example:6379'), 'redis://***@redis.example:6379');
  assert.equal(maskUrl('postgres://u:p@db/x'), 'postgres://***@db/x');
  assert.equal(maskUrl('redis://localhost:16379'), 'redis://localhost:16379');
  assert.equal(maskUrl(undefined), undefined);
});

test('parseDockerStats: docker stats --format "{{.CPUPerc}};{{.MemUsage}}"', () => {
  assert.deepEqual(parseDockerStats('45.67%;512MiB / 1GiB'), { cpu: 45.67, rssMb: 512 });
  assert.deepEqual(parseDockerStats('0.00%;1.5GiB / 2GiB'), { cpu: 0, rssMb: 1536 });
  assert.deepEqual(parseDockerStats('99.1%;2048KiB / 1GiB'), { cpu: 99.1, rssMb: 2 });
  assert.deepEqual(parseDockerStats('5%;300MB / 1GB'), { cpu: 5, rssMb: 286 });
  assert.equal(parseDockerStats('--'), null);
});

test('classifyAck: expected refusals apart from unexpected ones', () => {
  assert.equal(classifyAck('right', { ok: true, outcome: 'lock-solved' }), 'ok');
  assert.equal(classifyAck('right', { ok: true, outcome: 'part-accepted' }), 'ok');
  assert.equal(classifyAck('right', { ok: true, outcome: 'escaped' }), 'ok');
  assert.equal(classifyAck('wrong', { ok: true, outcome: 'wrong' }), 'ok');
  // A right answer judged wrong, or a wrong one accepted: the server is wrong.
  assert.equal(classifyAck('right', { ok: true, outcome: 'wrong' }), 'unexpected');
  assert.equal(classifyAck('wrong', { ok: true, outcome: 'lock-solved' }), 'unexpected');
  // A teammate was quicker, the team waits, or its time is up: the game, not a fault.
  for (const reason of ['rate-limited', 'already-solved', 'escaped', 'time-up']) {
    assert.equal(classifyAck('right', { ok: false, reason }), 'expected', reason);
  }
  // Not running or paused: expected only while the run is being ended.
  for (const reason of ['not-running', 'paused']) {
    assert.equal(classifyAck('right', { ok: false, reason }), 'unexpected', reason);
    assert.equal(classifyAck('right', { ok: false, reason }, { ending: true }), 'expected', reason);
  }
  assert.equal(classifyAck('hint', { ok: true }), 'ok');
  assert.equal(classifyAck('hint', { ok: false, reason: 'no-hint' }), 'expected');
  for (const reason of ['not-joined', 'no-team', 'bad-input', 'not-your-part', 'unknown-lock']) {
    assert.equal(classifyAck('right', { ok: false, reason }), 'unexpected', reason);
  }
  assert.equal(classifyAck('right', undefined), 'unexpected');
});

test('criteriaFailed: the §1.2 thresholds, local and UK', () => {
  const good = {
    submitAckMs: { p95: 50, p99: 120 },
    lostAcks: 0,
    unexpected: 0,
    joinAckMs: { p95: 900 },
    boardIntervalMs: { p95: 1100 },
    hostFramesPerS: 2,
    readyMs: { p95: 20 },
    rssMb: { max: 400 },
    race: true,
  };
  assert.deepEqual(criteriaFailed(good, 'local'), []);
  const bad = { ...good, submitAckMs: { p95: 150, p99: 300 }, lostAcks: 1, hostFramesPerS: 40 };
  assert.deepEqual(criteriaFailed(bad, 'local').sort(), [
    'host frames/s ≤ 3',
    'lost acks = 0',
    'submit ack p95 ≤ 100 ms',
    'submit ack p99 ≤ 250 ms',
  ]);
  // A broken run fails, whatever its timings.
  const run = { players: 10, joined: 10, phonesStarted: 10, phonesFinale: 10, submits: 5 };
  assert.deepEqual(
    criteriaFailed({ ...good, ...run, reconnectFailed: 0, readyFailed: 0 }, 'local'),
    [],
  );
  assert.deepEqual(
    criteriaFailed(
      {
        ...good,
        players: 10,
        joined: 9,
        phonesStarted: 8,
        phonesFinale: 7,
        reconnectFailed: 1,
        readyFailed: 2,
        submits: 0,
      },
      'local',
    ).sort(),
    [
      '/health/ready failed = 0',
      'every phone got the finale',
      'every phone started',
      'every player joined',
      'reconnects failed = 0',
      'submits > 0',
    ],
  );
  // A restart run: health checks may fail meanwhile; every phone back within 30 s, nothing lost.
  const restart = {
    dropped: 10,
    recovered: 10,
    recoverFailed: 0,
    stateLost: [],
    fullRecoveryMs: 9000,
  };
  assert.deepEqual(criteriaFailed({ ...good, readyFailed: 3, restart }, 'local'), []);
  assert.deepEqual(
    criteriaFailed(
      { ...good, restart: { ...restart, recovered: 9, stateLost: [{}], fullRecoveryMs: 31_000 } },
      'local',
    ).sort(),
    ['every dropped phone back', 'full recovery ≤ 30 s', 'no team state lost'],
  );
  // UK: p95 ≤ 300 ms, no p99 limit.
  assert.deepEqual(criteriaFailed({ ...good, submitAckMs: { p95: 150, p99: 900 } }, 'uk'), []);
  // A hosted event has no board interval or host frame limit, and missing measures are skipped.
  assert.deepEqual(
    criteriaFailed(
      { ...good, race: false, boardIntervalMs: { p95: 5000 }, hostFramesPerS: 50, rssMb: null },
      'local',
    ),
    [],
  );
});
