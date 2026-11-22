#!/usr/bin/env node
/* global document, window, MutationObserver -- in page.evaluate, the page's own */
/**
 * Two phones play a Vault Heist run against the dev stack (M4, Task 4.19), with the
 * host driven by socket (no console until M5). It prints OK or FAIL per check, writes
 * screenshots to OUT, and lets the host seat go if it took it.
 *
 * Why not tools/live-check: that one runs in Docker on the demo stack, whose named
 * volumes live on the internal disk. This one uses the installed Chrome through
 * playwright-core (no browser download), and keeps its profiles and temp files on
 * the SSD (TMPDIR).
 *
 * Setup, once:
 *   source live/.envrc.local
 *   cd live/tools/escape-check && pnpm install --ignore-workspace --fetch-timeout=300000 --fetch-retries=6
 * The dev stack: `docker compose up -d postgres redis` in live/, then the backend
 * (`pnpm --filter @quiz-dock/backend start:dev`, DATABASE_URL and REDIS_URL at the
 * compose ports, AUTH_MODE=none) and the frontend (`pnpm --filter @quiz-dock/frontend
 * dev`, VITE_API_URL at the backend).
 * Run:
 *   node live/tools/escape-check/two-phones.mjs
 * Environment: URL (the Vite address, default http://localhost:5173), OUT (screenshots,
 * default <repo>/.tmp/escape-check), HEADED=1 to watch.
 *
 * Steps: the host adds the samples and publishes Vault Heist, opens a run; two phones
 * (390x780) join by PIN, a socket bot in a second team; start; phone A opens the staff door, phone B
 * the badge lock (the unlock moment on both); each phone enters its own parts of the
 * combined lock; B asks a hint; the host adds 2 min; A reloads and comes back; the
 * team escapes (the host opens the dials); finale, room closed, B reloads onto it.
 * All along, both phones' received WebSocket frames (CDP) and page text are recorded,
 * and none may hold the host's events or an answer of the template.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { io } from 'socket.io-client';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const URL = process.env.URL ?? 'http://localhost:5173';
const OUT = process.env.OUT ?? `${REPO}/.tmp/escape-check`;
// Chrome's throwaway profiles go under TMPDIR: keep them on the SSD.
process.env.TMPDIR ??= `${REPO}/.tmp`;
mkdirSync(OUT, { recursive: true });
mkdirSync(process.env.TMPDIR, { recursive: true });

const HOST = 'Mei';
const PHONE = { width: 390, height: 780 };
const TEMPLATE = 'Vault Heist';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const problems = [];
const check = (ok, what) => {
  log(ok ? 'OK  ' : 'FAIL', what);
  if (!ok) problems.push(what);
  return ok;
};

async function api(method, path, body) {
  const res = await fetch(`${URL}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-local-user': HOST },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** Every answer a phone must never be sent: codes, phrases, combined parts. */
function answersOf(content) {
  const out = new Set();
  for (const stage of content.stages) {
    for (const lock of stage.locks) {
      if (lock.kind === 'code') out.add(lock.answer);
      if (lock.kind === 'phrase') lock.answers.forEach((a) => out.add(a));
      if (lock.kind === 'combined') lock.parts.forEach((p) => out.add(p.answer));
    }
  }
  return [...out];
}

