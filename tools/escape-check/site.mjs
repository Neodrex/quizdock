#!/usr/bin/env node
/**
 * Live and the Site end to end (M8, Task 8.22). It prints OK or FAIL per check and
 * writes screenshots to OUT/site-*.png. It starts and restarts the Live backend
 * itself (apps/backend/dist, so build it or keep `start:dev` compiling it), because
 * step 2 restarts it and step 5 runs it against a Site that cannot be reached.
 *
 * Setup:
 *   Site (app/, Node 22): `pnpm db:start`, `pnpm seed` (Acme, its bundle licence of
 *   2 events with the dev user as facilitator, the race "M8 check race" a few
 *   minutes ahead), `pnpm dev` on 5173, with LIVE_API_TOKEN (32+ characters) and
 *   PUBLIC_LIVE_URL=http://localhost:5174 in app/.env.
 *   Live: `docker compose up -d postgres redis`, then
 *     AUTH=site LICENCES=site source live/tools/escape-check/devenv.sh
 *     pnpm --filter @quiz-dock/backend build      # unless start:dev keeps dist fresh
 *     pnpm --filter @quiz-dock/frontend dev --port 5174 &
 *     node tools/escape-check/site.mjs
 *   PORT (backend, from devenv) must be free: the script runs the backend on it.
 *   Re-run `pnpm seed` before each run: it gives Acme its 2 events back and moves
 *   the race ahead (a race already opened stays; the seed then makes a new one).
 * Environment: URL (Live frontend, default http://localhost:5174), SITE (default
 * http://localhost:5173), OUT, HEADED=1.
 *
 * 1. Sign-in: Live's login goes to the Site, the dev user signs in there, the
 *    consent goes straight through, and /me has the host role.
 * 2. Hosted Acme event: the dialog lists the Site licence with its name and no
 *    logo (local Supabase is http), 8 players in and a 9th refused, the start
 *    records a use on the Site, and the count holds after a backend restart.
 * 3. Site race: "Open on Live" from the Site race page opens it on Live; the
 *    Site page then shows Join and Watch; /race/<PIN> wears Acme's brand; phone B
 *    joins phone A's team and leaves it; the race starts on its own; after the
 *    finale the results reach the Site, the admin publishes them, and the
 *    archive shows them.
 * 4. Group play: the phone host reloads and attaches again (OIDC).
 * 5. The Site cannot be reached: a hosted create gives "licence service
 *    unavailable" (escape.licence_unavailable), a Site race escape.race_unavailable.
 * 6. No secrets in any recorded frame: answers, hint and unlock texts (screens),
 *    licence keys and ids, siteRaceId and the race id, the API token.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { io } from 'socket.io-client';

process.env.URL ??= 'http://localhost:5174';
const {
  answersOf,
  check,
  createRoom: createRoomAs,
  framesOf,
  joinBots,
  joinPhone,
  log,
  newPhone,
  OUT,
  problems,
  recordAnnouncements,
  recordFrames,
  REPO,
  sleep,
  until,
  URL,
  visible,
} = await import('./lib.mjs');

const SITE = process.env.SITE ?? 'http://localhost:5173';
const PORT = process.env.PORT ?? '3000';
const API = `http://localhost:${PORT}`;
const TOKEN = process.env.ESCAPE_SITE_TOKEN ?? '';
const EMAIL = 'dev@example.com';
const PASSWORD = 'devpassword';
const VAULT = 'Vault Heist';
const LIBRARY = 'Lost Library';
const RACE_TITLE = 'M8 check race';
const BACKEND_DIR = `${REPO}/live/apps/backend`;

const sockets = [];
const recorded = []; // { what, frames, scope }
let browser = null;
let backend = null;
let host = null; // { ctx, page, frames, cookie }
let me = null;
const secrets = { licenceIds: new Set(), raceIds: new Set() };

// ── The Live backend, run by this script ──

const backendLog = createWriteStream(`${OUT}/site-backend.log`, { flags: 'a' });

async function up() {
  return fetch(`${API}/api/v1/auth/config`)
    .then((r) => r.ok)
    .catch(() => false);
}

async function startBackend(extra = {}) {
  if (await up()) throw new Error(`port ${PORT} is taken: stop the backend there first`);
  backendLog.write(`\n── start ${new Date().toISOString()} ${JSON.stringify(extra)} ──\n`);
  backend = spawn(process.execPath, ['--enable-source-maps', 'dist/main.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backend.stdout.pipe(backendLog, { end: false });
  backend.stderr.pipe(backendLog, { end: false });
  const ok = await until(up, 240_000, 1000);
  if (!ok) throw new Error(`the backend did not come up on ${PORT} (see ${OUT}/site-backend.log)`);
  log(`backend up on ${PORT}`);
}

async function stopBackend() {
  if (!backend) return;
  const p = backend;
  backend = null;
  const gone = new Promise((ok) => p.once('exit', ok));
  p.kill('SIGTERM');
  await Promise.race([gone, sleep(20_000)]);
  if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
  await until(async () => !(await up()), 20_000, 300);
}

// ── Calls as the signed-in host ──

async function cookieOf(ctx) {
  return (await ctx.cookies(URL)).map((c) => `${c.name}=${c.value}`).join('; ');
}

async function hostFetch(method, path, body) {
  return fetch(`${URL}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie: host.cookie,
      origin: URL,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function hostApi(method, path, body) {
  const res = await hostFetch(method, path, body);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function sampleTemplate(title) {
  await hostApi('POST', '/escape-templates/samples');
  const row = (await hostApi('GET', '/escape-templates')).find((t) => t.title === title);
  if (!row) throw new Error(`${title} not found among the host's templates`);
  let tpl = await hostApi('GET', `/escape-templates/${row.id}`);
  if (tpl.status !== 'published')
    tpl = await hostApi('POST', `/escape-templates/${tpl.id}/publish`);
  return tpl;
}

/** The Site's own answer for the host's licences (its internal API). */
async function siteLicences() {
  const res = await fetch(`${SITE}/api/live/licences/usable`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ host: { subject: me.subject, email: me.email } }),
  });
  if (!res.ok) throw new Error(`Site usable: ${res.status}`);
  return res.json();
}

