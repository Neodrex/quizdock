#!/usr/bin/env node
/* global document, window, AudioParam, getComputedStyle -- in page.evaluate, the page's own */
/**
 * The escape big screen runs a Vault Heist session against the dev stack (M6, Task
 * 6.19): the console creates the room; the screen opens /session/<PIN>/projection
 * unpaired and the console pairs it by its code; the screen enables sound; two phones
 * and two socket bots join and are formed into two teams; the run starts; a lock, a
 * stage cleared (banner + ding), a hint (banner + tick), a pause, extra time, the final
 * minutes (big countdown + tension music), a reload, the host leaving, the run timing
 * out (tic-tac + gong), the screen finale with its replay, the podium, a reload in the
 * finale. It prints OK or FAIL per check, writes screenshots of the key views, and
 * lets the host seat go if it took it.
 *
 * Setup and servers: as two-phones.mjs (devenv.sh, compose postgres/redis, backend
 * start:dev with AUTH_MODE=none, frontend dev). The host grace (GAME_HOST_GRACE_MS,
 * 5 s by default) must stay under HOST_GONE_MS (default 8 s).
 * Run (after `source live/tools/escape-check/devenv.sh`):
 *   node tools/escape-check/big-screen.mjs                     # 1920x1080
 *   SCREEN=4k node tools/escape-check/big-screen.mjs           # 3840x2160
 *   SCREEN=projector node tools/escape-check/big-screen.mjs    # 1024x768 (4:3)
 *   REDUCED=1 node tools/escape-check/big-screen.mjs           # prefers-reduced-motion
 * Environment: URL, HEADED=1 as two-phones.mjs; SHOTS (screenshots, default
 * <repo>/.tmp/big-screen-shots/<mode>/); HOST_GONE_MS.
 *
 * Sound is seen through a probe in the screen's page (init script): every AudioContext
 * made, and every AudioParam value set. Each synthesised effect has a marker frequency:
 * the ding's 300 Hz soften filter, the hint tick's 1400 Hz, the gong's 7000 Hz low-pass,
 * the tension bed's 55 Hz, the tic-tac's 1800/1100 Hz clicks.
 *
 * No secrets to the screen (plan §1.4): every WebSocket frame the screen receives (CDP)
 * is parsed, and no string in it may hold a Vault Heist answer (whole word), hint text,
 * unlock text or clue body; no frame may carry a host or phone event or a host column
 * key. Nicknames are expected (owner answer 1). The page text is checked the same way.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { io } from 'socket.io-client';
import {
  api,
  answersOf,
  check,
  claimSeat,
  createRoom,
  clockS,
  HOST,
  joinPhone,
  lockCard,
  log,
  newPhone,
  openChoice,
  openCode,
  problems,
  recordAnnouncements,
  recordFrames,
  releaseSeat,
  REPO,
  sleep,
  TEMPLATE,
  until,
  URL,
  vaultHeistTemplate,
  visible,
} from './lib.mjs';

const SIZES = {
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
  projector: { width: 1024, height: 768 },
};
const SIZE_NAME = process.env.SCREEN ?? '1080p';
const SIZE = SIZES[SIZE_NAME];
if (!SIZE) throw new Error(`SCREEN=${SIZE_NAME}: one of ${Object.keys(SIZES).join(', ')}`);
const REDUCED = process.env.REDUCED === '1';
const MODE = `${SIZE_NAME}${REDUCED ? '-reduced' : ''}`;
const SHOTS = process.env.SHOTS ?? `${REPO}/.tmp/big-screen-shots/${MODE}`;
mkdirSync(SHOTS, { recursive: true });
// This mode's screenshots from an earlier run go: the folder shows one run.
for (const f of readdirSync(SHOTS)) if (f.endsWith('.png')) rmSync(`${SHOTS}/${f}`);
const HOST_GONE_MS = Number(process.env.HOST_GONE_MS ?? 8000);

let shots = 0;
async function shot(page, name) {
  await sleep(400);
  const file = `${SHOTS}/screen-${SIZE_NAME}-${String(++shots).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  log('shot', file);
}

/** In the screen's page: every AudioContext and every AudioParam value set. */
function audioProbe() {
  const probe = { ctxs: [], params: [] };
  window.__audio = probe;
  // Playwright's evaluate runs as a user gesture, which would unlock sound without a
  // click: the page's activation is the real input's only (as for a person at the TV).
  let active = false;
  for (const type of ['pointerdown', 'mousedown', 'keydown', 'touchend']) {
    window.addEventListener(type, (e) => e.isTrusted && (active = true), true);
  }
  const ua = {
    get hasBeenActive() {
      return active;
    },
    get isActive() {
      return active;
    },
  };
  Object.defineProperty(Navigator.prototype, 'userActivation', {
    configurable: true,
    get: () => ua,
  });
  const wrap = (Base) =>
    Base &&
    class extends Base {
      constructor(...args) {
        super(...args);
        probe.ctxs.push(this);
      }
    };
  if (window.AudioContext) window.AudioContext = wrap(window.AudioContext);
  if (window.webkitAudioContext) window.webkitAudioContext = wrap(window.webkitAudioContext);
  const note = (v) => {
    if (typeof v === 'number' && probe.params.length < 200_000) {
      probe.params.push([Math.round(v * 100) / 100, Date.now()]);
    }
  };
  const d = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
  Object.defineProperty(AudioParam.prototype, 'value', {
    configurable: true,
    get: d.get,
    set(v) {
      note(v);
      d.set.call(this, v);
    },
  });
  const set = AudioParam.prototype.setValueAtTime;
  AudioParam.prototype.setValueAtTime = function (v, t) {
    note(v);
    return set.call(this, v, t);
  };
}

