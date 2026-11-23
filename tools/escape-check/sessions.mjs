#!/usr/bin/env node
/* global document, window -- in page.evaluate, the page's own */
/**
 * Session types against the dev stack (M7, Task 7.21): group play hosted from a phone,
 * a team race that starts on its own with a public board, and a hosted event under the
 * Acme licence. It prints OK or FAIL per check, writes screenshots to
 * OUT/sessions-*.png, and lets the host seat go if it took it.
 *
 * Setup and servers: as two-phones.mjs (compose postgres/redis, backend start:dev with
 * AUTH_MODE=none, frontend dev), but the backend runs with every dev licence:
 *   LICENCES=all source live/tools/escape-check/devenv.sh    # Dev licence, Acme, Expired Co
 *   pnpm --filter @quiz-dock/backend start:dev
 * The hosted part needs a backend started fresh: the static source counts Acme's two
 * events in memory, and each run of this part uses one. The other checks
 * (two-phones.mjs…) want the default `source devenv.sh` (the Dev licence alone).
 * Run (after `source live/tools/escape-check/devenv.sh`):
 *   node tools/escape-check/sessions.mjs               # all three parts
 *   PART=group|race|hosted node tools/escape-check/sessions.mjs
 * Environment: URL, OUT, HEADED=1 as two-phones.mjs.
 *
 * Group: the creator's phone (390x844) opens Lost Library as group play and lands in
 * its room as a player with the host bar; its socket drops and comes back with the bar;
 * five more join (2 pages, 3 bots), a 7th is refused (bot and page); a bot drops and
 * reconnects into the full room; the phone host starts, solves, pauses and resumes,
 * gives its team a hint and ends; `escape:unlock` by hand is refused. A reload of the
 * phone host is not checked: under AUTH_MODE=none it cannot attach again (plan §5 #12).
 * Race: the console opens a team race starting in 1 minute; /race/<PIN> counts down;
 * phone A starts "Owls", phone B joins by code, 40 bots play solo; it starts on its own;
 * the board trims to 30 teams; the console has no unlock or per-team hint; the run
 * times out; the board shows the podium, phone B its row.
 * Hosted: Vault Heist under Acme (cap 8, brand); the screen shows the logo, intro and
 * accent; a 9th player is refused; the first start uses one event, a second run in the
 * room none; Expired Co is refused in the dialog.
 * No secrets: the frames of one phone, the screen and the public board hold no answer,
 * hint or unlock text (screens), licence id, organisation id, eventsLeft or other
 * team's code (plan §1.4). No sideways scroll on the phone host page, the console at
 * 360 px, or the board at 360 and 1920 px.
 */
import { chromium } from 'playwright-core';
import { io } from 'socket.io-client';
import {
  api,
  answersOf,
  check,
  claimSeat,
  createRoom,
  framesOf,
  gameSocket,
  HOST,
  joinBots,
  joinPhone,
  lockCard,
  log,
  newPhone,
  openCode,
  OUT,
  problems,
  recordAnnouncements,
  recordFrames,
  releaseSeat,
  sampleTemplate,
  scrollsSideways,
  sleep,
  until,
  URL,
  visible,
} from './lib.mjs';

const PARTS = process.env.PART ? [process.env.PART] : ['group', 'race', 'hosted'];
const LIBRARY = 'Lost Library';
const VAULT = 'Vault Heist';
const sockets = [];
let browser = null;
let seatTaken = false;

async function shot(page, name) {
  await sleep(300);
  const file = `${OUT}/sessions-${name}.png`;
  await page.screenshot({ path: file });
  log('shot', file);
}

/** Every WebSocket the page opens, kept so the check can drop them. */
function keepSockets() {
  const Native = window.WebSocket;
  window.__sockets = [];
  window.WebSocket = class extends Native {
    constructor(...args) {
      super(...args);
      window.__sockets.push(this);
    }
  };
}