const track = (s) => (sockets.push(s), s);
function hostSocket() {
  return track(
    io(`${URL}/game`, {
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: { cookie: host.cookie },
    }),
  );
}

async function connected(s) {
  if (s.connected) return;
  await new Promise((ok, ko) => {
    s.once('connect', ok);
    s.once('connect_error', ko);
    setTimeout(() => ko(new Error('no connect')), 15_000);
  });
}

const emit = (s, event, payload) => s.timeout(15_000).emitWithAck(event, payload);
const codeOf = (ack) => ack?.error?.code ?? ack?.code ?? null;

async function attachedHost(pin) {
  const s = hostSocket();
  await connected(s);
  const a = await emit(s, 'host:attach', { pin });
  await emit(s, 'escape:sync', { pin });
  return { s, attach: a };
}

async function shot(page, name) {
  await sleep(300);
  const file = `${OUT}/site-${name}.png`;
  await page.screenshot({ path: file });
  log('shot', file);
}

async function context(size, { mobile = false, from = null } = {}) {
  const ctx = await browser.newContext({
    viewport: size,
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'en-US',
  });
  if (from) await ctx.addCookies(await from.cookies());
  await ctx.addInitScript(recordAnnouncements);
  // The dev servers are slow on this drive, the first load most of all.
  ctx.setDefaultNavigationTimeout(120_000);
  ctx.setDefaultTimeout(30_000);
  const page = await ctx.newPage();
  const frames = [];
  await recordFrames(ctx, page, frames);
  page.on('pageerror', (err) => log('[page] error:', err.message));
  return { ctx, page, frames };
}

async function phone(name) {
  const p = await newPhone(browser, name);
  p.context.setDefaultNavigationTimeout(120_000);
  p.context.setDefaultTimeout(30_000);
  return p;
}

/**
 * lib's createRoom, after the "Participant access" step a signed-in host gets
 * first under OIDC: open access (guests join by PIN and nickname), not remembered.
 */