const MARK = { ding: 300, tick: 1400, gong: 7000, bed: 55, tic: 1800, tac: 1100 };
/** How many times the marker of `kind` was set at or after `since` (page ms). */
const played = (page, kind, since = 0) =>
  page.evaluate(
    ([hz, from]) => (window.__audio?.params ?? []).filter(([v, t]) => v === hz && t >= from).length,
    [MARK[kind], since],
  );
const pageNow = (page) => page.evaluate(() => Date.now());
const audioRunning = (page) =>
  page.evaluate(() => (window.__audio?.ctxs ?? []).some((c) => c.state === 'running'));

let browser = null;
let seatTaken = false;
let pin = '';
let host = null;
let consoleCtx = null;
let cpage = null;
let screenCtx = null;
let spage = null;
const frames = [];
const texts = [];
const bots = [];

const keepText = async () => texts.push(await spage.evaluate(() => document.body.innerText));

/**
 * Nothing scrolls and nothing spills: the page has no scroll either way, and no visible
 * text of the screen frame lies outside the viewport or, within the stage, outside it
 * (the frame is overflow-hidden, so a spill is cut, not scrolled).
 */
async function fits(view) {
  const r = await spage.evaluate(() => {
    const el = document.documentElement;
    const out = [];
    const frame = document.querySelector('.qd-screen');
    const stage = document.querySelector('[data-testid="screen-stage"]');
    const sr = stage?.getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (frame) {
      const walker = document.createTreeWalker(frame, 4 /* NodeFilter.SHOW_TEXT */);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent.trim()) continue;
        const p = n.parentElement;
        if (!p || p.closest('.sr-only')) continue;
        const cs = getComputedStyle(p);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const b of range.getClientRects()) {
          if (b.width === 0 || b.height === 0) continue;
          const inView = b.left >= -1 && b.top >= -1 && b.right <= W + 1 && b.bottom <= H + 1;
          // Clipped by an ancestor (an ellipsis): measured on the clipping box instead.
          let clip = p;
          while (clip && clip !== frame && getComputedStyle(clip).overflow === 'visible') {
            clip = clip.parentElement;
          }
          const c = clip && clip !== frame ? clip.getBoundingClientRect() : b;
          const vis = {
            left: Math.max(b.left, c.left),
            top: Math.max(b.top, c.top),
            right: Math.min(b.right, c.right),
            bottom: Math.min(b.bottom, c.bottom),
          };
          if (vis.right <= vis.left || vis.bottom <= vis.top) {
            // Entirely hidden by its clipping box: cut off, not an ellipsis.
            out.push(`hidden: "${n.textContent.trim().slice(0, 30)}"`);
            continue;
          }
          const visInView =
            vis.left >= -1 && vis.top >= -1 && vis.right <= W + 1 && vis.bottom <= H + 1;
          const inStage =
            !sr ||
            !stage.contains(p) ||
            (vis.left >= sr.left - 1 &&
              vis.top >= sr.top - 1 &&
              vis.right <= sr.right + 1 &&
              vis.bottom <= sr.bottom + 1);
          if (!visInView || !inStage) {
            out.push(
              `${inView ? 'out of stage' : 'off screen'}: "${n.textContent.trim().slice(0, 30)}" ` +
                `[${Math.round(vis.left)},${Math.round(vis.top)}–${Math.round(vis.right)},${Math.round(vis.bottom)}]`,
            );
          }
        }
      }
    }
    return {
      sw: el.scrollWidth,
      sh: el.scrollHeight,
      w: W,
      h: H,
      out: [...new Set(out)].slice(0, 6),
    };
  });
  check(r.sw <= r.w && r.sh <= r.h, `${view}: no scroll (${r.sw}x${r.sh} in ${r.w}x${r.h})`);
  check(!r.out.length, `${view}: no text cut or spilt (${r.out.join('; ') || 'none'})`);
}

