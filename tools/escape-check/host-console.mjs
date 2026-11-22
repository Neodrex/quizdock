#!/usr/bin/env node
/* global document -- in page.evaluate, the page's own */
/**
 * The host console runs a Vault Heist session against the dev stack (M5, Task 5.19):
 * the console in Chrome picks the room and opens it, two phones and two socket bots
 * join, the console forms the teams, moves a player, starts, gives a hint, adds and
 * takes time, pauses, opens a lock, reloads, leaves and comes back, ends the run and
 * downloads the CSV, then runs the room again. It prints OK or FAIL per check, writes
 * screenshots to OUT/host-<viewport>-*.png, and lets the host seat go if it took it.
 *
 * Setup and servers: as two-phones.mjs (devenv.sh, compose postgres/redis, backend
 * start:dev with AUTH_MODE=none, frontend dev). The host grace (GAME_HOST_GRACE_MS,
 * 5 s by default) must stay under HOST_GONE_MS (default 8 s).
 * Run (after `source live/tools/escape-check/devenv.sh`):
 *   node tools/escape-check/host-console.mjs                  # laptop, 1280x800
 *   VIEWPORT=tablet node tools/escape-check/host-console.mjs  # tablet, 820x1180, touch
 * Environment: URL, OUT, HEADED=1 as two-phones.mjs; HOST_GONE_MS.
 *
 * No answers to the console: every WebSocket frame the console receives (CDP) and
 * its page text are checked for the template's answer values, as whole words and
 * case-sensitive (a clue body may quote one in other words or case: clue bodies are
 * the host's to see, plan §1.4). The phones' frames may hold no host event.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import {
  answersOf,
  check,
  claimSeat,
  clockS,
  HOST,
  joinPhone,
  keepText,
  lockCard,
  log,
  newPhone,
  openChoice,
  openCode,
  OUT,
  problems,
  recordAnnouncements,
  recordFrames,
  releaseSeat,
  shot as shotIn,
  sleep,
  TEMPLATE,
  until,
  URL,
  api,
  vaultHeistTemplate,
  visible,
} from './lib.mjs';

const TABLET = process.env.VIEWPORT === 'tablet';
const VIEWPORT = TABLET ? 'tablet' : 'laptop';
const SIZE = TABLET ? { width: 820, height: 1180 } : { width: 1280, height: 800 };
const HOST_GONE_MS = Number(process.env.HOST_GONE_MS ?? 8000);
const shot = (page, name) => shotIn(page, name, `host-${VIEWPORT}-`);

/** Whole-word, case-sensitive hits of `answers` in `text`. */
const leaksIn = (text, answers) =>
  answers.filter((a) =>
    new RegExp(`(?<![0-9A-Za-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`).test(
      text,
    ),
  );

const consoleFrames = [];
const consoleTexts = [];
let consoleCtx = null;
let cpage = null;

async function openConsole(browser, path) {
  consoleCtx = await browser.newContext({
    viewport: SIZE,
    hasTouch: TABLET,
    locale: 'en-US',
    acceptDownloads: true,
  });
  await consoleCtx.addInitScript((name) => localStorage.setItem('live.localUser', name), HOST);
  await consoleCtx.addInitScript(recordAnnouncements);
  cpage = await consoleCtx.newPage();
  await recordFrames(consoleCtx, cpage, consoleFrames);
  cpage.on('pageerror', (err) => log('[console] page error:', err.message));
  if (path) await cpage.goto(`${URL}${path}`);
  return cpage;
}

const keepConsoleText = async () =>
  consoleTexts.push(await cpage.evaluate(() => document.body.innerText));

/** The board's columns while forming: name and nicknames. */
const boardLayout = () =>
  cpage.locator('section[data-board-column]').evaluateAll((cols) =>
    cols.map((c) => ({
      name: c.querySelector('h3')?.textContent ?? '',
      players: [...c.querySelectorAll('li span.truncate.font-medium')].map((s) => s.textContent),
    })),
  );

const column = (name) =>
  cpage
    .locator('section[data-board-column]')
    .filter({ has: cpage.getByRole('heading', { name, exact: true }) });

/** "Move to…" menu: `nickname` to the team `team`. */
async function moveByMenu(nickname, team) {
  const opener = cpage.getByRole('button', { name: `Move ${nickname} to…` });
  // The menu closes on any scroll: bring the chip to the middle of the window first.
  await opener.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await sleep(200);
  await opener.click();
  await cpage.getByRole('menuitem', { name: team, exact: true }).click({ timeout: 5000 });
}