async function createRoom(page, title, opts = {}) {
  const access = page.getByRole('dialog', { name: 'Participant access' });
  const answered = (async () => {
    await access.waitFor({ timeout: 20_000 });
    await access.getByRole('radio', { name: /^Open access/ }).check();
    await access.getByRole('button', { name: 'Start', exact: true }).click();
  })().catch(() => undefined);
  void answered; // in the background: it may come before the session dialog or after
  return createRoomAs(page, title, opts);
}

// ── 1. Sign-in through the Site ──

async function signIn() {
  host = await context({ width: 1280, height: 800 });
  const { page } = host;
  const hops = [];
  page.on('framenavigated', (f) => f === page.mainFrame() && hops.push(f.url()));
  await page.goto(`${URL}/`);
  const { url } = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auth/login', { method: 'POST' });
    return r.json();
  });
  check(
    url?.startsWith('http://127.0.0.1:54321/auth/v1/oauth/authorize'),
    'sign-in: Live sends the host to the Site',
  );
  await page.goto(url);
  await page.waitForURL(/localhost:5173\/login/, { timeout: 30_000 });
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const back = await until(
    async () => {
      const u = new globalThis.URL(page.url());
      return u.origin === URL && !u.pathname.startsWith('/auth/callback');
    },
    60_000,
    300,
  );
  check(!!back, `sign-in: back on Live (${page.url()})`);
  // Nothing was clicked after "Sign in": a consent page that waited would stop here.
  check(!!back, `sign-in: the consent went straight through (${hops.length} pages)`);
  host.cookie = await cookieOf(host.ctx);
  me = await hostApi('GET', '/me');
  check(me?.email === EMAIL, `sign-in: /me is ${me?.email}`);
  check(me?.roles?.includes('host'), `sign-in: roles ${JSON.stringify(me?.roles)} include host`);
  await shot(page, 'signed-in');
}

// ── 2. A hosted Acme event ──

async function hosted() {
  const vault = await sampleTemplate(VAULT);
  const answers = answersOf(vault.content);
  const liveAcme = async () =>
    (await hostApi('GET', '/escape-licences')).find((l) => l.organisationName === 'Acme') ?? null;
  const siteAcme = async () => (await siteLicences()).find((l) => l.brand?.name === 'Acme') ?? null;
  const lic = await liveAcme();
  if (!check(!!lic, `hosted: Live lists the Site's Acme licence (${lic?.eventsLeft} events left)`))
    return;
  secrets.licenceIds.add(lic.id);
  const site = await siteAcme();
  if (site?.organisationId) secrets.licenceIds.add(site.organisationId);
  const before = lic.eventsLeft;
  check(
    before >= 1 && site?.eventsLeft === before,
    `hosted: Site and Live agree: ${before} events left`,
  );
  check(lic.participantCap === 8, `hosted: cap ${lic.participantCap}`);

  const { page } = host;
  const dialog = await createRoom(page, VAULT, { type: 'hosted', licence: lic.id }).catch(
    async (e) => {
      await shot(page, 'hosted-dialog-error');
      throw e;
    },
  );
  void dialog;
  await page.waitForURL(/\/session\/\d{6}\/console/, { timeout: 30_000 });
  const pin = page.url().match(/\/session\/(\d{6})\/console/)[1];
  check(true, `hosted: room ${pin} under the Site licence`);
  check(
    await visible(page.getByText(/Acme · until/), 15_000),
    'hosted: console header "Acme · until …"',
  );
  check(
    (await page.getByRole('img', { name: 'Acme logo' }).count()) === 0,
    'hosted: no logo (local Supabase is http)',
  );
  await shot(page, 'hosted-console');

  const pia = await phone('P');
  await joinPhone(pia, pin, 'Pia');
  const bots = await joinBots(
    io,
    pin,
    Array.from({ length: 7 }, (_, i) => `Ac${i + 1}`),
  );
  bots.forEach((b) => track(b.socket));
  check(
    bots.every((b) => b.ack?.ok !== false),
    'hosted: 8 players in (a phone and 7 bots)',
  );
  const [ninth] = await joinBots(io, pin, ['Ac9']);
  track(ninth.socket);
  check(codeOf(ninth.ack) === 'session.full', `hosted: the 9th refused (${codeOf(ninth.ack)})`);
  check(await visible(pia.page.getByText('Acme').first()), 'hosted phone: the brand name shows');

  const { s } = await attachedHost(pin);
  check((await emit(s, 'escape:teams', { pin, mode: 'auto', count: 2 }))?.ok, 'hosted: 2 teams');
  const started = await emit(s, 'escape:start', { pin });
  check(started?.ok, `hosted: started (${JSON.stringify(started)})`);
  const used = await until(async () => (await siteAcme())?.eventsLeft === before - 1, 15_000, 500);
  check(!!used, `hosted: the Site shows ${before - 1} event(s) left after the start`);
  await emit(s, 'escape:end', { pin });
  recorded.push({ what: 'the hosted phone', frames: pia.frames, scope: { answers } });
  await pia.context.close();
  s.disconnect();

  log('restarting the Live backend');
  await stopBackend();
  await startBackend();
  check(
    (await siteAcme())?.eventsLeft === before - 1,
    `hosted: after the restart the Site still shows ${before - 1}`,
  );
  const after = await liveAcme();
  check(after?.eventsLeft === before - 1, `hosted: and Live lists ${after?.eventsLeft} left`);
}