/**
 * The smallest text on the screen is 0.9em of the screen's base (plan §1.8, about 25 px
 * at 1080p); upstream's pairing panel and overlays outside the frame are not counted.
 */
async function readable(view) {
  const r = await spage.evaluate(() => {
    const frame = document.querySelector('.qd-screen');
    if (!frame) return null;
    const base = parseFloat(getComputedStyle(frame).fontSize);
    let min = Infinity;
    let what = '';
    const walker = document.createTreeWalker(frame, 4);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!n.textContent.trim() || !p || p.closest('.sr-only')) continue;
      if (!p.getClientRects().length) continue;
      const fs = parseFloat(getComputedStyle(p).fontSize);
      if (fs < min) {
        min = fs;
        what = n.textContent.trim().slice(0, 30);
      }
    }
    return { base, min, what };
  });
  if (!r) return;
  check(
    r.min >= r.base * 0.9 - 0.5,
    `${view}: smallest text ${r.min.toFixed(1)} px ≥ 0.9 × ${r.base.toFixed(1)} px ("${r.what}")`,
  );
}

/**
 * The race's lanes: each team name whole (the check's names are short: an ellipsis is
 * a squeeze), and the stage segments lined up across lanes (same left and width).
 */
async function lanesLineUp(view) {
  const r = await spage.evaluate(() => {
    const lanes = [...document.querySelectorAll('li[data-lane]')];
    if (lanes.length < 2) return null;
    const cut = lanes
      .map((li) => li.querySelector('[data-lane-name]'))
      .filter((n) => n && n.scrollWidth > n.clientWidth + 1)
      .map((n) => n.textContent);
    const segs = lanes.map((li) =>
      [...li.querySelectorAll('[data-testid="stage-segment"]')].map((e) => {
        const b = e.getBoundingClientRect();
        return [Math.round(b.left), Math.round(b.width)];
      }),
    );
    const first = JSON.stringify(segs[0]);
    const off = segs.filter((x) => JSON.stringify(x) !== first).length;
    return { cut, off };
  });
  if (!r) return;
  check(!r.cut.length, `${view}: team names in full (${r.cut.join(', ') || 'all'})`);
  check(r.off === 0, `${view}: the stages line up across lanes`);
}

async function view(name) {
  await shot(spage, name);
  await keepText();
  await fits(name);
  await readable(name);
  await lanesLineUp(name);
}

const phaseIs = (p) =>
  until(async () => (await spage.locator(`[data-escape-phase="${p}"]`).count()) > 0, 15_000);
const pairingPanel = () => spage.getByText('Projection code', { exact: true });
const soundButton = () => spage.getByRole('button', { name: /Turn audio on|Enable audio/ });
const lane = (id) => spage.locator(`li[data-lane="${id}"]`);
const banner = () => spage.getByTestId('screen-banner');
const clockDigits = () => spage.getByTestId('show-clock-digits');
const showClockS = async () => {
  const t = (await clockDigits().textContent()).trim();
  return t.includes(':') ? clockS(t) : Number(t);
};

async function enableSound(when) {
  check(await visible(soundButton(), 10_000), `${when}: the "Turn audio on" overlay shows`);
  await soundButton().click();
  check(
    await until(async () => (await soundButton().count()) === 0, 5000),
    `${when}: the overlay is gone after the click`,
  );
  check(!!(await until(() => audioRunning(spage), 5000)), `${when}: the AudioContext runs`);
}

async function openScreen() {
  screenCtx = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    locale: 'en-US',
    reducedMotion: REDUCED ? 'reduce' : 'no-preference',
  });
  await screenCtx.addInitScript(audioProbe);
  await screenCtx.addInitScript(recordAnnouncements);
  spage = await screenCtx.newPage();
  await recordFrames(screenCtx, spage, frames);
  spage.on('pageerror', (err) => log('[screen] page error:', err.message));
  await spage.goto(`${URL}/session/${pin}/projection`);
}