async function context(size, { mobile = false, host = false } = {}) {
  const ctx = await browser.newContext({
    viewport: size,
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'en-US',
  });
  if (host) await ctx.addInitScript((name) => localStorage.setItem('live.localUser', name), HOST);
  await ctx.addInitScript(recordAnnouncements);
  await ctx.addInitScript(keepSockets);
  const page = await ctx.newPage();
  const frames = [];
  await recordFrames(ctx, page, frames);
  page.on('pageerror', (err) => log('[page] error:', err.message));
  return { ctx, page, frames };
}

const track = (s) => (sockets.push(s), s);
const hostSocket = () => track(gameSocket(io, HOST));

async function connected(s) {
  if (s.connected) return;
  await new Promise((ok, ko) => {
    s.once('connect', ok);
    setTimeout(() => ko(new Error('no connect')), 10_000);
  });
}

/** A host socket attached to `pin` and synced (as big-screen.mjs). */
async function attachedHost(pin) {
  const s = hostSocket();
  await connected(s);
  await s.timeout(10_000).emitWithAck('host:attach', { pin });
  await s.timeout(10_000).emitWithAck('escape:sync', { pin });
  return s;
}

const emit = (s, event, payload) => s.timeout(10_000).emitWithAck(event, payload);
const codeOf = (ack) => ack?.error?.code ?? null;

/**
 * What a frame list must not hold (§1.4), as readable lines: answers (exact string,
 * case-insensitive), `texts` (hint or unlock texts), licence keys and ids, and race
 * codes other than `ownCodes`.
 */
function secretsIn(raw, { answers, texts = [], ownCodes = [] }) {
  const ans = new Set(answers.map((a) => a.trim().toLowerCase()));
  const txt = new Set(texts.filter(Boolean));
  const ids = new Set(['acme', 'acme-org', 'dev-licence', 'dev-org', 'expired-co', 'expired-org']);
  const keys = new Set(['licenceId', 'organisationId', 'eventsLeft', 'hosts']);
  const out = new Set();
  for (const [event, payload] of framesOf(raw)) {
    const walk = (v, path, key) => {
      if (typeof v === 'string') {
        if (ans.has(v.trim().toLowerCase())) out.add(`${event} ${path}: an answer`);
        if (txt.has(v)) out.add(`${event} ${path}: a hint or unlock text`);
        if (ids.has(v)) out.add(`${event} ${path}: a licence id`);
        if (key === 'code' && event.startsWith('escape:') && !ownCodes.includes(v)) {
          out.add(`${event} ${path}: another team's code`);
        }
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (keys.has(k)) out.add(`${event} ${path}.${k}: a licence detail`);
          walk(x, `${path}.${k}`, k);
        }
      }
    };
    walk(payload, '$');
  }
  return [...out];
}

function noSecrets(raw, what, scope) {
  const found = secretsIn(raw, scope);
  const parsed = framesOf(raw).length;
  check(
    found.length === 0 && parsed > 0,
    `no secrets: ${what} (${parsed} frames)${found.length ? `: ${found.slice(0, 3).join('; ')}` : ''}`,
  );
}

const hintTexts = (content) => content.stages.flatMap((s) => s.hints.map((h) => h.text));
const unlockTexts = (content) => content.stages.map((s) => s.unlockText);

async function noSideways(page, what) {
  check(!(await scrollsSideways(page)), `no sideways scroll: ${what}`);
}

// ── 1. Group play ──

