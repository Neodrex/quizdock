/**
 * The Site's internal API (M8 §1.2), the one way Live talks to the Site:
 * a JSON POST with the shared bearer token, a 3 s timeout, every answer checked
 * with zod. Any failure is `unavailable`, so the callers fail closed.
 */
import type { Logger } from '@nestjs/common';
import type { z } from 'zod';

/** Where the Site is (ESCAPE_SITE_URL) and the token it expects (ESCAPE_SITE_TOKEN). */
export interface SiteAccess {
  url: string;
  token: string;
}

/** Why a call failed, for the logs and the one retry callers may make. */
export type SiteFailure = 'network' | 'timeout' | 'status' | 'answer';

export type SiteResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unavailable'; cause: SiteFailure };

export const SITE_TIMEOUT_MS = 3000;

/**
 * The settings checked at boot: an http(s) URL and a token that is not blank.
 * Throws (failing the boot) otherwise, never with the token in the message.
 */
export function siteAccessOf(rawUrl: string, rawToken: string): SiteAccess {
  const url = rawUrl.trim();
  let parsed: URL | null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('ESCAPE_SITE_URL is not an http(s) URL.');
  }
  if (!rawToken.trim()) {
    throw new Error('ESCAPE_SITE_TOKEN is empty or blank (32 characters or more).');
  }
  return { url, token: rawToken };
}

export class SiteClient {
  readonly timeoutMs: number;
  private readonly fetch: typeof globalThis.fetch;
  private readonly log: Pick<Logger, 'warn'>;
  private readonly base: string;

  constructor(
    private readonly access: SiteAccess,
    opts: {
      fetch?: typeof globalThis.fetch;
      log: Pick<Logger, 'warn'>;
      timeoutMs?: number;
    },
  ) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.log = opts.log;
    this.timeoutMs = opts.timeoutMs ?? SITE_TIMEOUT_MS;
    this.base = access.url.replace(/\/+$/, '');
  }

  /** POSTs `body` to the Site's `path`; the answer parsed by `schema`, or `unavailable`. */
  async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<SiteResult<T>> {
    const url = `${this.base}/${path.replace(/^\/+/, '')}`;
    const fail = (cause: SiteFailure, detail: string): SiteResult<T> => {
      // The path only, never the token (it travels in a header and is not logged).
      this.log.warn(`site ${path}: unavailable (${cause}: ${detail})`);
      return { ok: false, reason: 'unavailable', cause };
    };
    let res: Response;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.access.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        return fail('timeout', `no answer within ${this.timeoutMs} ms`);
      }
      return fail('network', e?.message ?? String(err));
    }
    if (!res.ok) return fail('status', `HTTP ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return fail('answer', 'not JSON');
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
      return fail('answer', `unexpected shape at ${paths.join(', ')}`);
    }
    return { ok: true, value: parsed.data };
  }
}
