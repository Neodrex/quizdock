import { Logger } from '@nestjs/common';
import { generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { OidcProvider } from '../../auth/oidc.provider';
import { AuthDeprecations } from '../../auth/oidc/deprecations';

/**
 * Live signs in with the Site (M8 §6): Supabase's OAuth server is the OIDC
 * provider and `live_roles` comes from its custom access token hook. The
 * spike found the claim in the access token only, so the roles reach the
 * principal through the deprecated access-token fallback (removed at 1.0).
 */
const ISSUER = 'http://127.0.0.1:54321/auth/v1';
const SUB = 'fd2429c6-5b0e-4b4c-9a51-2f5ad3a1c0de';
const CLIENT = '5f114aab-0bd1-45ed-98c9-1364d4c7de7b';

let key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
const sign = (claims: JWTPayload, audience: string) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'site-key', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setSubject(SUB)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

/** The ID token claims as the spike saw them: no `live_roles`. */
const idClaims = (): JWTPayload => ({
  iss: ISSUER,
  sub: SUB,
  aud: CLIENT,
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  nonce: 'n1',
  auth_time: Math.floor(Date.now() / 1000),
  email: 'dev@example.com',
  email_verified: true,
  phone_number_verified: false,
  name: 'Dev',
  updated_at: 1795420000,
  client_id: CLIENT,
});

const accessToken = (liveRoles: string[]) =>
  sign(
    { role: 'authenticated', client_id: CLIENT, email: 'dev@example.com', live_roles: liveRoles },
    'authenticated',
  );

describe('Supabase as the OIDC provider (M8 Task 8.11)', () => {
  const env = process.env;
  const was = env.OIDC_ROLES_CLAIM;
  let warn: jest.SpyInstance;
  let provider: OidcProvider;

  beforeAll(async () => {
    key = (await generateKeyPair('ES256')).privateKey;
  });

  beforeEach(() => {
    env.OIDC_ROLES_CLAIM = 'live_roles';
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const deprecations = new AuthDeprecations({ set: jest.fn().mockResolvedValue('OK') } as never);
    provider = new OidcProvider({} as never, {} as never, deprecations);
  });

  afterEach(() => {
    warn.mockRestore();
    if (was === undefined) delete env.OIDC_ROLES_CLAIM;
    else env.OIDC_ROLES_CLAIM = was;
  });

  it('a Site host: the role from the access token, the verified email, the warning logged', async () => {
    expect(provider.sessionPrincipal(idClaims(), await accessToken(['host']))).toEqual({
      sub: SUB,
      displayName: 'Dev',
      email: 'dev@example.com',
      roles: ['host'],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Roles read from the access token'));
  });

  it('a Site member: no role', async () => {
    expect(provider.sessionPrincipal(idClaims(), await accessToken([]))).toMatchObject({
      sub: SUB,
      roles: [],
    });
  });

  it('the subject is the Supabase user id, a UUID the Site matches facilitators on', async () => {
    const principal = provider.sessionPrincipal(idClaims(), await accessToken(['host']));
    expect(principal?.sub).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