async function group() {
  const tpl = await sampleTemplate(LIBRARY);
  const answers = answersOf(tpl.content);
  const [reading] = tpl.content.stages;
  const h = await context({ width: 390, height: 844 }, { mobile: true, host: true });
  await createRoom(h.page, LIBRARY, { type: 'group' });
  await h.page.waitForURL(/\/join\/\d{6}$/, { timeout: 15_000 });
  const pin = h.page.url().match(/\/join\/(\d{6})$/)[1];
  check(true, `group: the room opened, the phone on /join/${pin}`);
  await h.page.getByLabel(/Nickname/).fill(HOST);
  await h.page.getByRole('button', { name: 'Join the lobby', exact: true }).click();
  const bar = h.page.getByRole('region', { name: 'Host controls' });
  check(await visible(bar, 15_000), 'group: the phone plays, with the host bar');
  await shot(h.page, 'group-host-lobby');
  await noSideways(h.page, 'the phone host page (lobby)');

  // Its socket drops: the bar and its seats come back with the reconnect.
  const dropped = await h.page.evaluate(() => {
    // Socket.IO's only: closing Vite's HMR socket reloads the page.
    const open = window.__sockets.filter(
      (w) => w.readyState === 1 && w.url.includes('/socket.io/'),
    );
    open.forEach((w) => w.close());
    return open.length;
  });
  check(dropped === 1, `group: the phone host's socket dropped (${dropped})`);
  await sleep(500);
  const back = await until(
    () =>
      h.page.evaluate(() =>
        window.__sockets.some((w) => w.readyState === 1 && w.url.includes('/socket.io/')),
      ) && bar.isVisible(),
    15_000,
  );
  check(!!back, 'group: after the drop, the socket and the host bar are back');

  // Five more: two pages, three bots; the 7th is refused.
  const ana = await newPhone(browser, 'Ana');
  const ben = await newPhone(browser, 'Ben');
  await joinPhone(ana, pin, 'Ana');
  await joinPhone(ben, pin, 'Ben');
  const bots = await joinBots(io, pin, ['Bo1', 'Bo2', 'Bo3']);
  bots.forEach((b) => track(b.socket));
  check(
    bots.every((b) => b.ack?.ok !== false),
    'group: 3 bots joined (6 in the room with the host)',
  );
  const seats = await until(() => visible(bar.getByLabel('Players in the room: 6 of 6'), 500));
  if (!seats) await shot(h.page, 'group-host-seats');
  check(!!seats, 'group: the host bar says 6 of 6');
  const [seventh] = await joinBots(io, pin, ['Bo7']);
  track(seventh.socket);
  check(
    codeOf(seventh.ack) === 'session.full',
    `group: a 7th bot refused (${codeOf(seventh.ack)})`,
  );
  const zed = await newPhone(browser, 'Zed');
  await joinPhone(zed, pin, 'Zed');
  check(
    await visible(zed.page.getByText('This session is full.')),
    'group: a 7th phone reads "This session is full."',
  );
  await shot(zed.page, 'group-full');
  await zed.context.close();

  // A bot drops and comes back into the full room.
  bots[0].socket.disconnect();
  await sleep(300);
  const again = track(gameSocket(io));
  await connected(again);
  const re = await emit(again, 'player:reconnect', { sessionToken: bots[0].ack.sessionToken });
  const synced = await emit(again, 'escape:sync', { pin });
  check(re?.ok !== false && synced?.ok, 'group: a dropped bot reconnects into the full room');

  // The phone host runs it.
  const start = bar.getByRole('button', { name: 'Start', exact: true });
  check(await visible(start), 'group: Start on the host bar');
  await start.click();
  const lock = lockCard(h.page, reading.locks[0].label);
  check(await visible(lock, 15_000), 'group: the run started on the phone host');
  await noSideways(h.page, 'the phone host page (running)');
  await shot(h.page, 'group-host-running');
  await openCode(h.page, reading.locks[0].label, reading.locks[0].answer);
  check(
    !!(await until(async () => (await lock.getByRole('textbox').count()) === 0)),
    `group: the phone host opened "${reading.locks[0].label}"`,
  );
  await bar.getByRole('button', { name: 'Pause', exact: true }).click();
  check(
    await visible(bar.getByRole('button', { name: 'Resume', exact: true })),
    'group: paused (Resume shows)',
  );
  await bar.getByRole('button', { name: 'Resume', exact: true }).click();
  check(
    await visible(bar.getByRole('button', { name: 'Pause', exact: true })),
    'group: resumed (Pause shows)',
  );
  await bar.getByRole('button', { name: 'Hint for my team', exact: true }).click();
  await h.page
    .getByRole('dialog', { name: 'Give your team its next hint?' })
    .getByRole('button', { name: 'Give the hint' })
    .click();
  check(
    await visible(h.page.getByText(reading.hints[0].text)),
    'group: the hint for its team shows on the phone host',
  );
  check(
    await visible(ana.page.getByText(reading.hints[0].text)),
    'group: and on a teammate’s phone',
  );
  await bar.getByRole('button', { name: 'End', exact: true }).click();
  await h.page
    .getByRole('dialog', { name: 'End the game for everyone?' })
    .getByRole('button', { name: 'End now' })
    .click();
  check(
    await visible(h.page.getByText('Your team', { exact: true }), 15_000),
    'group: the finale on the phone host',
  );
  check(await visible(ana.page.getByText('Your team', { exact: true })), 'group: and on Ana');
  await shot(h.page, 'group-host-finale');

  const s = await attachedHost(pin);
  const unlock = await emit(s, 'escape:unlock', { pin, teamId: 't1', lockId: 'librarian' });
  check(
    codeOf(unlock) === 'escape.not_in_session',
    `group: escape:unlock by hand refused (${codeOf(unlock)})`,
  );

  noSecrets(h.frames, 'the phone host', { answers });
  noSecrets(ana.frames, 'Ana', { answers });
  await Promise.all([h.ctx.close(), ana.context.close(), ben.context.close()]);
}

