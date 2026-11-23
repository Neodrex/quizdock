import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import { SiteClient } from '../../src/escape/site/site-client';

/**
 * A stub of the Site's internal API (M8 §1.2) on a real HTTP port, for the
 * integration tests of the Site adapters: it checks the bearer token, records
 * every call and answers with what the test set per path. `down` makes every
 * call fail (a 503), as an unreachable Site would for the client.
 */
export interface SiteStub {
  url: string;
  token: string;
  calls: { path: string; body: unknown }[];
  /** The answer per path (exact path, or a function of the body). */
  answers: Map<string, unknown | ((body: unknown) => unknown)>;
  down: boolean;
  client(): SiteClient;
  reset(): void;
  close(): Promise<void>;
}

export const SITE_TOKEN = 'stub-site-token-'.padEnd(40, 's');

export async function startSiteStub(): Promise<SiteStub> {
  const stub = {
    url: '',
    token: SITE_TOKEN,
    calls: [] as SiteStub['calls'],
    answers: new Map<string, unknown>(),
    down: false,
  } as SiteStub;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${SITE_TOKEN}`) return send(401, {});
      const path = req.url ?? '';
      const body: unknown = raw ? JSON.parse(raw) : null;
      stub.calls.push({ path, body });
      if (stub.down) return send(503, { error: 'down' });
      const answer = stub.answers.get(path);
      if (answer === undefined) return send(404, { error: 'no stub answer' });
      send(200, typeof answer === 'function' ? (answer as (b: unknown) => unknown)(body) : answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.client = () =>
    new SiteClient({ url: stub.url, token: SITE_TOKEN }, { log: new Logger('SiteStubClient') });
  stub.reset = () => {
    stub.calls.length = 0;
    stub.answers.clear();
    stub.down = false;
  };
  stub.close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      // fetch keeps its sockets alive: close them, or the server never closes.
      server.closeAllConnections();
    });
  return stub;
}

/** Swaps a private port of an object for the duration of a test block; returns the undo. */
export function swapPort<T extends object>(target: T, field: string, port: unknown): () => void {
  const holder = target as unknown as Record<string, unknown>;
  const was = holder[field];
  holder[field] = port;
  return () => {
    holder[field] = was;
  };
}