// ── 3. The Site race ──

async function siteRaceLink(page) {
  await page.goto(`${SITE}/races`);
  const hrefs = await page
    .getByRole('link', { name: RACE_TITLE })
    .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  for (const href of hrefs) {
    await page.goto(`${SITE}${href}`);
    const open = page.getByRole('link', { name: 'Open on Live' });
    if (await open.count())
      return { id: href.split('/').pop(), open: await open.getAttribute('href') };
  }
  return null;
}

async function race() {
  const library = await sampleTemplate(LIBRARY);
  const content = library.content;
  const answers = answersOf(content);
  const [reading] = content.stages;
  const { page } = host;

  const link = await siteRaceLink(page);
  if (
    !check(
      !!link,
      `race: "${RACE_TITLE}" offers "Open on Live" on the Site (re-run pnpm seed if not)`,
    )
  )
    return;
  secrets.raceIds.add(link.id);
  // The title and start (ms) travel along for the create dialog (site-race-search.ts).
  const open = new globalThis.URL(link.open);
  check(
    `${open.origin}${open.pathname}` === `${URL}/escape` &&
      open.searchParams.get('siteRace') === link.id &&
      open.searchParams.get('title') === RACE_TITLE &&
      /^\d+$/.test(open.searchParams.get('startsAt') ?? ''),
    `race: the link goes to Live (${link.open})`,
  );
  await shot(page, 'race-site-before');
  await page.getByRole('link', { name: 'Open on Live' }).click();
  await page.waitForURL(/\/escape\?siteRace=/, { timeout: 30_000 });
  const dialog = await createRoom(page, LIBRARY);
  const opened = await until(async () => /\/session\/\d{6}\/console/.test(page.url()), 30_000, 300);
  if (!opened) {
    await shot(page, 'race-create-refused');
    check(false, `race: the room opened (${await dialog.innerText().catch(() => '?')})`);
    return;
  }
  const pin = page.url().match(/\/session\/(\d{6})\/console/)[1];
  check(true, `race: the Site race opened on Live, PIN ${pin}`);
  const consoleFrames = host.frames;

  // The Site page now sends players and viewers to the room.
  const site = await context({ width: 1280, height: 800 }, { from: host.ctx });
  await site.page.goto(`${SITE}/races/${link.id}`);
  check(
    await visible(site.page.getByText(`Room code: ${pin}`)),
    'race: the Site page shows the room code',
  );
  const join = await site.page
    .getByRole('link', { name: 'Join', exact: true })
    .getAttribute('href')
    .catch(() => null);
  const watch = await site.page
    .getByRole('link', { name: 'Watch', exact: true })
    .getAttribute('href')
    .catch(() => null);
  check(join === `${URL}/join/${pin}`, `race: Join on the Site (${join})`);
  check(watch === `${URL}/race/${pin}`, `race: Watch on the Site (${watch})`);
  check(
    (await site.page.getByRole('link', { name: 'Open on Live' }).count()) === 0,
    'race: "Open on Live" is gone',
  );
  await shot(site.page, 'race-site-open');

  // The board wears the channel's brand.
  const board = await context({ width: 1920, height: 1080 });
  await board.page.goto(watch ?? `${URL}/race/${pin}`);
  check(
    await visible(board.page.getByText('Acme').first(), 15_000),
    'race board: the brand name "Acme"',
  );
  const look = await until(async () =>
    framesOf(board.frames).find(([e, p]) => e === 'escape:look' && p?.brand?.name === 'Acme'),
  );
  check(!!look, 'race board: escape:look carries the Acme brand');
  await shot(board.page, 'race-board-lobby');

  // Phone A starts a team, B joins it by code and leaves it.
  const a = await phone('A');
  const b = await phone('B');
  await joinPhone(a, pin, 'Ana');
  await joinPhone(b, pin, 'Ben');
  await a.page.getByRole('radio', { name: 'Start a team' }).check();
  await a.page.getByLabel('Team name').fill('Owls');
  await a.page.getByRole('button', { name: 'Create the team' }).click();
  const codeEl = a.page.getByLabel(/^Team code: /);
  check(await visible(codeEl), 'race: phone A started "Owls"');
  const code = ((await codeEl.getAttribute('aria-label')) ?? '').replace(/^Team code: |\s/g, '');
  await b.page.getByRole('radio', { name: 'Join a team' }).check();
  await b.page.getByLabel('Team code (4 letters)').fill(code);
  await b.page.getByRole('button', { name: 'Join', exact: true }).click();
  check(await visible(b.page.getByText('Owls')), 'race: phone B joined Owls by code');
  await b.page.getByRole('button', { name: 'Leave the team' }).click();
  await b.page
    .getByRole('dialog', { name: 'Leave your team?' })
    .getByRole('button', { name: 'Leave', exact: true })
    .click();
  check(
    await visible(b.page.getByRole('radio', { name: 'Start a team' }), 15_000),
    'race: phone B left the team and can start or join one again',
  );
  await shot(b.page, 'race-phone-left');

  const bots = await joinBots(io, pin, ['Rb1', 'Rb2', 'Rb3']);
  bots.forEach((x) => track(x.socket));
  check(
    bots.every((x) => x.ack?.ok !== false),
    'race: 3 bots joined',
  );
  const startsAt = bots[0].state?.session?.startsAt;
  check(typeof startsAt === 'number', 'race: the phones know startsAt');
  let startedAt = 0;
  bots[0].socket.on('escape:state', (st) => {
    if (st.phase === 'running' && !startedAt) startedAt = Date.now();
  });
  log(`race: waiting ${Math.round((startsAt - Date.now()) / 1000)} s for the start`);
  await until(async () => startedAt, Math.max(0, startsAt - Date.now()) + 30_000, 200);
  check(startedAt > 0, `race: started on its own (${startedAt - startsAt} ms after startsAt)`);
  await Promise.all(
    bots.slice(0, 2).map((x) =>
      emit(x.socket, 'escape:submit', {
        pin,
        lockId: reading.locks[0].id,
        input: reading.locks[0].answer,
      }),
    ),
  );
  await sleep(1000);

  const { s } = await attachedHost(pin);
  const adj = await emit(s, 'escape:adjust-time', { pin, deltaS: -3600 });
  check(adj?.ok, 'race: every team runs out of time');
  check(await visible(board.page.getByText('Podium'), 30_000), 'race board: the podium');
  await shot(board.page, 'race-board-finale');

  // The results reach the Site; the admin publishes them.
  const admin = site.page;
  const card = admin
    .locator('article')
    .filter({ has: admin.locator(`a[href="/races/${link.id}"]`) });
  const arrived = await until(
    async () => {
      await admin.goto(`${SITE}/admin/races`);
      return (await card.getByText(/^Results: \d+ teams/).count()) > 0;
    },
    60_000,
    2000,
  );
  check(!!arrived, 'race: the results reached the Site');
  check(await visible(card.getByText(/· finished/)), 'race: the Site marks it finished');
  await shot(admin, 'race-admin');
  await card.getByRole('button', { name: 'Publish results' }).click();
  check(
    await visible(card.getByRole('button', { name: 'Unpublish results' }), 15_000),
    'race: results published',
  );
  await admin.goto(`${SITE}/races/archive`);
  const section = admin.locator(`section[id="${link.id}"]`);
  check(await visible(section), 'race archive: the race is listed');
  check(await visible(section.getByText('Owls')), 'race archive: "Owls" in the results');
  check(await visible(section.getByText('Acme').first()), 'race archive: the channel name');
  await shot(admin, 'race-archive');

  recorded.push({ what: 'race phone A', frames: a.frames, scope: { answers, ownCodes: [code] } });
  recorded.push({ what: 'race phone B', frames: b.frames, scope: { answers, ownCodes: [code] } });
  recorded.push({
    what: 'the race board',
    frames: board.frames,
    scope: {
      answers,
      texts: content.stages.flatMap((x) => [...x.hints.map((h) => h.text), x.unlockText]),
    },
  });
  recorded.push({
    what: 'the host console',
    frames: consoleFrames,
    scope: { answers: [], hostView: true },
  });
  s.disconnect();
  await Promise.all([site.ctx.close(), board.ctx.close(), a.context.close(), b.context.close()]);
}