// ── 2. Race ──

async function race() {
  const tpl = await sampleTemplate(LIBRARY);
  const content = tpl.content;
  const answers = answersOf(content);
  const [reading] = content.stages;
  const c = await context({ width: 1280, height: 800 }, { host: true });
  await createRoom(c.page, LIBRARY, { type: 'race', race: { format: 'teams', startsInMin: 1 } });
  await c.page.waitForURL(/\/session\/\d{6}\/console/, { timeout: 15_000 });
  const pin = c.page.url().match(/\/session\/(\d{6})\/console/)[1];
  check(true, `race: the console opened a team race, PIN ${pin}`);
  check(
    await visible(c.page.getByText('Public race board')),
    'race: the console shows the board link',
  );

  const board = await context({ width: 1920, height: 1080 });
  await board.page.goto(`${URL}/race/${pin}`);
  check(await visible(board.page.getByText(/Starts in \d/)), 'race board: the countdown');

  const a = await newPhone(browser, 'A');
  const b = await newPhone(browser, 'B');
  await joinPhone(a, pin, 'Ana');
  await joinPhone(b, pin, 'Ben');
  await a.page.getByRole('radio', { name: 'Start a team' }).check();
  await a.page.getByLabel('Team name').fill('Owls');
  await a.page.getByRole('button', { name: 'Create the team' }).click();
  const codeEl = a.page.getByLabel(/^Team code: /);
  check(await visible(codeEl), 'race: phone A started "Owls" and reads its code');
  const code = ((await codeEl.getAttribute('aria-label')) ?? '').replace(/^Team code: |\s/g, '');
  check(/^[A-Z]{4}$/.test(code), `race: the code ${code}`);
  await b.page.getByRole('radio', { name: 'Join a team' }).check();
  await b.page.getByLabel('Team code (4 letters)').fill(code);
  await b.page.getByRole('button', { name: 'Join', exact: true }).click();
  check(await visible(b.page.getByText('Owls')), 'race: phone B joined Owls by code');
  await shot(a.page, 'race-phone-team');

  const bots = await joinBots(
    io,
    pin,
    Array.from({ length: 40 }, (_, i) => `Bot${String(i + 1).padStart(2, '0')}`),
  );
  bots.forEach((x) => track(x.socket));
  check(
    bots.every((x) => x.ack?.ok !== false),
    'race: 40 bots joined',
  );
  check(
    await visible(board.page.getByText('42 players in the room')),
    'race board: "42 players in the room"',
  );
  await shot(board.page, 'race-board-lobby');
  const startsAt = bots[0].state?.session?.startsAt;
  check(typeof startsAt === 'number', 'race: the phones know startsAt');

  // Nobody touches the console: it starts on its own.
  let startedAt = 0;
  bots[0].socket.on('escape:state', (s) => {
    if (s.phase === 'running' && !startedAt) startedAt = Date.now();
  });
  log(`race: waiting ${Math.round((startsAt - Date.now()) / 1000)} s for the start`);
  await until(async () => startedAt, Math.max(0, startsAt - Date.now()) + 15_000, 100);
  check(
    startedAt > 0 && Math.abs(startedAt - startsAt) <= 2000,
    `race: started on its own, ${startedAt - startsAt} ms after startsAt`,
  );
  const teams = 41;
  check(
    await visible(board.page.getByText(`and ${teams - 30} more teams`), 15_000),
    `race board: top 30 and "and ${teams - 30} more teams"`,
  );

  // Bots solve at random; Owls do nothing, so they finish beyond the top 20.
  await Promise.all(
    bots.map(async (x, i) => {
      if (i % 4 === 3) return;
      await emit(x.socket, 'escape:submit', {
        pin,
        lockId: reading.locks[0].id,
        input: reading.locks[0].answer,
      });
      if (i % 2) {
        await emit(x.socket, 'escape:submit', {
          pin,
          lockId: reading.locks[1].id,
          input: reading.locks[1].answers[0],
        });
      }
    }),
  );
  await sleep(1500);
  await shot(board.page, 'race-board-running');
  await noSideways(board.page, 'the race board at 1920');

  // The console: no unlock, no per-team hint or time.
  await c.page.locator('button[data-team-card]').first().click();
  await sleep(500);
  const perTeam = await c.page
    .getByRole('button', { name: /^(Open .+ for .+|Give .+ a hint|Time for .+)$/ })
    .count();
  check(perTeam === 0, `race console: no unlock, per-team hint or time (${perTeam})`);
  check(
    await visible(c.page.getByRole('button', { name: 'Hint to all' })),
    'race console: "Hint to all" stays',
  );
  await shot(c.page, 'race-console');
  await c.page.keyboard.press('Escape');
  await c.page.setViewportSize({ width: 360, height: 780 });
  await sleep(500);
  await noSideways(c.page, 'the console at 360');
  await shot(c.page, 'race-console-360');
  const narrow = await context({ width: 360, height: 780 }, { mobile: true });
  await narrow.page.goto(`${URL}/race/${pin}`);
  await sleep(2000);
  await noSideways(narrow.page, 'the race board at 360');
  await shot(narrow.page, 'race-board-360');
  await narrow.ctx.close();

  // Time out: every team's clock runs out.
  const s = await attachedHost(pin);
  const adj = await emit(s, 'escape:adjust-time', { pin, deltaS: -3600 });
  check(adj?.ok, `race: all teams' time taken (${JSON.stringify(adj)})`);
  check(
    await visible(board.page.getByText('Podium'), 20_000),
    'race board: the podium after the time-out',
  );
  await sleep(1500);
  await shot(board.page, 'race-board-finale');
  check(await visible(b.page.getByText(/^You: #\d+ of /), 15_000), 'race: phone B on the finale');
  const you = await visible(b.page.getByText(new RegExp(`^You: #\\d+ of ${teams}$`)));
  check(you, `race: phone B reads "You: #N of ${teams}"`);
  check(await visible(b.page.getByText('Owls')), 'race: phone B sees its row');
  await shot(b.page, 'race-phone-finale');
  const far = await until(async () => {
    const x = bots.find(
      (y) =>
        y.finale &&
        y.finale.totalTeams === teams &&
        y.finale.ranking.length === 21 &&
        y.finale.ranking.at(-1)?.teamId === y.state?.team?.id,
    );
    return x ?? null;
  });
  check(!!far, 'race: a bot beyond 20 gets the top 20 and its own row');

  noSecrets(a.frames, 'phone A (Owls)', { answers, ownCodes: [code] });
  noSecrets(board.frames, 'the public board', {
    answers,
    texts: [...hintTexts(content), ...unlockTexts(content)],
  });
  await Promise.all([c.ctx.close(), board.ctx.close(), a.context.close(), b.context.close()]);
}

// ── 3. Hosted event ──

async function hosted() {
  const vault = await sampleTemplate(VAULT);
  const library = await sampleTemplate(LIBRARY);
  const answers = answersOf(vault.content);
  const acmeLeft = async () =>
    // A licence with no event left is no longer offered: 0.
    (await api('GET', '/escape-licences')).find((l) => l.id === 'acme')?.eventsLeft ?? 0;
  const before = await acmeLeft();
  if (!check(before >= 1, `hosted: Acme listed with ${before} events left`)) {
    log('Start the backend with `LICENCES=all source devenv.sh` (fresh: uses are in memory).');
    return;
  }
  const c = await context({ width: 1280, height: 800 }, { host: true });
  await createRoom(c.page, VAULT, { type: 'hosted', licence: 'acme' });
  await c.page.waitForURL(/\/session\/\d{6}\/console/, { timeout: 15_000 });
  const pin = c.page.url().match(/\/session\/(\d{6})\/console/)[1];
  check(
    await visible(c.page.getByRole('img', { name: 'Acme logo' })),
    'hosted: console header logo',
  );
  check(await visible(c.page.getByText(/Acme · until/)), 'hosted: console header "Acme · until …"');
  await shot(c.page, 'hosted-console');

  const scr = await context({ width: 1920, height: 1080 });
  await scr.page.goto(`${URL}/session/${pin}/projection`);
  const codeText = await until(async () => {
    const t = await scr.page
      .locator('div.fixed', { has: scr.page.getByText('Projection code', { exact: true }) })
      .locator('span.font-mono')
      .textContent({ timeout: 1000 });
    return /^\d{4}$/.test(t?.trim() ?? '') ? t.trim() : null;
  });
  check(!!codeText, `hosted screen: pairing code ${codeText}`);
  await c.page.getByRole('button', { name: 'Project from another computer' }).click();
  await c.page.getByLabel('Code shown on that screen').fill(codeText ?? '');
  await c.page.getByRole('button', { name: 'Make it the projection' }).click();
  check(
    await visible(c.page.getByText("That screen is now the lobby's projection.")),
    'hosted: the screen paired',
  );
  await c.page.keyboard.press('Escape');
  check(await visible(scr.page.getByRole('img', { name: 'Acme logo' })), 'hosted screen: logo');
  check(
    await visible(scr.page.getByText('Welcome to the Acme team escape.')),
    'hosted screen: the intro',
  );
  const accent = await scr.page.evaluate(() =>
    [...document.querySelectorAll('[data-theme-scope]')].some((e) =>
      /c2410c/i.test(e.getAttribute('style') ?? ''),
    ),
  );
  check(accent, 'hosted screen: the Acme accent in its theme');
  await shot(scr.page, 'hosted-screen-lobby');

  const phone = await newPhone(browser, 'P');
  await joinPhone(phone, pin, 'Pia');
  const bots = await joinBots(
    io,
    pin,
    Array.from({ length: 7 }, (_, i) => `Ac${i + 1}`),
  );
  bots.forEach((x) => track(x.socket));
  check(
    bots.every((x) => x.ack?.ok !== false),
    'hosted: 8 players in (a phone and 7 bots)',
  );
  const [ninth] = await joinBots(io, pin, ['Ac9']);
  track(ninth.socket);
  check(codeOf(ninth.ack) === 'session.full', `hosted: the 9th refused (${codeOf(ninth.ack)})`);
  check(await visible(phone.page.getByRole('img', { name: 'Acme logo' })), 'hosted phone: logo');

  const s = await attachedHost(pin);
  check((await emit(s, 'escape:teams', { pin, mode: 'auto', count: 2 }))?.ok, 'hosted: 2 teams');
  check((await emit(s, 'escape:start', { pin }))?.ok, 'hosted: started');
  const after = await until(async () => ((await acmeLeft()) === before - 1 ? true : null), 5000);
  check(!!after, `hosted: Acme events left ${before} → ${await acmeLeft()}`);
  await sleep(1500);
  await shot(scr.page, 'hosted-screen-running');
  check((await emit(s, 'escape:end', { pin }))?.ok, 'hosted: ended');
  await sleep(1500);
  // As the console's "Run again": back to the lobby, then the next room.
  const lobby = new Promise((ok) => s.on('game:state', (g) => g.state === 'LOBBY' && ok(true)));
  await emit(s, 'host:back-to-lobby', { pin });
  await Promise.race([lobby, sleep(10_000)]);
  const opened = await emit(s, 'escape:open', { pin, templateId: library.id });
  check(opened?.ok, `hosted: escape:open with ${LIBRARY} (${JSON.stringify(opened)})`);
  await emit(s, 'escape:sync', { pin });
  await emit(s, 'escape:teams', { pin, mode: 'auto', count: 2 });
  const again = await emit(s, 'escape:start', { pin });
  check(again?.ok, `hosted: the second run started (${JSON.stringify(again)})`);
  await sleep(500);
  check((await acmeLeft()) === before - 1, `hosted: still ${before - 1} event(s) left`);
  await emit(s, 'escape:end', { pin });

  noSecrets(phone.frames, 'the hosted phone', { answers });
  noSecrets(scr.frames, 'the hosted screen', {
    answers,
    texts: [...hintTexts(vault.content), ...unlockTexts(vault.content)],
  });

  // Expired Co: the list never offers it; one that expires after the list is refused.
  const late = await context({ width: 1280, height: 800 }, { host: true });
  await late.page.route('**/api/v1/escape-licences', async (route) => {
    const res = await route.fetch();
    const list = await res.json();
    list.push({
      id: 'expired-co',
      organisationName: 'Expired Co',
      package: 'single',
      participantCap: 30,
      expiresAt: Date.now() + 86_400_000,
      eventsLeft: 1,
      hasBrand: false,
    });
    await route.fulfill({ response: res, json: list });
  });
  const dialog = await createRoom(late.page, VAULT, { type: 'hosted', licence: 'expired-co' });
  check(
    await visible(dialog.getByText('This licence has expired.')),
    'hosted: Expired Co refused in the dialog: "This licence has expired."',
  );
  await shot(late.page, 'hosted-expired');
  await Promise.all([c.ctx.close(), scr.ctx.close(), phone.context.close(), late.ctx.close()]);
}

async function main() {
  seatTaken = await claimSeat();
  browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
  const run = { group, race, hosted };
  for (const part of PARTS) {
    log(`── ${part} ──`);
    try {
      await run[part]();
    } catch (err) {
      check(false, `${part}: ${err.message}`);
    }
  }
}

main()
  .catch((err) => check(false, `run: ${err.stack ?? err}`))
  .finally(async () => {
    for (const s of sockets) s.disconnect();
    await browser?.close().catch(() => undefined);
    if (seatTaken) await releaseSeat();
    log(problems.length ? `${problems.length} FAIL` : 'all OK');
    process.exit(problems.length ? 1 : 0);
  });