let n = 0;
async function shot(page, name) {
  await sleep(300);
  const file = `${OUT}/${String(++n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  log('shot', file);
}

/** Records what the page's polite region says, every announcement in turn. */
function recordAnnouncements() {
  window.__said = [];
  const seen = new WeakSet();
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('[role="status"][aria-live="polite"] span')) {
      if (seen.has(el) || !el.textContent) continue;
      seen.add(el);
      window.__said.push(el.textContent);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

async function newPhone(browser, name) {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'en-US',
    reducedMotion: 'no-preference',
  });
  await context.addInitScript(recordAnnouncements);
  const page = await context.newPage();
  const frames = [];
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', (e) => frames.push(e.response.payloadData));
  const texts = [];
  page.on('pageerror', (err) => log(`[${name}] page error:`, err.message));
  return { name, context, page, frames, texts };
}

/** The page's text as it stands, kept for the no-secrets check at the end. */
async function keepText(phone) {
  phone.texts.push(await phone.page.evaluate(() => document.body.innerText));
}

const said = (page) => page.evaluate(() => window.__said ?? []);
async function waitSaid(page, re, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const all = await said(page);
    const hit = all.find((s) => re.test(s));
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}

/** The team timer's seconds left, as the phone shows them. */
async function timerS(page) {
  const text = await page.locator('[role="timer"] span[aria-hidden]').last().textContent();
  const parts = text.trim().split(':').map(Number);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

const visible = (locator, timeout = 10_000) =>
  locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);

/** The lock card titled `label`. */
const lockCard = (page, label) =>
  page.locator('article').filter({ has: page.getByRole('heading', { name: label }) });

async function openCode(page, label, answer) {
  const card = lockCard(page, label);
  await card.getByRole('textbox').fill(answer);
  await card.getByRole('button', { name: 'Open', exact: true }).click();
}

async function openChoice(page, label, optionLabels) {
  const card = lockCard(page, label);
  for (const o of optionLabels) await card.getByRole('button', { name: o }).click();
  await card.getByRole('button', { name: 'Open', exact: true }).click();
}

/** Waits for the unlock moment, photographs it, taps it away. */
async function unlockMoment(phone, re, photo) {
  const overlay = phone.page.getByTestId('unlock-moment');
  const shown = await visible(overlay.filter({ hasText: re }), 8000);
  if (shown && photo) await shot(phone.page, photo);
  if (shown) await overlay.click().catch(() => undefined);
  return shown;
}

let seatTaken = false;
let host = null;
let bot = null;
let pin = '';
let browser = null;

async function main() {
  // ── 1. Host by socket: the seat, the template, the run ──
  await api('POST', '/auth/host-seat/claim', { expiresInMinutes: null })
    .then(() => (seatTaken = true))
    .catch((err) => {
      if (!String(err).includes('already_host')) throw err;
    });
  const added = await api('POST', '/escape-templates/samples');
  let tpl = added.find((t) => t.title === TEMPLATE);
  if (!tpl) {
    const row = (await api('GET', '/escape-templates')).find((t) => t.title === TEMPLATE);
    if (!row) throw new Error(`${TEMPLATE} not found among the host's templates`);
    tpl = await api('GET', `/escape-templates/${row.id}`);
  }
  if (tpl.status !== 'published') tpl = await api('POST', `/escape-templates/${tpl.id}/publish`);
  const content = tpl.content;
  const answers = answersOf(content);
  const [lobby, security, vault, getaway] = content.stages;
  const lockOf = (stage, id) => stage.locks.find((l) => l.id === id);
  const roleName = Object.fromEntries(content.roles.map((r) => [r.id, r.name]));
  check(answers.length >= 6, `${TEMPLATE} published, ${answers.length} answers known`);

  host = io(`${URL}/game`, {
    transports: ['websocket'],
    auth: { localUser: HOST },
    forceNew: true,
  });
  await new Promise((ok, ko) => {
    host.once('connect', ok);
    host.once('connect_error', ko);
  });
  // The host console's latest view: teams, members, their ids.
  let hostState = null;
  host.on('escape:host', (st) => (hostState = st));
  const emit = async (event, payload) => {
    const ack = await host.timeout(10_000).emitWithAck(event, payload);
    if (ack && ack.ok === false) throw new Error(`${event}: ${JSON.stringify(ack)}`);
    return ack;
  };
  const created = await emit('escape:create', {
    templateId: tpl.id,
    durationMin: 60,
  });
  pin = created.pin;
  check(/^\d{6}$/.test(pin), `run opened on PIN ${pin}`);
  // Joins the host's escape rooms: escape:outline and escape:host from now on.
  await emit('escape:sync', { pin });

  // ── 2. Two phones join by PIN ──
  browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADED !== '1',
    downloadsPath: `${OUT}/downloads`,
  });
  const a = await newPhone(browser, 'A');
  const b = await newPhone(browser, 'B');
  const phones = [a, b];
  for (const [phone, nickname] of [
    [a, 'Ana'],
    [b, 'Ben'],
  ]) {
    await phone.page.goto(`${URL}/join/${pin}`);
    await phone.page.getByLabel(/Nickname/).fill(nickname);
    await phone.page.getByRole('button', { name: 'Join the lobby', exact: true }).click();
    phone.nickname = nickname;
  }
  for (const p of phones) {
    check(
      await visible(p.page.getByText('Waiting for the host to form teams')),
      `${p.name}: lobby says it waits for teams`,
    );
  }
  await shot(a.page, 'a-lobby');

  // ── 3. The phones' team, start: stage, role cards, timers ──
  // A third player (a bare socket) in a team of its own keeps the run going once the
  // phones' team escapes: with every team out, the server goes straight to the finale
  // and the escaped screen would not be seen.
  bot = io(`${URL}/game`, { transports: ['websocket'], forceNew: true });
  await bot.timeout(10_000).emitWithAck('player:join', { pin, nickname: 'Bot', presence: 'room' });
  await emit('escape:teams', { pin, mode: 'auto', count: 2 });
  await sleep(500);
  const [first, second] = hostState.teams;
  for (const t of hostState.teams) {
    for (const m of t.members) {
      const want = m.nickname === 'Bot' ? second.id : first.id;
      if (t.id !== want) await emit('escape:move', { pin, playerId: m.playerId, teamId: want });
    }
  }
  await sleep(500);
  const phoneTeam = hostState.teams.find((t) => t.id === first.id);
  check(
    phoneTeam.members
      .map((m) => m.nickname)
      .sort()
      .join() === 'Ana,Ben',
    `Ana and Ben in "${phoneTeam.name}", Bot in "${second.name}"`,
  );
  for (const p of phones) {
    check(await visible(p.page.getByText('Your team')), `${p.name}: lobby shows its team`);
  }
  await shot(b.page, 'b-team');
  await emit('escape:start', { pin });
  const rolesOf = {};
  for (const p of phones) {
    check(
      await visible(p.page.getByRole('heading', { name: lobby.title })),
      `${p.name}: stage "${lobby.title}" shows`,
    );
    const card = p.page.locator('details').filter({ hasText: 'Your role' });
    await card.waitFor();
    rolesOf[p.name] = await card.locator('dt').allTextContents();
    const t1 = await timerS(p.page);
    await sleep(2100);
    const t2 = await timerS(p.page);
    check(t1 > 3500 && t2 < t1, `${p.name}: timer runs (${t1}s then ${t2}s)`);
    await keepText(p);
  }
  check(
    rolesOf.A.length > 0 && rolesOf.B.length > 0 && rolesOf.A.every((r) => !rolesOf.B.includes(r)),
    `role cards differ: A ${rolesOf.A.join('+')}, B ${rolesOf.B.join('+')}`,
  );
  await shot(a.page, 'a-stage1');
  await shot(b.page, 'b-stage1');

  // ── 4. Phone A opens the code lock ──
  const door = lockOf(lobby, 'lobby-door');
  await openCode(a.page, door.label, door.answer);
  for (const p of phones) {
    check(
      await visible(lockCard(p.page, door.label).getByText('Opened')),
      `${p.name}: "${door.label}" shows opened`,
    );
  }
  const byA = await waitSaid(b.page, new RegExp(`^Ana opened ${door.label}`));
  check(!!byA, `B's polite region: "${byA ?? 'nothing about Ana'}"`);
  await shot(b.page, 'b-door-opened');

  // ── Phone B opens the choice lock: the stage clears, the unlock moment on both ──
  const badge = lockOf(lobby, 'lobby-badge');
  await openChoice(
    b.page,
    badge.label,
    badge.correct.map((id) => badge.options.find((o) => o.id === id).label),
  );
  const moments = await Promise.all([
    unlockMoment(a, /Stage 2 unlocked/, 'a-unlock-stage2'),
    unlockMoment(b, /Stage 2 unlocked/),
  ]);
  check(moments[0] && moments[1], 'both phones show the unlock moment (stage 2)');
  for (const p of phones) {
    check(
      await visible(p.page.getByRole('heading', { name: security.title })),
      `${p.name}: stage "${security.title}" shows`,
    );
    await keepText(p);
  }

  // ── 5. Combined lock: each phone enters its own parts ──
  const sw = lockOf(security, 'security-switch');
  const partsOf = {};
  for (const p of phones) {
    const card = lockCard(p.page, sw.label);
    const labels = await card
      .getByRole('textbox')
      .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    partsOf[p.name] = labels;
  }
  const allParts = [...partsOf.A, ...partsOf.B];
  check(
    allParts.length === sw.parts.length && new Set(allParts).size === allParts.length,
    `combined parts split: A ${partsOf.A.join(', ')} / B ${partsOf.B.join(', ')}`,
  );
  const answerFor = (label) =>
    sw.parts.find((part) => `${roleName[part.roleId]} part` === label)?.answer ?? '';
  // A enters all its parts, then B: the lock opens on B's last part.
  for (const p of phones) {
    for (const label of partsOf[p.name]) {
      const card = lockCard(p.page, sw.label);
      const input = card.getByLabel(label, { exact: true });
      await input.fill(answerFor(label));
      await input
        .locator('xpath=ancestor::form[1]')
        .getByRole('button', { name: 'Open', exact: true })
        .click();
      if (p === a) {
        check(
          await visible(card.getByText(`${label.replace(/ part$/, '')}: entered`)),
          `A: "${label}" entered`,
        );
      }
    }
    if (p === a) {
      const heard = await waitSaid(b.page, new RegExp(`^Ana entered the .* part of ${sw.label}`));
      check(!!heard, `B hears A's part: "${heard ?? 'nothing'}"`);
      await shot(b.page, 'b-combined-waiting');
    }
  }
  for (const p of phones) {
    check(
      await visible(lockCard(p.page, sw.label).getByText('Opened')),
      `${p.name}: combined "${sw.label}" opens after the last part`,
    );
  }
  const phrase = lockOf(security, 'security-override');
  await openCode(a.page, phrase.label, phrase.answers[0]);
  const moments2 = await Promise.all([
    unlockMoment(a, /Stage 3 unlocked/),
    unlockMoment(b, /Stage 3 unlocked/, 'b-unlock-stage3'),
  ]);
  check(moments2[0] && moments2[1], 'both phones show the unlock moment (stage 3)');
  for (const p of phones) {
    check(
      await visible(p.page.getByRole('heading', { name: vault.title })),
      `${p.name}: stage "${vault.title}" shows`,
    );
    await keepText(p);
  }

  // ── 6. Phone B asks a hint ──
  const hint = vault.hints.find((h) => h.releaseAfterS === null) ?? vault.hints[0];
  await b.page.getByRole('button', { name: /^Hint/ }).click();
  const dialog = b.page.getByRole('dialog');
  check(
    await visible(dialog.getByText(`This hint adds ${hint.penaltyS} s to your team's time.`)),
    `B: the confirm says +${hint.penaltyS} s`,
  );
  await shot(b.page, 'b-hint-confirm');
  await dialog.getByRole('button', { name: 'Get the hint' }).click();
  for (const p of phones) {
    check(await visible(p.page.getByText(hint.text)), `${p.name}: the hint shows`);
    check(
      await visible(p.page.getByText(/^Hints: \+/)),
      `${p.name}: the hint total ("Hints: +…") shows`,
    );
    await keepText(p);
  }
  await shot(a.page, 'a-hint');

  // ── 7. The host adds 2 min: both timers jump ──
  const before = await Promise.all(phones.map((p) => timerS(p.page)));
  await emit('escape:adjust-time', { pin, deltaS: 120 });
  await sleep(1500);
  const after = await Promise.all(phones.map((p) => timerS(p.page)));
  phones.forEach((p, i) => {
    const jump = after[i] - before[i];
    check(jump >= 110 && jump <= 125, `${p.name}: timer jumps by about 2 min (${jump}s)`);
  });

  // ── 8. Phone A reloads: the same stage and team, no nickname form ──
  const teamName = await a.page.locator('header span.truncate.text-right').textContent();
  await a.page.reload();
  check(
    await visible(a.page.getByRole('heading', { name: vault.title }), 15_000),
    `A after reload: stage "${vault.title}" again`,
  );
  check(
    (await a.page.locator('header span.truncate.text-right').textContent()) === teamName,
    `A after reload: team "${teamName}"`,
  );
  check((await a.page.getByLabel(/Nickname/).count()) === 0, 'A after reload: no nickname form');
  check(await visible(a.page.getByText(hint.text)), 'A after reload: the hint is still there');
  await shot(a.page, 'a-reloaded');
  await keepText(a);

  // ── The way out: the host opens the dials, A the keypad, then the getaway ──
  const teamId = first.id;
  await emit('escape:unlock', { pin, teamId, lockId: 'vault-dials' });
  const keypad = lockOf(vault, 'vault-keypad');
  await visible(lockCard(a.page, keypad.label));
  await openCode(a.page, keypad.label, keypad.answer);
  await Promise.all(phones.map((p) => unlockMoment(p, /Stage 4 unlocked/)));
  for (const p of phones) await visible(p.page.getByRole('heading', { name: getaway.title }));
  const van = lockOf(getaway, 'getaway-van');
  const exits = lockOf(getaway, 'getaway-exits');
  await openCode(a.page, van.label, van.answers[0]);
  await visible(lockCard(b.page, van.label).getByText('Opened'));
  await openChoice(
    b.page,
    exits.label,
    exits.correct.map((id) => exits.options.find((o) => o.id === id).label),
  );
  const escapedMoments = await Promise.all([
    unlockMoment(a, /You escaped!/, 'a-escaped-moment'),
    unlockMoment(b, /You escaped!/),
  ]);
  check(escapedMoments[0] && escapedMoments[1], 'both phones show the escape moment');
  for (const p of phones) {
    check(
      await visible(p.page.getByRole('heading', { name: 'You escaped!' })),
      `${p.name}: escaped screen`,
    );
    check(
      await visible(p.page.getByText(/escaped in \d+:\d\d/)),
      `${p.name}: escaped screen shows the team's time`,
    );
    await keepText(p);
  }
  await shot(b.page, 'b-escaped');

  // ── 9. Finale, room closed, B reloads onto the finale ──
  await emit('escape:finale', { pin });
  for (const p of phones) {
    check(
      await visible(p.page.getByRole('list', { name: 'Ranking' })),
      `${p.name}: finale ranking shows`,
    );
  }
  await shot(a.page, 'a-finale');
  // host:end has no ack.
  host.emit('host:end', { pin });
  for (const p of phones) {
    check(
      await visible(p.page.getByText('The room is closed')),
      `${p.name}: finale says the room is closed`,
    );
    await keepText(p);
  }
  await shot(a.page, 'a-closed');
  await b.page.reload();
  check(
    await visible(b.page.getByRole('list', { name: 'Ranking' }), 15_000),
    'B after reload: the finale still shows (results by token)',
  );
  check(
    await visible(b.page.getByText('Your team')),
    'B after reload: its team is marked in the ranking',
  );
  await shot(b.page, 'b-finale-reloaded');
  await keepText(b);

  // ── 10. No secrets in the phones' frames or text ──
  const hostOnly = ['escape:outline', 'escape:host', 'escape:host-team'];
  const keys = ['"answer"', '"answers"', '"correct"', '"order"', '"parts"'];
  for (const p of phones) {
    const frames = p.frames.join('\n');
    check(p.frames.length > 20, `${p.name}: ${p.frames.length} frames recorded`);
    const events = hostOnly.filter((e) => frames.includes(`"${e}"`));
    check(!events.length, `${p.name}: no host events in frames (${events.join(', ') || 'none'})`);
    const leaked = answers.filter((ans) => frames.includes(ans));
    check(!leaked.length, `${p.name}: no answer in frames (${leaked.join(', ') || 'none'})`);
    const keyHits = keys.filter((k) => frames.includes(k));
    check(
      !keyHits.length,
      `${p.name}: no answer fields in frames (${keyHits.join(' ') || 'none'})`,
    );
    const text = p.texts.join('\n');
    const shown = answers.filter((ans) => text.includes(ans));
    check(!shown.length, `${p.name}: no answer in page text (${shown.join(', ') || 'none'})`);
  }
}

let crashed = null;
try {
  await main();
} catch (err) {
  crashed = err;
  log('FAIL', 'run stopped:', err?.stack ?? err);
}
// The stack as found: the room ended, the seat let go if this run took it.
if (host?.connected && pin) {
  host.emit('host:end', { pin });
  await sleep(500);
}
host?.close();
bot?.close();
await browser?.close();
if (seatTaken) await api('POST', '/auth/host-seat/release').catch(() => undefined);
if (crashed || problems.length) {
  log(`FAIL: ${problems.length} check(s) failed${crashed ? ', and the run stopped' : ''}`);
  problems.forEach((p) => log('  -', p));
  process.exit(1);
}
log(`OK: every check passed; screenshots in ${OUT}`);
