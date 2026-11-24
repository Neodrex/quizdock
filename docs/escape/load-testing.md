# Load testing a live escape room

How many phones one Live process holds in an escape room, measured with
`tools/escape-check/load.mjs`. It sits beside upstream's quiz load test
(`docs/dev/load-testing.md`, `apps/backend/scripts/load-test.mjs`), uses the same
percentiles and the same CPU, RSS and Redis measures, and adds what an escape
room needs: teams, locks, hints, reconnects, the host console, the big screen and
a race's public board. Plan: M9 (`docs/plans/2026-11-23-live-escape-m9-deploy.md`
§1.2 in the outer repo).

## 1. What it does

One host socket, one big-screen socket (the host's own projection), in a race
the public board socket (`/race/<PIN>`, a follow copy), and N phone bots, all
over WebSocket from one Node process.

| Scenario | Room | Players | How teams form | Start |
|---|---|---|---|---|
| `race-teams` | Lost Library | 500 | every third bot `escape:new-team`, the next two `escape:join-team` by its code: about 167 teams of 3 | scheduled, one minute or more after the create |
| `race-solo` | Lost Library | 500 | none: 500 one-player teams, the worst case for the board and the host state | scheduled |
| `hosted` | Vault Heist (roles, a combined lock) | 500 | the host's `escape:teams` `{ mode: 'auto', count: 100 }`: 100 teams of 5 | the host's `escape:start` |

Races accept parallel rooms only (M7 `SESSION_RULES`), hence Lost Library; the
hosted event plays the roles sample, whose bots enter only their own role's part
of the combined lock (the lock's `myParts`).

- **Joins** at `--join-rate` (10/s: 500 in about 50 s), or `--burst` (50 at once).
- **Play:** each bot follows a seeded plan (`botPlan`): after a think time drawn
  from `--think` (10–40 s), it opens one of its stage's open locks (90 %), gives
  a wrong answer (10 %), asks the hint it was offered (5 %) or drops its socket and
  comes back with its session token (5 %). The answers come from the host's REST
  template detail, never from a phone frame. A bot stops when its team is out.
- **End:** when every team is out the run ends by itself (T4); otherwise the host
  sends `escape:end` after `--duration-min` (12). The room's time limit is set
  5 minutes past that, so time-up never ends a run first. The play loops stop
  once the run is being ended.
- **`--sustain`** (a steady load, for the restart test): the room's time limit is
  `--duration-min` and the run ends at time-up, with its finale, not by the host.
  A bot whose team is out keeps its think-time rhythm with what a finished phone
  still does: a resync (`escape:sync`, as a reload) or a drop and reconnect. The
  locks stay with the teams still playing, so the submit rate falls as teams
  escape; the reads, ticks and boards go on to the end.
- **A dropped socket** (the server went away, as in a restart) comes back on its
  own, for 90 s, with socket.io-client's own backoff (1 s doubling to 5 s, ± half
  at random, so a crowd does not come back in step): a new socket,
  `player:reconnect` with the session token, `escape:sync`. Phones, host, screen
  and board alike; a planned drop whose reconnect finds the server away does
  the same before it counts as failed.
  The JSON's `restart` block gives the phones dropped and back, each one's
  time back, the full recovery (first drop to last phone back), the host's,
  screen's and board's times, teams whose progress went backwards (stage, locks
  solved, out) and the timer hints after the drop. `.tmp/escape-load/restart.sh`
  (outer repo) kills the backend with `SIGKILL` and starts it again.

**Measures** (summary on stdout, everything in the `--out` JSON):

- join, sync, submit (also per outcome), hint and reconnect acks (ms);
- lost acks (none within 10 s) and refusals, split into expected (the game's
  rules: a teammate was quicker, the team waits, time is up; "not running" and
  "paused" only once the run is being ended) and unexpected (a refused or lost
  sync, team create or team join counts too);
- team-update fan-out: a submit to its teammates' `escape:team-update`;
- start and finale spread across phones;
- board interval (race: the public board; hosted: the screen), while at least
  half the bots still play (a board with nothing new is not sent);
- host frames and KB per second, per event, between the start and the end (KB:
  the payloads' JSON length, an approximation of the frames);
- `/health/ready` latency every second (an event-loop proxy);
- backend CPU and RSS every second: `--server-pid` (`ps` on macOS; on Linux the
  `/proc/<pid>/stat` CPU ticks' delta, since `ps %cpu` there is a lifetime
  average) or `--container` (`docker stats`);
- Redis commands per submit: the `INFO commandstats` delta from the run's start
  to the finale, over the run's submits (syncs, ticks and boards included); and,
  as the first baseline counted it, from the first join (`…WithJoins`).

`--criteria local|uk` checks the plan's pass criteria and exits non-zero on a
failure. A broken run fails whatever its timings: a player not joined, a phone
without its start or its finale, a failed reconnect or `/health/ready`, no
submit; in a restart run, a phone not back, a team's progress lost, or a full
recovery over 30 s (its health checks fail meanwhile, so they are not counted).
The host-frames limit (≤ 3/s in a race) applies from Task 9.3 on.
`node --test tools/escape-check/load-lib.test.mjs` tests the helpers. The JSON
names the backend measured (`--backend-commit`, else this checkout, `+changes`
when the backend has uncommitted changes) and hides any password in a URL.

## 2. Running it

```bash
# Dev stack (Postgres, Redis), nothing else heavy running (no Jest, no builds,
# no local Supabase stack: on an 8 GB Mac it makes the machine swap).
cd live && docker compose up -d postgres redis
pnpm --filter @quiz-dock/contracts build && pnpm --filter @quiz-dock/backend build

# The backend, freshly started for each run, in production mode.
source tools/escape-check/devenv.sh   # AUTH_MODE=none, static Dev licence (cap 500)
cd apps/backend && NODE_ENV=production node dist/main.js &   # add --cpu-prof for a profile

# The bots (from live/tools/escape-check).
node load.mjs --url http://localhost:3000 --scenario race-teams --players 500 \
  --server-pid <backend pid> --redis redis://localhost:16379 --criteria local \
  --out "/Volumes/Crucial X9/Projects/claude-escape-room/.tmp/escape-load/race-teams.json"
```

Output goes to the outer repo's `.tmp/escape-load/` (on the SSD), never to the
system temp directory; the runs kept for this page are copied to
`docs/escape/load-results/`. `.tmp/escape-load/measure.sh <name> <scenario>`
(outer repo) does one run on a freshly started backend and stops it.

Under OIDC, `--host-cookie '<Live session cookie>'` signs the host's REST calls
and sockets in. `--container <name>` samples a Docker container instead of a pid.

## 3. Results

### Before any fix (2026-11-23)

**Setup**

| | |
|---|---|
| Machine | Mac mini, Apple M1 (4 performance + 4 efficiency cores), 8 GB RAM, macOS 26 (Darwin 25.6), external SSD |
| Code | Live `1aab3fc` (backend), load tool `1c5d734` |
| Backend | `nest build`, `node dist/main.js`, Node 24.22, `NODE_ENV=production`, `AUTH_MODE=none`, static Dev licence; native, **no CPU cap** (macOS cannot pin a process to a core); restarted for each run |
| Postgres, Redis | the dev compose stack in OrbStack: Postgres 16.14, Redis 7.4.9, defaults |
| Bots | `load.mjs` on the same machine, loopback, WebSocket; joins at 10/s; think 10–40 s; seed 1 |

Figures are comparable within this plan, not with upstream's tables (a pinned
Xeon core there, an unpinned M1 here).

| | race-teams | race-solo | hosted |
|---|--:|--:|--:|
| Teams | 167 | 500 | 100 |
| Run (start to finale), s | 150 | 418 | 179 |
| Submits | 1289 | 3919 | 1093 |
| Join ack p95 (ms) | 21 | 20 | 28 |
| Submit ack p50 / p95 / p99 (ms) | 8 / 21 / 55 | 26 / **109** / 156 | 10 / 34 / 54 |
| Lost acks, unexpected refusals | 0, 0 | 0, 0 | 0, 0 |
| Team-update fan-out p95 (ms) | 21 | — (solo) | 34 |
| Hint ack p95 (ms) | 18 | 119 | 24 |
| Reconnect p95 (ms) | 52 | 171 | 67 |
| Start spread p95 (ms) | 70 | 82 | 46 |
| Finale spread p95 (ms) | 35 | 32 | 48 |
| Board interval p50 / p95 (ms) | 1027 / 1046 | 1067 / 1106 | 110 / 242 |
| Host frames/s, KB/s | **24.2**, 78.7 | **26.1**, 140.7 | 21.6, 243.1 |
| `/health/ready` p95 (ms) | 10 | 15 | 16 |
| Backend CPU p50 / p95 (% of one core) | 8 / 21 | 13 / 39 | 10 / 24 |
| RSS start → max (MB) | 305 → 424 | 304 → 474 | 300 → 413 |
| Redis commands per submit | 49 | 31 | 51 |
| Local criteria | FAIL: host frames | FAIL: submit p95, host frames | PASS |

**Host frames per event** (frames/s, KB/s, KB per frame):

| Event | race-teams | race-solo | hosted |
|---|---|---|---|
| `escape:host-team` | 9.2, 8.4, 0.9 | 9.9, 6.4, 0.6 | 6.6, 8.2, 1.2 |
| `escape:team-update` | 9.2, 1.1, 0.1 | 9.9, 1.1, 0.1 | 6.6, 0.8, 0.1 |
| `escape:announce` | 3.9, 0.3, 0.1 | 4.1, 0.3, 0.1 | 2.7, 0.2, 0.1 |
| `escape:board` | 0.7, 5.7, 8.1 | 0.7, 5.8, 8.0 | 4.2, 110.9, 26.5 |
| `escape:host` | 0.4, 62.9, 169 | 0.4, 126.6, 351 | 0.8, 122.8, 158 |

**Reading**

- On this machine, with the backend native and uncapped (an M1 core, which the
  §1.2 local criteria, written for 1 vCPU, do not assume), the engine holds 500
  players: no lost ack, no unexpected refusal, start spread p95 at most 82 ms
  and finale spread p95 at most 48 ms, `/health/ready` p95 at most 16 ms, CPU
  p95 at most 39 % of one core. Capped runs come with the rehearsal (Task 9.10).
- **The host console is the hot spot of a race.** `escape:host-team` is not
  throttled in races (one frame per team change), and `escape:team-update` and
  `escape:announce` reach the host room as well: about 24 frames/s in total
  against the 3/s criterion. Throttling `escape:host-team` alone (Task 9.3) leaves
  about 13/s of team-updates and announces; the criterion needs those coalesced
  too, or counted apart.
- **The host state is large:** 169 KB per `escape:host` with 167 teams, 351 KB
  with 500 solo teams, at 0.4/s in races. In the hosted event the board also
  goes out 4.2 times a second (its period outside races is 100 ms) at 26 KB a frame.
- **race-solo is the worst case:** with 500 teams, submit ack p95 reaches 109 ms
  (criterion 100 ms) and reconnects 171 ms. Every submit builds a full `viewOf`
  (every team parsed, every player read, the PIN room's sockets fetched twice)
  and the throttled board and host state build summaries of all 500 teams.
- Bots stop when their team escapes, so a run lasts as long as the room takes:
  2.5 to 7 minutes at 10–40 s think time, about 9 submits/s at its busiest.
  The 12 minutes are a cap; a fifth of the think time is the stress pass.
- Only the default pace ran here: the burst join and the stress pass come with
  the after-fix runs (Task 9.5).
- The first board interval after the start is up to 10 s long (the max): no bot
  moves before its first think time, so nothing changes on the board.

**Profile** (`race-teams` again with `node --cpu-prof`, 231 s sampled from the
backend's start to its stop, 88 % idle; the profile stays in `.tmp/escape-load/`):

| Self time | Where |
|--:|---|
| 1.9 s | `membersOf` (`escape-payloads.ts`): a `Map` of **every** player built for each team, so a host state costs teams × players |
| 1.8 s | `writev` (socket writes) |
| 1.5 s + 0.6 s | `GameService.players` (`HGETALL` of the room's players and a `JSON.parse` each), per `viewOf` |
| 1.3 s | `EscapeStore.teams` (`HGETALL` of the teams and a zod parse of every team record), per `viewOf` |
| 1.2 s | ioredis replies (Redis: 21 `HGETALL`s and 10 `GET`s per submit) |
| 0.5 s | socket.io in-memory adapter `apply` (room fan-out, and `fetchSockets` of the PIN room) |

Inclusive: the throttled board and host state (`boardNow` → `emitHeld`, with
`boardOf`, `teamSummaryOf`, `placesOf`, `hostStateOf`, `hostTeamOf`) about 2.6 s;
`viewOf` reads (teams, players, sockets) about 2.2 s; joins (`playerJoin`) 1.2 s.

### After Task 9.3: the host console in races (2026-11-23)

Same set-up as the baseline (native backend, no CPU cap, restarted for each
run; load tool `6a79bec`), backend `faa1176`. In a race the host room now gets
its team updates and changed teams as one `escape:host-batch` per board period
(1 s); `escape:host-team`, `escape:team-update` and `escape:announce` no longer
reach it one by one (phones still get theirs at once; group play and hosted
events are unchanged).

| | race-teams | race-solo | hosted |
|---|--:|--:|--:|
| Submit ack p50 / p95 / p99 (ms) | 15 / 31 / 51 | 14 / **49** / 81 | 13 / 37 / 45 |
| Host frames/s, KB/s | **2.57**, 66.3 | **2.83**, 135.0 | 20.6, 230.1 (unchanged) |
| of which `escape:*` | 1.72 | 1.81 | 19.85 |
| Backend CPU p50 / p95 | 14 / 25 | 17 / 36 | 17 / 33 |
| Local criteria | PASS | PASS | PASS |

The host frames left in a race are `escape:board` (0.7/s), `escape:host-batch`
(0.7/s), `escape:host` (0.35/s) and upstream's `player:joined` and
`player:left` (0.4–0.5/s each, the bots' reconnect churn). race-solo's submit
p95 fell from 109 to 49 ms with the host's frames.

### Task 9.4: measured hot spots

A `race-solo` profile after 9.3 (`node --cpu-prof`, 497 s sampled, 70.7 s
busy) ranked the candidates by share of the backend's busy CPU:

| Candidate | Busy CPU | Decision |
|---|--:|---|
| **A/B** `membersOf` + `recOf` (teams × players in every host state and board) | 16 % self (11.6 s) | fixed: `perf(escape): payloads index a view's players and teams once` (`cc0faaa`) |
| **B** `EscapeStore.teams` (`JSON.parse` + zod of every team, per `viewOf`) | 24 % incl. (17.3 s) | fixed: `perf(escape): team records parsed once per stored JSON` (`3758df4`) |
| **B** `GameService.players` (`HGETALL` + `JSON.parse`, per `viewOf`) | 6 % incl. (4.5 s) | under 10 %, upstream file: left |
| **C** `fetchSockets` of the PIN room (in-memory adapter) | 6 % incl. (4.6 s) | under 10 %: left (a team-room version was written, then dropped) |
| **D** the tick's team parse | inside B's figure; B's cache serves it too | — |
| **E** upstream join fan-out (`playerJoin` 1.4 s, 2 %) | 2 % | not hot: no upstream edit, nothing to ask |

Neither fix was needed for a §1.2 criterion at the default pace after 9.3;
both exceeded 10 % of the busy CPU. Each A/B ran `race-solo` at the stress pace
(`--think 2-8`, 3919 submits in 85 s), alternating A B, B A, A B on a freshly
started backend (as upstream's `bench.sh ab`):

**Payload index** (A `faa1176`, B `cc0faaa`):

| Run | Submit ack p50 / p95 / p99 (ms) | CPU p50 / p95 | `/health/ready` p95 |
|---|---|---|--:|
| 1 A | 9 / 42 / 67 | 20 / 52 | 13 |
| 2 B | 13 / 55 / 95 | 18 / 63 | 12 |
| 3 B | 14 / 71 / 125 | 17 / 66 | 7 |
| 4 A | 16 / 110 / 208 | 19 / 71 | 18 |
| 5 A | 11 / 60 / 85 | 19 / 64 | 20 |
| 6 B | 11 / 35 / 76 | 18 / 56 | 9 |
| mean A / B | 12 / 71 / 120 vs 13 / 54 / 99 | 19.3 / 62 vs 17.7 / 62 | 17 vs 9 |

The end-to-end figures are within this machine's noise; the payloads
themselves, timed alone on a 500-team solo race view
(`.tmp/escape-load/bench/host-state.cjs`, 50 calls each): `hostStateOf` 28 ms →
0.5 ms, `boardOf` 9 ms → 0.16 ms, each a block of the event loop.

**Team parse cache** (A `cc0faaa`, B `3758df4`):

| Run | Submit ack p50 / p95 / p99 (ms) | CPU p50 / p95 | `/health/ready` p95 |
|---|---|---|--:|
| 1 A | 11 / 39 / 65 | 18 / 61 | 12 |
| 2 B | 10 / 32 / 44 | 17 / 48 | 7 |
| 3 B | 9 / 29 / 50 | 16 / 47 | 20 |
| 4 A | 10 / 48 / 128 | 18 / 54 | 16 |
| 5 A | 10 / 42 / 75 | 19 / 54 | 8 |
| 6 B | 7 / 21 / 39 | 16 / 37 | 8 |
| mean A / B | 10 / 43 / 89 vs 9 / 27 / 44 | 18.3 / 56 vs 16.3 / 44 | 12 vs 12 |

### After the fixes (Task 9.5, 2026-11-23)

Backend `3758df4`; load tool `2a748f1` for the restart run, `0b3e2e7` for its
control, `6a79bec` for the others (same measures); same machine and set-up,
native and uncapped.
macOS's `mediaanalysisd` (up to 1.9 cores) and another session's `ffmpeg`
(5 cores) ran during part of the evening: the hosted, stress race-teams and
restart runs that overlapped `ffmpeg` were discarded and run again once it had
stopped; `mediaanalysisd` came and went and could not be stopped.

**Default pace** (think 10–40 s, joins 10/s):

| | race-teams | race-solo | hosted |
|---|--:|--:|--:|
| Teams | 167 | 500 | 100 |
| Run (start to finale), s | 150 | 418 | 187 |
| Submits | 1291 | 3919 | 1094 |
| Join ack p95 (ms) | 22 | 23 | 47 |
| Submit ack p50 / p95 / p99 (ms) | 15 / 27 / 36 | 8 / **17** / 67 | 15 / 27 / 106 |
| Lost acks, unexpected refusals | 0, 0 | 0, 0 | 0, 0 |
| Team-update fan-out p95 (ms) | 27 | — (solo) | 27 |
| Hint ack p95 (ms) | 23 | 17 | 26 |
| Reconnect p95 (ms) | 48 | 36 | 48 |
| Start spread p95 (ms) | 17 | 22 | 22 |
| Finale spread p95 (ms) | 19 | 46 | 54 |
| Board interval p50 / p95 (ms) | 1012 / 1021 | 1008 / 1016 | 110 / 244 |
| Host frames/s, KB/s (all; `escape:*`) | **2.65** (1.80), 72.4 | **2.96** (1.93), 157.2 | 20.7, 228.7 |
| `/health/ready` p95 (ms) | 7 | 8 | 9 |
| Backend CPU p50 / p95 (% of one core) | 12 / 24 | 7 / 18 | 11 / 22 |
| RSS start → max (MB) | 296 → 518 | 300 → 461 | 308 → 466 |
| Redis commands per submit (play; with joins) | 23; 49 | 23; 31 | 27; 50 |
| Local criteria | PASS | PASS | PASS |

**Stress pace** (think 2–8 s) and the **burst join** (50 at once):

| | race-teams stress | race-solo stress | hosted stress | race-teams burst |
|---|--:|--:|--:|--:|
| Run, s; submits | 31; 1296 | 85; 3919 | 36; 1097 | 150; 1291 |
| Join ack p95 (ms) | 31 | 31 | 30 | **267** |
| Submit ack p50 / p95 / p99 (ms) | 7 / 21 / 99 | 11 / 67 / 223 | 12 / 62 / 93 | 9 / 30 / 81 |
| Lost acks, unexpected refusals | 0, 0 | 0, 0 | 0, 0 | 0, 0 |
| Reconnect p95 (ms) | 35 | 139 | 126 | 98 |
| Start / finale spread p95 (ms) | 13 / 13 | 63 / 20 | 28 / 111 | 30 / 34 |
| Board interval p50 / p95 (ms) | 1005 / 2456 (n 18) | 1007 / 1012 | 104 / 113 | 1007 / 1020 |
| Host frames/s (all; `escape:*`), KB/s | 6.45 (2.3), 113.8 | 7.38 (2.35), 216.7 | 91.6 (87.9), 799.3 | 2.64 (1.8), 68.8 |
| `/health/ready` p95 (ms) | 12 | 9 | 14 | 12 |
| Backend CPU p50 / p95 | 15 / 30 | 12 / 54 | 12 / 49 | 1 / 19 |
| RSS max (MB) | 445 | 457 | 335 | 373 |
| Local criteria | FAIL: board p95, host frames | FAIL: host frames | PASS | PASS |

**Restart during a race** (`race-teams`, `--sustain`, think 200–400 s so that
teams stay on their stages, 15 minutes; `.tmp/escape-load/restart.sh` killed the
backend with `SIGKILL` 300 s into the run and listening again 5 s later):

| | |
|---|---|
| Phones dropped, back | 500, 500 (none failed) |
| Time back per phone p50 / p95 / max | 7.7 / 11.0 / 12.7 s |
| Full recovery (first drop to last phone back) | **12.8 s** (criterion 30 s) |
| Host, screen, board back | 8.6, 9.9, 6.0 s |
| Teams whose progress went back (stage, locks, out) | 0 |
| Timer hints after the restart | 48 (the tickers came back) |
| Finale | at time-up, 901 s into the run, to all 500 phones (spread p95 16 ms) |
| Submit ack p50 / p95 / p99 (ms) | before the kill 9 / 18 / 39 (220); the minute after 9 / 29 / 467 (133); later 12 / 32 / 111 (708); no lost ack |
| `/health/ready` p95 (ms) | 7 (5 failures while the backend was down) |
| The same run without the restart (control) | submit ack 15 / 32 / 160, `/health/ready` p95 7, finale at 901 s |

The board interval criterion fails in these two runs by design of the pace:
with 200–400 s think time the board often has nothing new for seconds, and an
unchanged board is not sent. An earlier restart run (discarded, kept in
`.tmp/escape-load/discarded/`) gave the same recovery (500/500 in 11.6 s, no
progress lost, 51 timer hints) but a submit p95 of 226 ms over the whole run,
while `mediaanalysisd` was busy; the run above, with the acks split around the
drop, shows the restart itself adds only a short tail in the following minute.

**Reading**

- **Every §1.2 local criterion passes at the default pace in all three
  scenarios**, and the host console of a race gets 2.65–2.96 frames a second,
  1.8–1.9 of them escape frames (24–26 before).
- **The burst join** (50 at once) passes: join ack p95 267 ms.
- **A restart costs the room about 12 seconds**: every phone, the console, the
  screen and the board came back with their session tokens, no team lost a
  lock, the tickers resumed (timed hints), and the run ended at time-up with
  its finale.
- **At the stress pace, a race's host gets 6.5–7.4 frames a second, of which
  only 2.3 are escape frames**: the rest are upstream's `player:joined` and
  `player:left` (2–2.5/s each), one per reconnect, which the 5 % drop rate makes
  frequent at a fifth of the think time. Coalescing them needs an edit to
  upstream's `game.gateway.ts` (outside §1.3): an owner decision. At the
  default pace they are 0.8–1.0/s and the total stays under 3.
- **The stress race-teams board interval p95 (2.4 s) is the start**: 18
  intervals in a 31 s run, the longest being the first, before any bot's first
  move (as in the baseline). The board criterion is meant for a run of some
  length; at the default pace it is 1.02 s.
- **Hosted events were unchanged by design here**: their console got 20.7
  frames a second at the default pace and 92 (800 KB/s) at the stress pace,
  with the board every 100 ms (4–6/s). The owner then asked for the same
  coalescing as races (below).
- The first hosted run of this series stalled during its joins (24 joins and
  the host's `escape:teams` lost, then 500 sockets dropped) while another
  process held five cores and the machine swapped; the bots' retry each second
  then made a storm of `player:reconnect` (each fanned out to every socket as
  `player:joined`, RSS 1.5 GB). The bots now back off as socket.io-client does
  (`0b3e2e7`), the run was discarded, and its rerun passes (above).

### After the Batch 2 fix round: hosted events coalesced (2026-11-24)

Owner decision: a hosted event's console gets its host frames held like a
race's (`9c2aba7`). Team updates and details go out in one `escape:host-batch`
at most every `hostEveryMs` (1 s, a race board's period), with the host state
and the board on the same host lane. The screens keep their 100 ms board. A
host command's result still reaches the console before its ack. Group play is
unchanged. The same round fixed the order of held news (`6d7e201`: news that
came while a flush read its view used to overtake the older news, and a failed
flush dropped it) and sends what is held before `escape:finale`.

Backend `351169b`, load tool `7a10dae`, the same machine and set-up (native,
uncapped, freshly started, local Supabase stopped). macOS's `mediaanalysisd`
(about 1.2 cores) ran during the runs. They waited until another session's
video render had stopped.

| hosted, 500 players | default before | default after | stress before | stress after |
|---|--:|--:|--:|--:|
| Run, s; submits | 187; 1094 | 187; 1096 | 36; 1097 | 37; 1094 |
| Submit ack p50 / p95 / p99 (ms) | 15 / 27 / 106 | 11 / 19 / 54 | 12 / 62 / 93 | 7 / 19 / 35 |
| Lost acks, unexpected refusals | 0, 0 | 0, 0 | 0, 0 | 0, 0 |
| Team-update fan-out p95 (ms) | 27 | 18 | 61 | 19 |
| Board interval p50 / p95 (ms, the screen) | 110 / 244 | 107 / 255 | 104 / 113 | 104 / 107 |
| **Host frames/s (all; `escape:*`), KB/s** | 20.7 (20.0), 228.7 | **2.09** (1.35), 65.9 | 91.6 (87.9), 799.3 | **5.5** (1.67), 113.9 |
| `/health/ready` p95 (ms) | 9 | 9 | 14 | 5 |
| Backend CPU p50 / p95 | 11 / 22 | 9 / 20 | 12 / 49 | 11 / 31 |
| RSS max (MB) | 466 | 456 | 335 | 447 |
| Local criteria | PASS | PASS | PASS | PASS |

Host frames per event, after (frames/s): default `escape:host-batch` 0.66,
`escape:host` 0.34, `escape:board` 0.35, upstream `player:joined`/`player:left`
0.37 each; stress `escape:host-batch` 0.82, `escape:host` 0.66,
`escape:board` 0.19, `player:joined`/`player:left` 1.89 each.

- **The hosted console now gets 2.1 frames a second at the default pace (20.7
  before) and 5.5 at the stress pace (92 before).** Escape frames are 1.35 and
  1.67 a second. The rest of the stress figure is upstream's `player:joined`
  and `player:left`, one per reconnect, as in races (accepted, §0).
- The screens' board is unchanged (p95 255 / 107 ms). Submit acks did not get
  slower; the lower figures are within this machine's run-to-run noise.
- The checks `two-phones`, `host-console` (now also checking that a hosted
  console gets `escape:host-batch` and no per-change frames), `big-screen` and
  `sessions` pass.
- Raw JSON: `load-results/2026-11-24-fix-hosted.json`,
  `load-results/2026-11-24-fix-stress-hosted.json`. The A/B JSON files of Task
  9.4 now name their backends by commit (they had the dist folders).


### Prod-like rehearsal, container capped at 1 vCPU (Task 9.10, 2026-11-24)

The production compose stack (`deploy/` in the outer repo) on the Mac mini M1
8 GB: the Live image (`d63626e`) capped at `cpus: 1`, behind a local Traefik v3
with TLS (`https://live.escapeguild.localhost:8443`), `AUTH_MODE=oidc` with a
signed-in host (`--host-cookie`; the bots join an open-access room), our own
Postgres 16 and Redis 7.4 containers. Unlike the runs above, the local Supabase
stack and the Site container stayed up (Live's sign-in and host sync need
them), so the machine was shared. `race-teams`, 500 players, `--duration-min 6`
(all teams escaped; finale 129 s into the run). Raw:
`load-results/2026-11-24-rehearsal-race-teams-capped.json`.

| race-teams, 500, default pace | rehearsal (capped, TLS, OIDC) |
|---|--:|
| Join ack p95 (ms) | 33 |
| Submit ack p50 / p95 / p99 (ms) | 7 / **206** / **726** |
| Lost acks, unexpected refusals | 0, 0 |
| Start / finale spread p95 (ms) | 36 / 39 |
| Board interval p95 (ms) | 1244 |
| Host frames/s (escape) | 2.65 (1.80) |
| `/health/ready` p95 (ms) | 23 |
| Backend CPU p95, RSS max | 28 %, 346 MB |
| Local criteria | FAIL: submit p95 ≤ 100, p99 ≤ 250 |

The backend's CPU stayed at 28 % (p95) of its one-core quota, so the slow tail
is the shared 8 GB machine (Supabase's containers, the Site, Traefik's TLS and
500 bots on the same cores), not the cap: the uncapped native runs above met
the criteria with Supabase stopped. Everything else passed. The UK run (Task
9.16) on the server's own core is the measure that counts.

The load tool needed two fixes for OIDC: no host-seat claim with
`--host-cookie` (the seat exists in local mode only), and the room is created
with `participantAccess: 'open'` so the bots join as guests.