function bot(nickname) {
  const s = io(`${URL}/game`, { transports: ['websocket'], forceNew: true });
  const b = { nickname, socket: s };
  bots.push(b);
  return b;
}

async function connected(s, what) {
  if (s.connected) return;
  await Promise.race([
    new Promise((ok) => s.once('connect', ok)),
    sleep(10_000).then(() => {
      throw new Error(`${what}: no connect`);
    }),
  ]);
}

let hostState = null;
const emit = async (event, payload) => {
  const ack = await host.timeout(10_000).emitWithAck(event, payload);
  if (ack && ack.ok === false) throw new Error(`${event}: ${JSON.stringify(ack)}`);
  return ack;
};

let content = null;

async function main() {
  seatTaken = await claimSeat();
  const tpl = await vaultHeistTemplate();
  content = tpl.content;
  const answers = answersOf(content);
  const [lobby, security] = content.stages;
  const door = lobby.locks.find((l) => l.id === 'lobby-door');
  const badge = lobby.locks.find((l) => l.id === 'lobby-badge');
  const override = security.locks.find((l) => l.id === 'security-override');
  check(answers.length >= 6, `${TEMPLATE} published, ${answers.length} answers known`);
  log(`mode ${MODE}: screen ${SIZE.width}x${SIZE.height}, screenshots in ${SHOTS}`);

  browser = await chromium.launch({
    channel: 'chrome',
    headless: process.env.HEADED !== '1',
  });

  // ── 1. The console creates the room; the screen opens unpaired ──
  consoleCtx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
  });
  await consoleCtx.addInitScript((name) => localStorage.setItem('live.localUser', name), HOST);
  cpage = await consoleCtx.newPage();
  cpage.on('pageerror', (err) => log('[console] page error:', err.message));
  await cpage.goto(`${URL}/escape`);
  const card = cpage
    .locator('article')
    .filter({ has: cpage.getByRole('heading', { name: TEMPLATE, exact: true }) })
    .first();
  await card.waitFor();
  // M7: the session dialog. A roles room is a hosted event, under the Dev licence
  // (devenv.sh's only one, preselected).
  await createRoom(cpage, TEMPLATE);
  await cpage.waitForURL(/\/session\/\d{6}\/console/, { timeout: 15_000 });
  pin = cpage.url().match(/\/session\/(\d{6})\/console/)[1];
  check(true, `console: room opened on /session/${pin}/console`);

  await openScreen();
  check(await phaseIs('forming'), 'screen: the escape lobby shows');
  check(await visible(pairingPanel()), 'screen: unpaired, the pairing code shows');
  const code = (
    await spage
      .locator('div.fixed', { has: pairingPanel() })
      .locator('span.font-mono')
      .textContent()
  ).trim();
  check(/^\d{4}$/.test(code), `screen: pairing code ${code}`);
  check(
    await visible(spage.getByTestId('lobby-pin').getByText(pin)),
    'screen: the PIN in large digits',
  );
  check(
    await visible(
      spage.getByRole('img', { name: /QR/i }).or(spage.locator('[data-testid="join-panel"] svg')),
    ),
    'screen: the QR shows',
  );
  const qrH = await spage
    .locator('[data-testid="join-panel"] svg')
    .first()
    .evaluate((s) => s.getBoundingClientRect().height / window.innerHeight);
  check(qrH >= 0.3, `screen: the QR is ${(qrH * 100).toFixed(0)}% of the height (≥ 30%)`);
  await view('lobby-unpaired');

  // ── 2. The console pairs it; the screen enables sound ──
  await cpage.getByRole('button', { name: 'Project from another computer' }).click();
  await cpage.getByLabel('Code shown on that screen').fill(code);
  await cpage.getByRole('button', { name: 'Make it the projection' }).click();
  const pairedNote = await visible(cpage.getByText("That screen is now the lobby's projection."));
  if (!pairedNote) await cpage.screenshot({ path: `${SHOTS}/console-pairing.png` });
  check(pairedNote, 'console: "That screen is now the lobby\'s projection."');
  await cpage.keyboard.press('Escape');
  check(
    !!(await until(async () => !(await pairingPanel().isVisible()), 5000)),
    'screen: the pairing code is gone',
  );
  await enableSound('paired screen');

  // The host's socket: team ids, hints, time, pause (the console's own buttons are
  // host-console.mjs's to check).
  host = io(`${URL}/game`, {
    transports: ['websocket'],
    auth: { localUser: HOST },
    forceNew: true,
  });
  host.on('escape:host', (st) => (hostState = st));
  await connected(host, 'host socket');
  await host.timeout(10_000).emitWithAck('host:attach', { pin });
  await emit('escape:sync', { pin });
  // The room's effects are off in a new room (upstream's defaults): the host turns them
  // on, as from the console's sound button.
  host.emit('host:sounds', { pin, ding: true, gong: true, tick: true, countdown: true });

  // ── 3. Two phones and two bots join; auto formation, two teams ──
  const a = await newPhone(browser, 'A');
  const b = await newPhone(browser, 'B');
  await joinPhone(a, pin, 'Ana');
  await joinPhone(b, pin, 'Ben');
  for (const nickname of ['Bot1', 'Bot2']) {
    const x = bot(nickname);
    await connected(x.socket, nickname);
    await x.socket.timeout(10_000).emitWithAck('player:join', { pin, nickname, presence: 'room' });
    await x.socket.timeout(10_000).emitWithAck('escape:sync', { pin });
  }
  const everyone = ['Ana', 'Ben', 'Bot1', 'Bot2'];
  const waitingSeen = await until(async () => {
    const text = await spage.getByTestId('screen-stage').innerText();
    return everyone.every((n) => text.includes(n)) ? text : null;
  });
  check(!!waitingSeen, `lobby: the four nicknames show as waiting players`);
  check(await visible(spage.getByText('4 players in the room')), 'lobby: "4 players in the room"');
  await view('lobby-waiting');

  await emit('escape:teams', { pin, mode: 'auto', count: 2 });
  const formed = await until(async () =>
    hostState?.teams?.length === 2 && hostState.teams.every((t) => t.members.length === 2)
      ? hostState.teams
      : null,
  );
  check(!!formed, 'two teams of two (host state)');
  const cardsOk = await until(async () => {
    const cards = await spage.locator('ul[aria-label="Teams"] > li').evaluateAll((lis) =>
      lis.map((li) => ({
        name: li.querySelector('span')?.textContent ?? '',
        text: li.innerText,
      })),
    );
    if (cards.length !== 2) return null;
    return formed.every((t) => {
      const c = cards.find((x) => x.name === t.name);
      return (
        c && c.text.includes('2 players') && t.members.every((m) => c.text.includes(m.nickname))
      );
    })
      ? cards
      : null;
  });
  check(
    !!cardsOk,
    `lobby: both teams with "2 players" and their nicknames (${formed
      .map((t) => `${t.name}: ${t.members.map((m) => m.nickname).join('+')}`)
      .join(' / ')})`,
  );
  await view('lobby-teams');

  const team1 = formed.find((t) => t.members.some((m) => m.nickname === 'Ana'));
  const team2 = formed.find((t) => t.id !== team1.id);

  // ── 4. Start: two lanes on stage 1, the run clock running ──
  await emit('escape:start', { pin });
  check(await phaseIs('running'), 'screen: the race shows');
  check(
    !!(await until(async () => (await spage.locator('li[data-lane]').count()) === 2)),
    'race: two lanes',
  );
  for (const t of [team1, team2]) {
    const st = await lane(t.id)
      .locator('[data-testid="stage-segment"]')
      .first()
      .getAttribute('data-state');
    check(st === 'current', `race: ${t.name} on stage 1 (${st})`);
    check(
      (await lane(t.id).locator('[data-lane-name]').textContent()) === t.name,
      `race: lane named "${t.name}"`,
    );
  }
  const c1 = await clockDigits().textContent();
  await sleep(2100);
  const c2 = await clockDigits().textContent();
  check(c1 !== c2, `race: the run clock runs (${c1} then ${c2})`);
  await view('race');

  // ── 5. Phone A opens a lock, then clears the stage: banner and ding ──
  await visible(lockCard(a.page, door.label));
  const t0 = Date.now();
  await openCode(a.page, door.label, door.answer);
  check(
    await visible(lane(team1.id).getByText('1/2', { exact: true }), 2000),
    `race: ${team1.name} shows 1/2 within 2 s (${Date.now() - t0} ms)`,
  );
  const since5 = await pageNow(spage);
  await openChoice(
    a.page,
    badge.label,
    badge.correct.map((id) => badge.options.find((o) => o.id === id).label),
  );
  const cleared = await until(async () => {
    const txt = await banner().textContent();
    return txt.includes(`${team1.name} cleared stage 1`) ? txt : null;
  });
  check(!!cleared, `banner: "${cleared ?? `${team1.name} cleared stage 1`}"`);
  await view('banner-cleared');
  check(
    !!(await until(async () => (await played(spage, 'ding', since5)) > 0, 3000)),
    'sound: the ding with the banner',
  );
  await a.page
    .getByTestId('unlock-moment')
    .click({ timeout: 3000 })
    .catch(() => undefined);
  check(
    (await lane(team1.id)
      .locator('[data-testid="stage-segment"]')
      .nth(1)
      .getAttribute('data-state')) === 'current',
    `race: ${team1.name} on stage 2`,
  );

  // ── 6. A hint to team 2: banner and tick, no hint text ──
  await sleep(4500); // the cleared banner's time
  const since6 = await pageNow(spage);
  await emit('escape:hint', { pin, teamId: team2.id });
  const hinted = await until(async () => {
    const txt = await banner().textContent();
    return txt.includes(`${team2.name} took a hint`) ? txt : null;
  });
  check(!!hinted, `banner: "${hinted ?? `${team2.name} took a hint`}"`);
  check(
    !!(await until(async () => (await played(spage, 'tick', since6)) > 0, 3000)),
    'sound: the tick with the hint banner',
  );
  check(await visible(lane(team2.id).getByText('1 hint')), `race: ${team2.name} shows "1 hint"`);
  await keepText();

  // ── 7. Pause: banner, frozen clock; resume ──
  await emit('escape:pause', { pin, paused: true });
  check(await visible(spage.getByTestId('paused-banner')), 'paused: the "Paused" banner');
  const p1 = await clockDigits().textContent();
  await sleep(2100);
  const p2 = await clockDigits().textContent();
  check(p1 === p2, `paused: the clock is frozen (${p1}, ${p2})`);
  check(
    (await spage.getByTestId('screen-stage').getAttribute('data-paused')) === 'true',
    'paused: the race is dimmed',
  );
  await view('paused');
  await emit('escape:pause', { pin, paused: false });
  check(
    !!(await until(async () => (await spage.getByTestId('paused-banner').count()) === 0)),
    'resumed: the banner is gone',
  );

  // ── 8. Extra time for team 1: the other lane shows its own time; the final minutes ──
  await emit('escape:adjust-time', { pin, deltaS: 60, teamId: team1.id });
  await sleep(1500);
  const own2 = lane(team2.id).locator('span.font-mono');
  check(
    await visible(own2, 5000),
    `race: ${team2.name}'s own time shows (${(await own2.textContent().catch(() => '')) || 'none'}), the run clock follows ${team1.name}`,
  );
  check(
    (await lane(team1.id).locator('span.font-mono').count()) === 0,
    `race: ${team1.name} (the run clock) shows no own time`,
  );
  const showS = await showClockS();
  const ownS = clockS(await own2.textContent());
  check(
    Math.abs(showS - ownS - 60) <= 2,
    `race: the lanes are a minute apart (${showS} s, ${ownS} s)`,
  );
  await view('race-extra-time');
  // Down to 4:30 on the run clock: inside the final 5 minutes.
  const sinceFinal = await pageNow(spage);
  await emit('escape:adjust-time', { pin, deltaS: -(showS - 270) });
  check(
    !!(await until(
      async () => (await spage.locator('[role="timer"][data-final="true"]').count()) > 0,
    )),
    'final minutes: the big countdown',
  );
  check(await visible(spage.getByText('Final minutes')), 'final minutes: "Final minutes"');
  const big = await clockDigits().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  const baseFs = await spage
    .locator('.qd-screen')
    .evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  check(
    Math.abs(big / baseFs - 8) < 0.2,
    `final minutes: the clock at 8em (${(big / baseFs).toFixed(2)}em)`,
  );
  const pulse = await spage.locator('[data-pulse="scale"]').count();
  check(
    REDUCED ? pulse === 0 : pulse === 1,
    `final minutes: ${REDUCED ? 'no pulse (reduced motion)' : 'the clock pulses'}`,
  );
  check(
    !!(await until(async () => (await played(spage, 'bed', sinceFinal)) > 0, 5000)),
    'sound: the tension music starts',
  );
  await view('final-minutes');

  // ── 9. Reload the screen: paired, same phase, sound asked again ──
  await spage.reload();
  check(await phaseIs('running'), 'reload: the race again');
  await sleep(2000);
  check(!(await pairingPanel().isVisible()), 'reload: still paired (no code)');
  check(
    await visible(spage.locator('[role="timer"][data-final="true"]')),
    'reload: the final-minutes countdown is back',
  );
  check((await spage.locator('li[data-lane]').count()) === 2, 'reload: both lanes');
  await enableSound('after reload');
  check(
    !!(await until(async () => (await played(spage, 'bed')) > 0, 5000)),
    'reload: the tension music restarts after the click',
  );

  // ── 10. The host leaves; the screen keeps the show going ──
  // The run clock down to 75 s first (the host can no longer do it): team 2, a minute
  // behind, runs out while the host is away; team 1 runs out after its last lock.
  const nowS = await showClockS();
  await emit('escape:adjust-time', { pin, deltaS: -(nowS - 75) });
  await sleep(1000);
  await consoleCtx.close();
  host.close();
  await sleep(HOST_GONE_MS);
  check(await phaseIs('running'), 'host gone: the race stays');
  await visible(lockCard(a.page, override.label));
  await openCode(a.page, override.label, override.answers[0]);
  check(
    await visible(lane(team1.id).getByText('1/2', { exact: true }), 3000),
    `host gone: ${team1.name} shows 1/2 on stage 2`,
  );
  check(
    await visible(lane(team2.id).getByText('Time up'), 30_000),
    `host gone: ${team2.name} shows "Time up"`,
  );
  check(
    (await lane(team2.id).getAttribute('data-out')) === 'true',
    `host gone: ${team2.name}'s lane is greyed`,
  );
  await view('host-gone');

  // ── 11. The run times out: tic-tac, gong, the screen finale, the replay, the podium ──
  const sinceEnd = await pageNow(spage);
  const left = await showClockS();
  const finale = spage.getByTestId('screen-finale');
  check(await visible(finale, (left + 20) * 1000), 'finale: the screen finale arrives on its own');
  check(
    (await played(spage, 'tic', sinceEnd)) >= 5,
    `sound: the tic-tac (${await played(spage, 'tic', sinceEnd)} tics)`,
  );
  check(
    (await played(spage, 'tac', sinceEnd)) >= 5,
    `sound: the tac (${await played(spage, 'tac', sinceEnd)} tacs)`,
  );
  check((await played(spage, 'gong', sinceEnd)) > 0, 'sound: the gong at time up');
  const replay = spage.getByTestId(REDUCED ? 'split-table' : 'split-replay');
  check(
    await visible(replay, 3000),
    `finale: the ${REDUCED ? 'split table (reduced motion)' : 'animated replay'}`,
  );
  if (!REDUCED) {
    check((await spage.getByTestId('replay-lane').count()) === 2, 'replay: one lane per team');
  }
  await sleep(REDUCED ? 1500 : 5000);
  await view('replay-mid');
  const podium = spage.getByTestId('podium');
  check(await visible(podium, 40_000), 'finale: the podium after the replay');
  const steps = await podium
    .getByTestId('podium-step')
    .evaluateAll((els) => els.map((e) => ({ place: e.dataset.place, text: e.innerText })));
  check(steps.length === 2, `podium: two teams (${steps.map((s) => s.place).join(', ')})`);
  for (const t of [team1, team2]) {
    const step = steps.find((s) => s.text.includes(t.name));
    check(
      !!step && t.members.every((m) => step.text.includes(m.nickname)),
      `podium: ${t.name} with ${t.members.map((m) => m.nickname).join(', ')}`,
    );
  }
  check(await visible(spage.getByText('Time up').first()), 'podium: "Time up" for the teams');
  await view('finale');

  // ── 12. Reload in the finale: the podium at once, no replay ──
  await spage.reload();
  check(await visible(podium, 5000), 'finale reload: the podium at once');
  check(
    (await spage.getByTestId('split-replay').count()) +
      (await spage.getByTestId('split-table').count()) ===
      0,
    'finale reload: no replay',
  );
  await sleep(1500);
  check((await spage.getByTestId('split-replay').count()) === 0, 'finale reload: still no replay');
  await view('finale-reloaded');
}