/** A touch drag (CDP touch events) of `nickname`'s grip onto the column `team`. */
async function moveByTouch(nickname, team) {
  const grip = cpage.getByRole('button', { name: `Drag ${nickname}` });
  const target = column(team);
  await grip.scrollIntoViewIfNeeded();
  const a = await grip.boundingBox();
  const b = await target.boundingBox();
  const p0 = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const p1 = { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 60) };
  const cdp = await consoleCtx.newCDPSession(cpage);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p0] });
  await sleep(400);
  for (let i = 1; i <= 12; i++) {
    const p = { x: p0.x + ((p1.x - p0.x) * i) / 12, y: p0.y + ((p1.y - p0.y) * i) / 12 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
    await sleep(40);
  }
  await sleep(200);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** The live grid's row (laptop) or card (tablet) of a team. */
const teamCell = (id) => cpage.locator(`[data-team="${id}"]`).first();
const timeLeftS = async (id) => clockS(await teamCell(id).locator('.font-mono').textContent());

/** The team detail: an aside on a laptop, a sheet (dialog) on a tablet. */
const detail = (name) =>
  TABLET ? cpage.getByRole('dialog', { name }) : cpage.getByRole('complementary', { name });

async function selectTeam(id, name) {
  await cpage.locator(`button[data-team-card="${id}"]`).first().click();
  await detail(name).waitFor();
}

/** Tablet: the sheet covers the grid; close it to use the action bar. */
async function closeDetail() {
  if (TABLET && (await cpage.getByRole('dialog').count())) {
    await cpage.keyboard.press('Escape');
    await cpage
      .getByRole('dialog')
      .waitFor({ state: 'hidden' })
      .catch(() => undefined);
  }
}

const feedItems = () =>
  cpage
    .getByRole('list', { name: /Activity/ })
    .getByRole('listitem')
    .allTextContents();

let seatTaken = false;
let pin = '';
let browser = null;
const bots = [];
const phonesAll = [];

function bot(nickname) {
  const s = io(`${URL}/game`, { transports: ['websocket'], forceNew: true });
  const b = { nickname, socket: s, state: null };
  s.on('escape:state', (st) => (b.state = st));
  bots.push(b);
  return b;
}

async function main() {
  seatTaken = await claimSeat();
  // The answers, by REST (the host's own template). Unpublished, so the console publishes it.
  let tpl = await vaultHeistTemplate({ publish: false });
  if (tpl.status === 'published') tpl = await api('POST', `/escape-templates/${tpl.id}/unpublish`);
  const content = tpl.content;
  const answers = answersOf(content);
  const [lobby, security] = content.stages;
  const lockOf = (stage, id) => stage.locks.find((l) => l.id === id);
  const door = lockOf(lobby, 'lobby-door');
  const badge = lockOf(lobby, 'lobby-badge');
  check(answers.length >= 6, `${TEMPLATE} ready (draft), ${answers.length} answers known`);

  browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADED !== '1',
    downloadsPath: `${OUT}/downloads`,
  });

  // ── 1. The console picks the room, publishes it and opens it ──
  await openConsole(browser, '/escape');
  const addSamples = cpage.getByRole('button', { name: 'Add the sample rooms' });
  const card = cpage
    .locator('article')
    .filter({ has: cpage.getByRole('heading', { name: TEMPLATE, exact: true }) })
    .first();
  await Promise.race([card.waitFor(), addSamples.waitFor()]);
  if (await addSamples.isVisible()) await addSamples.click();
  await card.waitFor();
  await card.getByRole('button', { name: 'Publish' }).click();
  check(await visible(card.getByText('Published')), 'picker: Vault Heist published');
  await shot(cpage, 'picker');
  await card.getByRole('button', { name: 'Create room' }).click();
  await cpage.waitForURL(/\/session\/\d{6}\/console/, { timeout: 15_000 });
  pin = cpage.url().match(/\/session\/(\d{6})\/console/)[1];
  check(true, `room opened on /session/${pin}/console`);
  check(
    await visible(cpage.getByRole('img', { name: `PIN ${pin.split('').join(' ')}` })),
    'the PIN shows in large digits',
  );
  check(await visible(cpage.locator('svg[aria-label]').first()), 'the QR shows');

  // ── 2. Two phones and two bots join: four unassigned ──
  const a = await newPhone(browser, 'A');
  const b = await newPhone(browser, 'B');
  const phones = [a, b];
  phonesAll.push(a, b);
  await joinPhone(a, pin, 'Ana');
  await joinPhone(b, pin, 'Ben');
  for (const p of phones) await visible(p.page.getByText('Waiting for the host to form teams'));
  const [b1, b2] = [bot('Bot1'), bot('Bot2')];
  for (const x of [b1, b2]) {
    if (!x.socket.connected) {
      await Promise.race([
        new Promise((ok) => x.socket.once('connect', ok)),
        sleep(10_000).then(() => {
          throw new Error(`${x.nickname}: no connect`);
        }),
      ]);
    }
    await x.socket
      .timeout(10_000)
      .emitWithAck('player:join', { pin, nickname: x.nickname, presence: 'room' });
    await x.socket.timeout(10_000).emitWithAck('escape:sync', { pin });
  }
  const four = await until(async () => {
    const cols = await boardLayout();
    const un = cols.find((c) => c.name === 'Unassigned');
    return un && un.players.length === 4 ? un.players : null;
  });
  check(!!four, `board: four players unassigned (${four?.join(', ') ?? 'not seen'})`);
  await shot(cpage, 'lobby');
  await keepConsoleText();

  // ── 3. Two teams, made by the host; a bot moved; coverage per team ──
  await cpage.getByRole('button', { name: 'I make the teams' }).click();
  await cpage.getByLabel('Number of teams').fill('2');
  await cpage.getByRole('button', { name: 'Make teams' }).click();
  const made = await until(async () => {
    const cols = (await boardLayout()).filter((c) => c.name !== 'Unassigned');
    return cols.length === 2 && cols.every((c) => c.players.length === 2) ? cols : null;
  });
  check(!!made, `two teams of two (${made?.map((c) => c.players.join('+')).join(' / ')})`);
  const team1 = made.find((c) => c.players.includes('Ana')).name;
  const team2 = made.find((c) => c.name !== team1).name;
  // The phones (Ana, Ben) together in team 1, at least one bot in team 2: one bot moves
  // (by touch drag on a tablet, by the "Move to…" menu on a laptop), Ben by the menu.
  const playersOf = async (team) => (await boardLayout()).find((c) => c.name === team)?.players;
  const moveBot = async (nickname, team) => {
    if (TABLET) await moveByTouch(nickname, team);
    else await moveByMenu(nickname, team);
    const ok = await until(async () => (await playersOf(team))?.includes(nickname));
    check(!!ok, `${nickname} moved to ${team} (${TABLET ? 'touch drag' : '"Move to…" menu'})`);
    if (!ok && TABLET) await moveByMenu(nickname, team);
  };
  const botIn1 = (await playersOf(team1)).find((x) => x.startsWith('Bot'));
  if (botIn1) await moveBot(botIn1, team2);
  if (!(await playersOf(team1)).includes('Ben')) {
    await moveByMenu('Ben', team1);
    await until(async () => (await playersOf(team1))?.includes('Ben'));
  }
  if (!botIn1) await moveBot((await playersOf(team2))[0], team1);
  const t1p = await playersOf(team1);
  const t2p = await playersOf(team2);
  check(
    t1p.includes('Ana') && t1p.includes('Ben') && t2p.some((x) => x.startsWith('Bot')),
    `teams: ${team1} ${t1p.join('+')} / ${team2} ${t2p.join('+')}`,
  );
  const bot2 = bots.find((x) => x.nickname === t2p.find((y) => y.startsWith('Bot')));
  for (const name of [team1, team2]) {
    const col = column(name);
    check(
      await visible(col.getByText(/connected/)),
      `${name}: readiness line ("…connected") shows`,
    );
    check(
      await visible(col.getByText(/all held|Not held yet|more than one/)),
      `${name}: role coverage line shows`,
    );
  }
  await shot(cpage, 'teams');

  // ── 4. Start: both teams on stage 1, time running ──
  await cpage.getByRole('button', { name: /Start the game/ }).click();
  const anyway = cpage.getByRole('dialog', { name: 'Start anyway?' });
  if (await visible(anyway, 1500)) await anyway.getByRole('button', { name: 'Start' }).click();
  check(
    await visible(cpage.getByRole('heading', { name: 'Live teams' }), 15_000),
    'the live grid shows',
  );
  const ids = Object.fromEntries(
    await cpage
      .locator('button[data-team-card]')
      .evaluateAll((els) =>
        els.map((e) => [e.getAttribute('aria-label').replace(/^Show /, ''), e.dataset.teamCard]),
      ),
  );
  const id1 = ids[team1];
  const id2 = ids[team2];
  check(!!id1 && !!id2, `grid teams: ${team1}=${id1}, ${team2}=${id2}`);
  for (const id of [id1, id2]) {
    check(await visible(teamCell(id).getByText('0/2 locks')), `${id}: stage 1 shows 0/2 locks`);
  }
  const clock = cpage.getByRole('timer', { name: 'Run time' });
  const c1 = await clock.textContent();
  await sleep(2100);
  const c2 = await clock.textContent();
  check(c1 !== c2, `the run clock runs (${c1} then ${c2})`);
  await shot(cpage, 'running');

  // ── 5. Phone A opens a lock: grid, feed and detail follow ──
  await visible(lockCard(a.page, door.label));
  const t0 = Date.now();
  await openCode(a.page, door.label, door.answer);
  const cellOk = await visible(teamCell(id1).getByText('1/2 locks'), 2000);
  check(cellOk, `${team1}: grid shows 1/2 locks within 2 s (${Date.now() - t0} ms)`);
  check(
    !!(await until(async () =>
      (await feedItems()).some((l) => l.includes(`Ana opened ${door.label}`)),
    )),
    `feed: "${team1}: Ana opened ${door.label}"`,
  );
  await selectTeam(id1, team1);
  check(
    await visible(
      detail(team1).locator('[data-lock="lobby-door"]').getByText('Open', { exact: true }),
    ),
    'detail: the door lock is marked open',
  );
  await shot(cpage, 'detail-team1');
  await keepConsoleText();

  // ── 6. A bot's wrong answer: the team's wrong count goes up ──
  const wrong = await bot2.socket
    .timeout(10_000)
    .emitWithAck('escape:submit', { pin, lockId: 'lobby-door', input: '9999' });
  check(wrong?.outcome === 'wrong', `${bot2.nickname}: a wrong code (${JSON.stringify(wrong)})`);
  await closeDetail();
  await selectTeam(id2, team2);
  check(
    await visible(detail(team2).getByText('Wrong tries: 1')),
    `${team2}: detail says "Wrong tries: 1"`,
  );

  // ── 7. A hint to team 1: the confirm shows its text and cost; the phones get it ──
  const hint = lobby.hints[0];
  await closeDetail();
  await selectTeam(id1, team1);
  await detail(team1).getByRole('button', { name: 'Give hint', exact: true }).click();
  const confirm = cpage.getByRole('dialog', { name: `Give ${team1} the next hint?` });
  check(
    await visible(confirm.getByText(`It adds ${hint.penaltyS} s to their score.`)),
    `hint confirm: the cost (+${hint.penaltyS} s)`,
  );
  check(await visible(confirm.getByText(hint.text)), 'hint confirm: the hint text');
  await shot(cpage, 'hint-confirm');
  await confirm.getByRole('button', { name: 'Give the hint' }).click();
  for (const p of phones) {
    check(await visible(p.page.getByText(hint.text)), `${p.name}: the host's hint shows`);
    await keepText(p);
  }
  const mm = `${Math.floor(hint.penaltyS / 60)}:${String(hint.penaltyS % 60).padStart(2, '0')}`;
  check(await visible(teamCell(id1).getByText(`1 · +${mm}`)), `${team1}: grid hints "1 · +${mm}"`);

  // ── 8. +2 min, then −1 min, for team 2 only ──
  await closeDetail();
  await selectTeam(id2, team2);
  const before = [await timeLeftS(id1), await timeLeftS(id2)];
  await detail(team2)
    .getByRole('button', { name: `+2:00 for ${team2}` })
    .click();
  await sleep(1500);
  const after = [await timeLeftS(id1), await timeLeftS(id2)];
  const jump2 = after[1] - before[1];
  const jump1 = after[0] - before[0];
  check(jump2 >= 110 && jump2 <= 125, `${team2}: time left jumps by about 2 min (${jump2} s)`);
  check(jump1 <= 0 && jump1 > -5, `${team1}: time left does not jump (${jump1} s)`);
  await detail(team2)
    .getByRole('button', { name: `−1:00 for ${team2}` })
    .click();
  const take = cpage.getByRole('dialog', { name: new RegExp(`^Take time from ${team2}`) });
  await take.getByRole('button', { name: 'Take the time' }).click();
  await sleep(1500);
  const back = await timeLeftS(id2);
  const drop = back - after[1];
  check(drop <= -55 && drop >= -66, `${team2}: −1 min after its confirm (${drop} s)`);
  await shot(cpage, 'time');

  // ── 9. Pause: phones say so, the grid stops; resume ──
  await closeDetail();
  await cpage.getByRole('button', { name: 'Pause', exact: true }).click();
  for (const p of phones) {
    check(await visible(p.page.getByText('The game is paused')), `${p.name}: shows paused`);
  }
  const f1 = await timeLeftS(id1);
  await sleep(2100);
  const f2 = await timeLeftS(id1);
  check(f1 === f2, `the grid freezes while paused (${f1} s, ${f2} s)`);
  await shot(cpage, 'paused');
  await cpage.getByRole('button', { name: 'Resume', exact: true }).click();
  check(
    await visible(cpage.getByRole('button', { name: 'Pause', exact: true })),
    'resumed: Pause is back',
  );

  // ── 10. The host opens a lock for team 2 ──
  await selectTeam(id2, team2);
  await detail(team2)
    .getByRole('button', { name: `Open ${door.label} for ${team2}` })
    .click();
  const unlock = cpage.getByRole('dialog', { name: `Open ${door.label} for ${team2}?` });
  await unlock.getByRole('button', { name: 'Open the lock' }).click();
  const botSees = await until(
    async () => bot2.state?.view?.locks.find((l) => l.id === 'lobby-door')?.solved,
  );
  check(!!botSees, `${bot2.nickname}: its state shows the door open`);
  check(
    await visible(detail(team2).getByText('Opened by the host')),
    'detail: "Opened by the host"',
  );
  check(
    !!(await until(async () => (await feedItems()).some((l) => l.includes('opened by the host')))),
    'feed: "… opened by the host"',
  );
  await shot(cpage, 'host-unlock');
  await keepConsoleText();

  // ── 11. Reload the console: phase, teams, selection, feed come back ──
  const feedBefore = await feedItems();
  const urlBefore = cpage.url();
  await cpage.reload();
  check(
    await visible(cpage.getByRole('heading', { name: 'Live teams' }), 15_000),
    'after reload: the live grid again',
  );
  check(cpage.url() === urlBefore, `after reload: same URL (${cpage.url().replace(URL, '')})`);
  check(await visible(detail(team2)), `after reload: ${team2} still selected`);
  check(
    (await cpage.locator('button[data-team-card]').count()) >= 2,
    'after reload: both teams in the grid',
  );
  const feedAfter = await until(async () => {
    const items = await feedItems();
    return feedBefore.every((l) => items.includes(l)) ? items : null;
  });
  check(!!feedAfter, `after reload: the feed is back (${feedBefore.length} lines)`);
  check(
    (await cpage.getByRole('button', { name: 'Create room' }).count()) === 0,
    'after reload: no create dialog',
  );
  await shot(cpage, 'reloaded');

  // ── 12. The host leaves: teams keep playing; the host comes back ──
  await consoleCtx.close();
  await sleep(HOST_GONE_MS);
  await visible(lockCard(a.page, badge.label));
  await openChoice(
    a.page,
    badge.label,
    badge.correct.map((id) => badge.options.find((o) => o.id === id).label),
  );
  check(
    await visible(a.page.getByRole('heading', { name: security.title })),
    `A plays on without the host: stage "${security.title}"`,
  );
  await a.page
    .getByTestId('unlock-moment')
    .click({ timeout: 3000 })
    .catch(() => undefined);
  await keepText(a);
  await openConsole(browser, `/session/${pin}/console`);
  check(
    await visible(cpage.getByRole('heading', { name: 'Live teams' }), 15_000),
    'host back: the live grid',
  );
  check(
    await visible(teamCell(id1).getByText(/Done in/)),
    `host back: ${team1} shows stage 1 done`,
  );
  check(
    await visible(
      teamCell(id1)
        .getByText('0/3 locks')
        .or(teamCell(id1).getByText(/\/\d locks/)),
    ),
    `host back: ${team1} on stage 2`,
  );
  await shot(cpage, 'host-back');
  await keepConsoleText();

  // ── 13. End the run: results with the host marks, the CSV ──
  await closeDetail();
  await cpage.getByRole('button', { name: 'End the run' }).click();
  await cpage
    .getByRole('dialog', { name: 'End the run for every team now?' })
    .getByRole('button', { name: 'End now' })
    .click();
  const csvBtn = cpage.getByRole('button', { name: 'Download CSV' });
  check(await visible(csvBtn, 15_000), 'results show');
  const changed = cpage.locator('table').filter({ hasText: 'What you changed' });
  const row2 = changed.locator(`tr[data-team="${id2}"]`);
  check(await visible(changed.locator(`tr[data-team="${id1}"]`)), `results: ${team1} row`);
  check(await visible(row2.getByText('+1:00 (score unchanged)')), `results: ${team2} extra time`);
  check(
    (await row2.locator('td').last().textContent()).trim() === '1',
    `results: ${team2} one lock opened by the host`,
  );
  await shot(cpage, 'results');
  await keepConsoleText();
  const [download] = await Promise.all([cpage.waitForEvent('download'), csvBtn.click()]);
  const csvFile = `${OUT}/host-${VIEWPORT}-results.csv`;
  await download.saveAs(csvFile);
  const lines = readFileSync(csvFile, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean);
  check(
    /^"?Place"?[,;]"?Team"?/.test(lines[0]) && lines.length === 3,
    `CSV ${csvFile.replace(`${OUT}/`, '')}: header + ${lines.length - 1} rows (${lines[0].slice(0, 60)}…)`,
  );
  check(!leaksIn(lines.join('\n'), answers).length, 'CSV: no answer');

  // ── 14. Run it again: forming, four unassigned; then host:end ──
  await cpage.getByRole('button', { name: 'Run it again' }).click();
  const again = await until(async () => {
    const un = (await boardLayout()).find((c) => c.name === 'Unassigned');
    return un && un.players.length === 4 ? un.players : null;
  }, 15_000);
  check(!!again, `run again: forming, four unassigned (${again?.join(', ') ?? 'not seen'})`);
  await shot(cpage, 'again');
  await keepConsoleText();
}