// ── 4. Group play: the phone host reloads (OIDC) ──

async function group() {
  await sampleTemplate(LIBRARY);
  const h = await context({ width: 390, height: 844 }, { mobile: true, from: host.ctx });
  await createRoom(h.page, LIBRARY, { type: 'group' });
  await h.page.waitForURL(/\/join\/\d{6}$/, { timeout: 30_000 });
  const pin = h.page.url().match(/\/join\/(\d{6})$/)[1];
  await h.page.getByLabel(/Nickname/).fill('Mei');
  await h.page.getByRole('button', { name: 'Join the lobby', exact: true }).click();
  const bar = h.page.getByRole('region', { name: 'Host controls' });
  check(await visible(bar, 20_000), `group: the phone host plays room ${pin}, with the host bar`);
  await shot(h.page, 'group-joined');
  await h.page.reload();
  check(
    await visible(bar, 30_000),
    'group: after a reload the phone host attaches again (host bar back)',
  );
  check(
    await visible(bar.getByRole('button', { name: 'Start', exact: true })),
    'group: and can start (Start on the bar)',
  );
  await shot(h.page, 'group-reloaded');
  recorded.push({ what: 'the group phone host', frames: h.frames, scope: { answers: [] } });
  await h.ctx.close();
}

// ── 5. The Site cannot be reached ──

