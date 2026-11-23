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
  5 minutes past that, so time-up never ends a run first.

**Measures** (summary on stdout, everything in the `--out` JSON):

- join, sync, submit (also per outcome), hint and reconnect acks (ms);
- lost acks (none within 10 s) and refusals, split into expected (the game's
  rules: a teammate was quicker, the team waits, time is up) and unexpected;
- team-update fan-out: a submit to its teammates' `escape:team-update`;
- start and finale spread across phones;
- board interval (race: the public board; hosted: the screen), while at least
  half the bots still play (a board with nothing new is not sent);
- host frames and KB per second, per event, between the start and the end;
- `/health/ready` latency every second (an event-loop proxy);
- backend CPU and RSS every second: `--server-pid` (`ps`, macOS and Linux) or
  `--container` (`docker stats`);
- Redis commands per submit: the `INFO commandstats` delta from the first join
  to the finale, over the submits (joins, syncs, ticks and boards included).

`--criteria local|uk` checks the plan's pass criteria and exits non-zero on a
failure; `node --test tools/escape-check/load-lib.test.mjs` tests the helpers.

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
  --out "$TMPDIR/escape-load/race-teams.json"
```

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

- The engine holds 500 players with room to spare on this machine: no lost ack,
  no unexpected refusal, every phone started and got the finale within 160 ms
  of the first, `/health/ready` p95 at most 16 ms, CPU p95 at most 39 % of one core.
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