/** host:end from a socket of the host (no ack). */
async function endRoom() {
  const s = io(`${URL}/game`, {
    transports: ['websocket'],
    auth: { localUser: HOST },
    forceNew: true,
  });
  await new Promise((ok) => {
    s.once('connect', ok);
    s.once('connect_error', ok);
  });
  if (s.connected) {
    await s
      .timeout(5000)
      .emitWithAck('host:attach', { pin })
      .catch(() => undefined);
    s.emit('host:end', { pin });
    await sleep(500);
  }
  s.close();
}

let crashed = null;
let answers = [];
try {
  await main();
} catch (err) {
  crashed = err;
  log('FAIL', 'run stopped:', err?.stack ?? err);
  if (cpage && !cpage.isClosed()) await shot(cpage, 'crash').catch(() => undefined);
}
if (pin) await endRoom();
check(true, 'host:end sent');

// ── 15. No answers to the console; no host events to the phones ──
try {
  const tpl = (await api('GET', '/escape-templates')).find((t) => t.title === TEMPLATE);
  answers = answersOf((await api('GET', `/escape-templates/${tpl.id}`)).content);
} catch (err) {
  log('FAIL', 'answers unread:', err);
}
const frames = consoleFrames.join('\n');
check(consoleFrames.length > 20, `console: ${consoleFrames.length} frames recorded`);
check(frames.includes('"escape:host"'), 'console: escape:host frames seen');
const leaked = leaksIn(frames, answers);
check(!leaked.length, `console: no answer in frames (${leaked.join(', ') || 'none'})`);
const keys = ['"answer"', '"answers"', '"correct"'];
const keyHits = keys.filter((k) => frames.includes(k));
check(!keyHits.length, `console: no answer fields in frames (${keyHits.join(' ') || 'none'})`);
const shown = leaksIn(consoleTexts.join('\n'), answers);
check(!shown.length, `console: no answer in page text (${shown.join(', ') || 'none'})`);
const hostOnly = ['escape:outline', 'escape:host', 'escape:host-team'];
for (const p of phonesAll) {
  const all = p.frames.join('\n');
  check(p.frames.length > 10, `${p.name}: ${p.frames.length} frames recorded`);
  const events = hostOnly.filter((e) => all.includes(`"${e}"`));
  check(!events.length, `${p.name}: no host events in frames (${events.join(', ') || 'none'})`);
  const hits = leaksIn(p.texts.join('\n'), answers);
  check(!hits.length, `${p.name}: no answer in page text (${hits.join(', ') || 'none'})`);
}

for (const b of bots) b.socket.close();
await browser?.close();
if (seatTaken) await releaseSeat();
if (crashed || problems.length) {
  log(`FAIL: ${problems.length} check(s) failed${crashed ? ', and the run stopped' : ''}`);
  problems.forEach((p) => log('  -', p));
  process.exit(1);
}
log(`OK: every check passed (${VIEWPORT}); screenshots in ${OUT}`);