async function siteDown() {
  const vault = await sampleTemplate(VAULT);
  const library = await sampleTemplate(LIBRARY);
  const lic = (await hostApi('GET', '/escape-licences')).find((l) => l.organisationName === 'Acme');
  // The dialog loads the list while the Site is up; the Site goes before Create.
  const { page } = host;
  const dialog = await createRoom(page, VAULT, { type: 'hosted', licence: lic?.id }).catch(
    () => null,
  );
  void dialog;
  await page.keyboard.press('Escape').catch(() => undefined);
  log('restarting the Live backend with the Site out of reach');
  await stopBackend();
  await startBackend({ ESCAPE_SITE_URL: 'http://127.0.0.1:9' });

  const d = await createRoom(page, VAULT, { type: 'hosted' });
  await sleep(3000);
  const text = await d.innerText().catch(() => '');
  check(
    /Licences cannot be checked right now/.test(text) && !/\/console/.test(page.url()),
    `site down: the dialog refuses (${text.replace(/\s+/g, ' ').slice(-120)})`,
  );
  await shot(page, 'site-down-dialog');

  const s = hostSocket();
  await connected(s);
  const hostedAck = await emit(s, 'escape:create', {
    templateId: vault.id,
    sessionType: 'hosted',
    licenceId: lic?.id ?? '00000000-0000-0000-0000-000000000000',
  });
  check(
    codeOf(hostedAck) === 'escape.licence_unavailable',
    `site down: a hosted create gives escape.licence_unavailable (${codeOf(hostedAck) ?? JSON.stringify(hostedAck)})`,
  );
  const raceAck = await emit(s, 'escape:create', {
    templateId: library.id,
    sessionType: 'race',
    race: {
      format: 'solo',
      siteRaceId: [...secrets.raceIds][0] ?? '00000000-0000-0000-0000-000000000000',
    },
  });
  check(
    codeOf(raceAck) === 'escape.race_unavailable',
    `site down: a Site race create gives escape.race_unavailable (${codeOf(raceAck) ?? JSON.stringify(raceAck)})`,
  );
  const group = await emit(s, 'escape:create', { templateId: library.id, sessionType: 'group' });
  check(typeof group?.pin === 'string', 'site down: group play still opens');
  s.disconnect();
}