/** host:end from a socket of the host. */
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
try {
  await main();
} catch (err) {
  crashed = err;
  log('FAIL', 'run stopped:', err?.stack ?? err);
  if (spage && !spage.isClosed()) await shot(spage, 'crash').catch(() => undefined);
}
if (pin) await endRoom();
check(true, 'host:end sent');

// ── 13. No secrets to the screen ──
try {
  if (!content) {
    const tpl = (await api('GET', '/escape-templates')).find((t) => t.title === TEMPLATE);
    content = (await api('GET', `/escape-templates/${tpl.id}`)).content;
  }
} catch (err) {
  log('template unread:', err);
}
const answers = content ? answersOf(content) : [];
const secretTexts = content
  ? [
      ...content.stages.flatMap((s) => s.hints.map((h) => h.text)),
      ...content.stages.map((s) => s.unlockText).filter(Boolean),
      ...content.stages.flatMap((s) => s.clues.map((c) => c.body).filter(Boolean)),
    ]
  : [];
check(
  answers.length > 0 && secretTexts.length > 0,
  `secrets read (${answers.length} answers, ${secretTexts.length} texts)`,
);

const word = (a) =>
  new RegExp(`(?<![0-9A-Za-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`);
/** Every string (values and keys) of a socket.io frame; null for a frame not JSON. */
function stringsOf(frame) {
  const m = /^\d+(?:\/[^,[]*,)?\d*(.*)$/s.exec(frame);
  if (!m || !m[1]) return [];
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [frame];
  }
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        walk(x);
      }
    }
  };
  walk(data);
  return out;
}
const strings = frames.flatMap(stringsOf);
const keysOf = (fs) =>
  new Set(fs.flatMap((f) => [...f.matchAll(/"([A-Za-z]+)":/g)].map((m) => m[1])));
