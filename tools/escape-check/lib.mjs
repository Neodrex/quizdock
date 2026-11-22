/* global document, window, MutationObserver -- in page.evaluate, the page's own */
/**
 * What the escape checks share (two-phones.mjs, host-console.mjs): the dev stack's
 * address, the OK/FAIL log, the REST calls as the host, the template's answers, the
 * screenshots, phones with a WebSocket frame recorder, and the phone's lock helpers.
 * Importing it forces TMPDIR (Chrome profiles, downloads) under the repo, on the SSD.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../..');
export const URL = process.env.URL ?? 'http://localhost:5173';
export const OUT = process.env.OUT ?? `${REPO}/.tmp/escape-check`;
// Chrome's throwaway profiles go under TMPDIR: keep them on the SSD. macOS always
// sets TMPDIR (on the internal disk), so it is replaced unless already under REPO.
if (!resolve(process.env.TMPDIR ?? '/').startsWith(`${REPO}/`)) {
  process.env.TMPDIR = `${REPO}/.tmp`;
}
mkdirSync(OUT, { recursive: true });
mkdirSync(process.env.TMPDIR, { recursive: true });

export const HOST = 'Mei';
export const PHONE = { width: 390, height: 780 };
export const TEMPLATE = 'Vault Heist';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const problems = [];
export const check = (ok, what) => {
  log(ok ? 'OK  ' : 'FAIL', what);
  if (!ok) problems.push(what);
  return ok;
};

export async function api(method, path, body) {
  const res = await fetch(`${URL}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-local-user': HOST },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** The host seat for HOST; true when this run took it (and so must let it go). */
export async function claimSeat() {
  return api('POST', '/auth/host-seat/claim', { expiresInMinutes: null })
    .then(() => true)
    .catch((err) => {
      if (!String(err).includes('already_host')) throw err;
      return false;
    });
}

export const releaseSeat = () => api('POST', '/auth/host-seat/release').catch(() => undefined);

/** Every answer a phone or the console must never be sent: codes, phrases, parts. */
export function answersOf(content) {
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

/** The host's Vault Heist, with its content (answers included: REST, host only). */
export async function vaultHeistTemplate({ publish = true } = {}) {
  const added = await api('POST', '/escape-templates/samples');
  let tpl = added.find((t) => t.title === TEMPLATE);
  if (!tpl) {
    const row = (await api('GET', '/escape-templates')).find((t) => t.title === TEMPLATE);
    if (!row) throw new Error(`${TEMPLATE} not found among the host's templates`);
    tpl = await api('GET', `/escape-templates/${row.id}`);
  }
  if (publish && tpl.status !== 'published') {
    tpl = await api('POST', `/escape-templates/${tpl.id}/publish`);
  }
  return tpl;
}

let n = 0;
/** A screenshot in OUT, numbered in order; `prefix` names the run (host-laptop…). */
export async function shot(page, name, prefix = '') {
  await sleep(300);
  const file = `${OUT}/${prefix}${String(++n).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  log('shot', file);
}

/** Records what the page's polite region says, every announcement in turn. */
export function recordAnnouncements() {
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

/** Every WebSocket frame the page receives (CDP), pushed into `frames`. */
export async function recordFrames(context, page, frames) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', (e) => frames.push(e.response.payloadData));
}

export async function newPhone(browser, name) {
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
  await recordFrames(context, page, frames);
  const texts = [];
  page.on('pageerror', (err) => log(`[${name}] page error:`, err.message));
  return { name, context, page, frames, texts };
}

/** A phone joins the room by PIN with `nickname`, onto the lobby. */
export async function joinPhone(phone, pin, nickname) {
  await phone.page.goto(`${URL}/join/${pin}`);
  await phone.page.getByLabel(/Nickname/).fill(nickname);
  await phone.page.getByRole('button', { name: 'Join the lobby', exact: true }).click();
  phone.nickname = nickname;
}

/** The page's text as it stands, kept for the no-secrets check at the end. */
export async function keepText(phone) {
  phone.texts.push(await phone.page.evaluate(() => document.body.innerText));
}

export const said = (page) => page.evaluate(() => window.__said ?? []);
export async function waitSaid(page, re, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const all = await said(page);
    const hit = all.find((s) => re.test(s));
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}

/** "m:ss" or "h:mm:ss" as seconds. */
export const clockS = (text) =>
  text
    .trim()
    .replace(/^[−-]/, '')
    .split(':')
    .map(Number)
    .reduce((acc, v) => acc * 60 + v, 0);

/** The team timer's seconds left, as the phone shows them. */
export async function timerS(page) {
  return clockS(await page.locator('[role="timer"] span[aria-hidden]').last().textContent());
}

export const visible = (locator, timeout = 10_000) =>
  locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);

/** Polls `fn` until it returns a truthy value, or null after `timeout`. */
export async function until(fn, timeout = 10_000, every = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return null;
}

/** The lock card titled `label`. */
export const lockCard = (page, label) =>
  page.locator('article').filter({ has: page.getByRole('heading', { name: label }) });

export async function openCode(page, label, answer) {
  const card = lockCard(page, label);
  await card.getByRole('textbox').fill(answer);
  await card.getByRole('button', { name: 'Open', exact: true }).click();
}

export async function openChoice(page, label, optionLabels) {
  const card = lockCard(page, label);
  for (const o of optionLabels) await card.getByRole('button', { name: o }).click();
  await card.getByRole('button', { name: 'Open', exact: true }).click();
}