// ── 6. No secrets ──

function secretsIn(raw, { answers, texts = [], ownCodes = [], hostView = false }) {
  const ans = new Set(answers.map((x) => x.trim().toLowerCase()));
  const txt = new Set(texts.filter(Boolean));
  const ids = new Set([...secrets.licenceIds, ...secrets.raceIds]);
  const keys = new Set([
    'siteRaceId',
    'licenceId',
    'organisationId',
    'hosts',
    ...(hostView ? [] : ['eventsLeft']),
  ]);
  const strings = [TOKEN, readOidcSecret()].filter((x) => x && x.length >= 16);
  const out = new Set();
  for (const f of raw)
    for (const x of strings) if (f.includes(x)) out.add('a token or client secret');
  for (const [event, payload] of framesOf(raw)) {
    const walk = (v, path, key) => {
      if (typeof v === 'string') {
        if (ans.has(v.trim().toLowerCase())) out.add(`${event} ${path}: an answer`);
        if (txt.has(v)) out.add(`${event} ${path}: a hint or unlock text`);
        if (ids.has(v)) out.add(`${event} ${path}: a licence or Site race id`);
        if (key === 'code' && event.startsWith('escape:') && !hostView && !ownCodes.includes(v)) {
          out.add(`${event} ${path}: another team's code`);
        }
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (keys.has(k)) out.add(`${event} ${path}.${k}: ${k}`);
          walk(x, `${path}.${k}`, k);
        }
      }
    };
    walk(payload, '$');
  }
  return [...out];
}

function readOidcSecret() {
  try {
    return /OIDC_CLIENT_SECRET=(.+)/
      .exec(readFileSync(`${REPO}/.tmp/live-oidc.env`, 'utf8'))?.[1]
      ?.trim();
  } catch {
    return null;
  }
}

function scan() {
  for (const { what, frames, scope } of recorded) {
    const found = secretsIn(frames, scope);
    const n = framesOf(frames).length;
    check(
      found.length === 0 && n > 0,
      `no secrets: ${what} (${n} frames)${found.length ? `: ${found.slice(0, 3).join('; ')}` : ''}`,
    );
  }
}

async function main() {
  if (TOKEN.length < 32)
    throw new Error('ESCAPE_SITE_TOKEN is not set: AUTH=site LICENCES=site source devenv.sh');
  if (
    !(await fetch(`${SITE}/races`)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    throw new Error(`the Site is not up at ${SITE}`);
  }
  await startBackend();
  browser = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED !== '1' });
  const all = { signIn, hosted, race, group, siteDown };
  // STEPS=group,siteDown runs some (sign-in always runs first).
  const only = process.env.STEPS?.split(',');
  const steps = Object.entries(all).filter(([n]) => n === 'signIn' || !only || only.includes(n));
  for (const [name, run] of steps) {
    log(`── ${name} ──`);
    try {
      await run();
    } catch (err) {
      check(false, `${name}: ${err.message}`);
      if (name === 'signIn') break;
    }
  }
  log('── no secrets ──');
  scan();
}

main()
  .catch((err) => check(false, `run: ${err.stack ?? err}`))
  .finally(async () => {
    for (const s of sockets) s.disconnect();
    await browser?.close().catch(() => undefined);
    await stopBackend().catch(() => undefined);
    log(problems.length ? `${problems.length} FAIL` : 'all OK');
    process.exit(problems.length ? 1 : 0);
  });