const keysSeen = keysOf(frames);
// A player id counts in escape frames only: upstream's lobby frames (game:roster,
// player:joined, player:left) give every socket of the PIN the ids (backend leaks.ts).
const escapeKeys = keysOf(frames.filter((f) => /^\d+(?:\/[^,[]*,)?\d*\["escape:/.test(f)));
const eventsSeen = new Set(
  frames.map((f) => /^\d+(?:\/[^,[]*,)?\d*\["([^"]+)"/.exec(f)?.[1]).filter(Boolean),
);
check(frames.length > 50, `screen: ${frames.length} frames recorded`);
check(
  eventsSeen.has('escape:board') &&
    eventsSeen.has('escape:announce') &&
    eventsSeen.has('escape:screen-finale'),
  `screen: board, announce and screen-finale frames seen (${[...eventsSeen].filter((e) => e.startsWith('escape:')).join(', ')})`,
);
const forbidden = [
  'escape:state',
  'escape:team-update',
  'escape:host',
  'escape:host-team',
  'escape:outline',
  'escape:finale',
];
const evHits = forbidden.filter((e) => eventsSeen.has(e));
check(!evHits.length, `screen: no forbidden event (${evHits.join(', ') || 'none'})`);
const hostKeys = [
  'adjustMs',
  'hostUnlocks',
  'paidHints',
  'answer',
  'answers',
  'correct',
  'unlockText',
  'hints',
  'clues',
  'text',
  'body',
];
const keyHits = [
  ...hostKeys.filter((k) => keysSeen.has(k)),
  ...(escapeKeys.has('playerId') ? ['playerId (escape)'] : []),
];
check(!keyHits.length, `screen: no host column or secret key (${keyHits.join(', ') || 'none'})`);
const ansHits = answers.filter((a) => strings.some((s) => word(a).test(s)));
check(!ansHits.length, `screen: no answer in frames (${ansHits.join(', ') || 'none'})`);
const txtHits = secretTexts.filter((t) => frames.some((f) => f.includes(t)));
check(!txtHits.length, `screen: no hint, unlock or clue text in frames (${txtHits.length})`);
check(
  ['Ana', 'Ben', 'Bot1', 'Bot2'].every((n) => strings.includes(n)),
  'screen: the nicknames are in the frames (owner answer 1)',
);
const pageText = texts.join('\n');
check(texts.length >= 8, `screen: ${texts.length} page texts kept`);
const pageAns = answers.filter((a) => word(a).test(pageText));
check(!pageAns.length, `screen: no answer in page text (${pageAns.join(', ') || 'none'})`);
const pageTxt = secretTexts.filter((t) => pageText.includes(t));
check(!pageTxt.length, `screen: no hint, unlock or clue text in page text (${pageTxt.length})`);

for (const b of bots) b.socket.close();
host?.close();
await browser?.close();
if (seatTaken) await releaseSeat();
if (crashed || problems.length) {
  log(
    `FAIL (${MODE}): ${problems.length} check(s) failed${crashed ? ', and the run stopped' : ''}`,
  );
  problems.forEach((p) => log('  -', p));
  process.exit(1);
}
log(`OK: every check passed (${MODE}); screenshots in ${SHOTS}`);
