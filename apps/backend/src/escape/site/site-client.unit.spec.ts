import { z } from 'zod';
import { SiteClient, siteAccessOf } from './site-client';

const TOKEN = 'secret-token-'.padEnd(40, 'x');
const access = { url: 'https://site.example/', token: TOKEN };
const schema = z.object({ ok: z.literal(true) });

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  timeoutMs = 3000,
) {
  const log = { warn: jest.fn() };
  const fetch = jest.fn(fetchImpl);
  const c = new SiteClient(access, {
    fetch: fetch as unknown as typeof globalThis.fetch,
    log,
    timeoutMs,
  });
  return { c, log, fetch };
}

const logged = (log: { warn: jest.Mock }) =>
  log.warn.mock.calls.map((c) => String(c[0])).join('\n');

describe('SiteClient', () => {
  it('posts JSON with the bearer token and gives the parsed answer', async () => {
    const { c, fetch } = client(() => Promise.resolve(answer(200, { ok: true })));
    expect(await c.post('/api/live/licences/usable', { a: 1 }, schema)).toEqual({
      ok: true,
      value: { ok: true },
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://site.example/api/live/licences/usable');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['https://site.example', 'api/live/x'],
    ['https://site.example/', '/api/live/x'],
    ['https://site.example//', '//api/live/x'],
  ])('joins %s and %s without a double slash', async (url, path) => {
    const fetch = jest.fn<Promise<Response>, [string, RequestInit?]>(() =>
      Promise.resolve(answer(200, { ok: true })),
    );
    const c = new SiteClient(
      { url, token: TOKEN },
      { fetch: fetch as unknown as typeof globalThis.fetch, log: { warn: jest.fn() } },
    );
    await c.post(path, {}, schema);
    expect(fetch.mock.calls[0]).toEqual(['https://site.example/api/live/x', expect.anything()]);
  });

  it('keeps a path prefix of the Site URL', async () => {
    const fetch = jest.fn<Promise<Response>, [string, RequestInit?]>(() =>
      Promise.resolve(answer(200, { ok: true })),
    );
    const c = new SiteClient(
      { url: 'https://example.org/site/', token: TOKEN },
      { fetch: fetch as unknown as typeof globalThis.fetch, log: { warn: jest.fn() } },
    );
    await c.post('/api/live/x', {}, schema);
    expect(fetch.mock.calls[0][0]).toBe('https://example.org/site/api/live/x');
  });

  it('a 2xx answer that fails the schema is unavailable', async () => {
    const { c, log } = client(() => Promise.resolve(answer(200, { ok: 'yes' })));
    expect(await c.post('/x', {}, schema)).toEqual({
      ok: false,
      reason: 'unavailable',
      cause: 'answer',
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('a body that is not JSON is unavailable', async () => {
    const { c } = client(() => Promise.resolve(new Response('<html>', { status: 200 })));
    expect(await c.post('/x', {}, schema)).toMatchObject({ ok: false, cause: 'answer' });
  });

  it.each([
    ['a 5xx', () => Promise.resolve(answer(503, { error: 'down' })), 'status'],
    ['a 401', () => Promise.resolve(answer(401, { error: 'unauthorised' })), 'status'],
    ['a network error', () => Promise.reject(new TypeError('fetch failed')), 'network'],
  ] as const)('%s is unavailable, logged once without the token', async (_, impl, cause) => {
    const { c, log } = client(impl);
    expect(await c.post('/x', {}, schema)).toEqual({ ok: false, reason: 'unavailable', cause });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(logged(log)).not.toContain(TOKEN);
  });

  it('a non-2xx answer has its body cancelled, not left open', async () => {
    const res = answer(502, { error: 'bad gateway' });
    const cancel = jest.spyOn(res.body!, 'cancel');
    const { c } = client(() => Promise.resolve(res));
    expect(await c.post('/x', {}, schema)).toMatchObject({ ok: false, cause: 'status' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('a timeout is unavailable, logged once without the token', async () => {
    const { c, log } = client(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
      20,
    );
    expect(await c.post('/x', {}, schema)).toEqual({
      ok: false,
      reason: 'unavailable',
      cause: 'timeout',
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(logged(log)).not.toContain(TOKEN);
  });

  it('waits 3 s by default', () => {
    const c = new SiteClient(access, { fetch: jest.fn(), log: { warn: jest.fn() } });
    expect(c.timeoutMs).toBe(3000);
  });
});

describe('siteAccessOf (the boot check of ESCAPE_SITE_URL and ESCAPE_SITE_TOKEN)', () => {
  it('takes an http(s) URL and a token, trimmed', () => {
    expect(siteAccessOf(' https://site.example ', TOKEN)).toEqual({
      url: 'https://site.example',
      token: TOKEN,
    });
    expect(siteAccessOf('http://localhost:5173', TOKEN).url).toBe('http://localhost:5173');
  });

  it.each(['', '   ', 'site.example', 'ftp://site.example', 'https://'])(
    'refuses the URL %j, failing the boot',
    (url) => {
      expect(() => siteAccessOf(url, TOKEN)).toThrow(/ESCAPE_SITE_URL/);
    },
  );

  it.each(['', ' '.repeat(40), '\t'.repeat(32)])('refuses an empty or blank token', (token) => {
    expect(() => siteAccessOf('https://site.example', token)).toThrow(/ESCAPE_SITE_TOKEN/);
  });

  it('never puts the token in its error', () => {
    try {
      siteAccessOf('nope', TOKEN);
    } catch (err) {
      expect((err as Error).message).not.toContain(TOKEN);
    }
  });
});
