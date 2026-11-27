// @vitest-environment node
// The real Auth.js core, driven request by request, against a stand-in Auth Arcana.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth, skipCSRFCheck, type AuthConfig } from '@auth/core';
import { decode } from '@auth/core/jwt';
import { buildAuthConfig } from '@/lib/auth/config';
import { readOidcConfig, type OidcConfig } from '@/lib/auth/oidc-config';
import { tokenStore } from '@/lib/auth/token-store';
import { APP, CLIENT_ID, FakeAuth, ISSUER, SUBJECT, clientKeyPair } from '../test-support/fake-auth-arcana';

const COOKIE = '__Secure-authjs.session-token';
const keys = clientKeyPair();
const environment = {
  AUTH_ARCANA_ISSUER: ISSUER,
  AUTH_ARCANA_CLIENT_ID: CLIENT_ID,
  AUTH_ARCANA_CLIENT_PRIVATE_KEY: keys.pem,
  AUTH_URL: APP,
  NEXTAUTH_SECRET: 'synthetic-cookie-secret-for-this-test-only',
};

class Browser {
  readonly jar = new Map<string, string>();
  readonly seen: string[] = [];
  constructor(private readonly config: AuthConfig) {}

  async send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('cookie', [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const response = await Auth(new Request(`${APP}${path}`, { ...init, headers }), this.config);
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (value) this.jar.set(name, value);
      else this.jar.delete(name);
      this.seen.push(line);
    }
    this.seen.push(response.headers.get('location') ?? '', await response.clone().text());
    return response;
  }

  async startSignIn(query = ''): Promise<URL> {
    const response = await this.send(`/api/auth/signin/arcanada${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ callbackUrl: `${APP}/workspaces` }),
    });
    return new URL(response.headers.get('location') ?? 'about:blank');
  }

  async session(): Promise<Record<string, any> | null> {
    return (await this.send('/api/auth/session')).json();
  }
}

let fake: FakeAuth;
let oidc: OidcConfig;
let config: AuthConfig;

beforeEach(async () => {
  fake = new FakeAuth(keys.publicKey);
  vi.stubGlobal('fetch', fake.fetch);
  vi.stubEnv('NEXTAUTH_SECRET', environment.NEXTAUTH_SECRET);
  oidc = (await readOidcConfig(environment))!;
  config = {
    ...(buildAuthConfig(oidc) as AuthConfig),
    basePath: '/api/auth',
    trustHost: true,
    skipCSRFCheck,
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Runs the authorization request and returns the callback path Auth would redirect to. */
async function authorize(browser: Browser) {
  const target = await browser.startSignIn();
  fake.challenge = target.searchParams.get('code_challenge') ?? '';
  fake.nonce = target.searchParams.get('nonce') ?? undefined;
  return {
    target,
    callback: `/api/auth/callback/arcanada?${new URLSearchParams({
      code: 'synthetic-code', state: target.searchParams.get('state') ?? '',
    })}`,
  };
}

async function signedIn() {
  const browser = new Browser(config);
  const { callback } = await authorize(browser);
  await browser.send(callback);
  expect(browser.jar.has(COOKIE)).toBe(true);
  return browser;
}

function expectRefused(browser: Browser, response: Response) {
  expect(response.headers.get('location')).toMatch(/\/(login|auth-error)\?error=/);
  expect(browser.jar.has(COOKIE)).toBe(false);
}

describe('sign-in through Auth Arcana', () => {
  it('asks for a code with PKCE S256, state, nonce, the API resource and offline access', async () => {
    const browser = new Browser(config);
    const target = await browser.startSignIn('?ui_locales=ru');
    expect(target.origin + target.pathname).toBe(`${ISSUER}/oidc/auth`);
    expect(Object.fromEntries(target.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: `${APP}/api/auth/callback/arcanada`,
      scope: 'openid offline_access muneral:api',
      resource: 'urn:arcanada:muneral:api',
      prompt: 'consent',
      code_challenge_method: 'S256',
      ui_locales: 'ru',
    });
    for (const name of ['state', 'nonce', 'code_challenge']) {
      expect(target.searchParams.get(name)?.length).toBeGreaterThan(20);
    }
  });

  it('exchanges the code with an EdDSA private_key_jwt, the resource and no shared secret', async () => {
    const browser = await signedIn();
    const [exchange] = fake.calls;
    expect(exchange.body.get('grant_type')).toBe('authorization_code');
    expect(exchange.body.get('resource')).toBe('urn:arcanada:muneral:api');
    expect(exchange.body.get('client_id')).toBe(CLIENT_ID);
    expect(exchange.body.has('client_secret')).toBe(false);
    expect(exchange.assertion?.signatureValid).toBe(true);
    expect(exchange.assertion?.header).toEqual({ alg: 'EdDSA', typ: 'JWT' });
    expect(exchange.assertion?.claims).toMatchObject({ iss: CLIENT_ID, sub: CLIENT_ID, aud: ISSUER });
    expect(exchange.assertion!.claims.exp - exchange.assertion!.claims.iat).toBe(60);
    expect(browser.jar.has(COOKIE)).toBe(true);
  });

  // Scope: sign-in and session reads. At logout the ID token is sent to Auth as id_token_hint, in a
  // redirect address the browser follows (auth-logout tests).
  it('gives the browser the access token only, through sign-in and session reads', async () => {
    const browser = await signedIn();
    const session = await browser.session();
    expect(Object.keys(session!).sort()).toEqual(['accessToken', 'expires', 'loginSessionId', 'user']);
    expect(session!.accessToken).toBe('fake-access-1');
    expect(session!.user).toEqual({ name: null });

    const cookie = await decode({ token: browser.jar.get(COOKIE)!, secret: environment.NEXTAUTH_SECRET, salt: COOKIE });
    expect(Object.keys(cookie!).sort()).toEqual(['exp', 'iat', 'jti', 'loginSessionId', 'name', 'sid', 'sub']);
    expect(cookie!.sub).toBe(SUBJECT);
    expect(JSON.stringify(cookie)).not.toMatch(/fake-access|fake-refresh|eyJ/);

    const everything = browser.seen.join('\n');
    expect(everything).not.toContain('fake-refresh');
    expect(everything).not.toMatch(/id_token|refresh_?[Tt]oken/);
    expect(everything).not.toContain(cookie!.sid as string);
    for (const line of browser.seen.filter((value) => value.startsWith(`${COOKIE}=`))) {
      expect(line).toMatch(/HttpOnly/i);
      expect(line).toMatch(/Secure/i);
      expect(line).toMatch(/SameSite=Lax/i);
    }
  });

  describe('refuses', () => {
    it('a callback whose state does not match, without calling the token endpoint', async () => {
      const browser = new Browser(config);
      await authorize(browser);
      expectRefused(browser, await browser.send('/api/auth/callback/arcanada?code=synthetic-code&state=forged'));
      expect(fake.calls).toHaveLength(0);
    });

    it.each(['state', 'pkce.code_verifier', 'nonce'])('a callback without the %s cookie', async (name) => {
      const browser = new Browser(config);
      const { callback } = await authorize(browser);
      const cookie = [...browser.jar.keys()].find((key) => key.endsWith(name));
      expect(cookie).toBeDefined();
      browser.jar.delete(cookie!);
      expectRefused(browser, await browser.send(callback));
    });

    it('a code whose PKCE verifier does not match the challenge', async () => {
      const browser = new Browser(config);
      const { callback } = await authorize(browser);
      fake.challenge = 'a-different-challenge';
      expectRefused(browser, await browser.send(callback));
    });

    it.each([
      ['another nonce', () => { fake.nonce = 'forged-nonce'; }],
      ['no nonce', () => { fake.nonce = undefined; }],
      ['another issuer', () => { fake.idToken = { claims: { iss: 'https://evil.example' } }; }],
      ['another audience', () => { fake.idToken = { claims: { aud: 'another-client' } }; }],
      ['an expired lifetime', () => { fake.idToken = { claims: { exp: 1 } }; }],
      ['a symmetric alg', () => { fake.idToken = { alg: 'HS256' }; }],
      ['no signature alg', () => { fake.idToken = { alg: 'none' }; }],
    ])('an ID token with %s', async (_label, spoil) => {
      const browser = new Browser(config);
      const { callback } = await authorize(browser);
      spoil();
      expectRefused(browser, await browser.send(callback));
    });
  });
});

describe('server-side refresh', () => {
  const grants = () => fake.calls.filter((call) => call.body.get('grant_type') === 'refresh_token');

  async function dueForRefresh() {
    // 30 s left is inside the 60 s margin, so the next session read must refresh.
    fake.accessLifetime = 30;
    const browser = await signedIn();
    fake.accessLifetime = 300;
    return browser;
  }

  it('refreshes once for concurrent requests carrying the same cookie', async () => {
    const browser = await dueForRefresh();
    let open!: () => void;
    fake.refreshGate = new Promise<void>((resolve) => { open = resolve; });
    const parallel = Promise.all(Array.from({ length: 8 }, () => browser.session()));
    await vi.waitFor(() => expect(grants()).toHaveLength(1));
    open();
    expect((await parallel).map((s) => s!.accessToken)).toEqual(Array(8).fill('fake-access-2'));
    expect(grants()).toHaveLength(1);
    expect(fake.reuseDetected).toBe(false);
    const [grant] = grants();
    expect(grant.body.get('resource')).toBe('urn:arcanada:muneral:api');
    expect(grant.assertion?.header.alg).toBe('EdDSA');
    expect(grant.assertion?.signatureValid).toBe(true);
  });

  it('keeps the rotation when the response cookie is thrown away, as in a server render', async () => {
    const browser = await dueForRefresh();
    const stale = new Map(browser.jar);
    // A server component render: the session is read and every Set-Cookie is discarded.
    expect((await browser.session())!.accessToken).toBe('fake-access-2');
    browser.jar.clear();
    stale.forEach((value, key) => browser.jar.set(key, value));
    // The client call that follows still carries the old cookie.
    expect((await browser.session())!.accessToken).toBe('fake-access-2');
    expect(grants()).toHaveLength(1);
    expect(fake.reuseDetected).toBe(false);
  });

  it('uses the rotated refresh token the next time, never a spent one', async () => {
    const browser = await dueForRefresh();
    fake.accessLifetime = 30;
    await browser.session();
    fake.accessLifetime = 300;
    await browser.session();
    expect(grants().map((call) => call.body.get('refresh_token'))).toEqual(['fake-refresh-1', 'fake-refresh-2']);
    expect(fake.reuseDetected).toBe(false);
  });

  it('ends the login when Auth refuses the grant', async () => {
    const browser = await dueForRefresh();
    fake.refreshBehaviour = 'invalid_grant';
    const session = await browser.session();
    expect(session).toMatchObject({ error: 'SessionExpired' });
    expect(session).not.toHaveProperty('accessToken');
    expect(session!.user).toEqual({ name: null });
    fake.refreshBehaviour = 'ok';
    expect(await browser.session()).toMatchObject({ error: 'SessionExpired' });
    expect(grants()).toHaveLength(1);
  });

  it.each(['network', 'server_error'] as const)('keeps the login through a %s failure', async (failure) => {
    const browser = await dueForRefresh();
    fake.refreshBehaviour = failure;
    // The current token is still valid for 30 s, so it stays in use.
    expect((await browser.session())!.accessToken).toBe('fake-access-1');
    vi.setSystemTime(Date.now() + 40_000);
    try {
      expect(await browser.session()).toMatchObject({ error: 'TemporarilyUnavailable' });
      fake.refreshBehaviour = 'ok';
      expect((await browser.session())!.accessToken).toBe('fake-access-2');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('end of a login', () => {
  it('forgets the server tokens when Auth.js signs out', async () => {
    const browser = await signedIn();
    const stale = new Map(browser.jar);
    await browser.send('/api/auth/signout', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(),
    });
    expect(browser.jar.has(COOKIE)).toBe(false);
    stale.forEach((value, key) => browser.jar.set(key, value));
    expect(await browser.session()).toMatchObject({ error: 'SessionExpired' });
  });

  it('treats a cookie as expired when the server no longer holds the login (restart)', async () => {
    const browser = await signedIn();
    const cookie = await decode({ token: browser.jar.get(COOKIE)!, secret: environment.NEXTAUTH_SECRET, salt: COOKIE });
    tokenStore().end(cookie!.sid as string);
    expect(await browser.session()).toMatchObject({ error: 'SessionExpired' });
  });
});

describe('without configuration sign-in is off', () => {
  it('registers no provider, makes no request to Auth and honours no earlier cookie', async () => {
    const browser = await signedIn();
    const requests = fake.requested.length;
    const off: AuthConfig = {
      ...(buildAuthConfig(null) as AuthConfig),
      basePath: '/api/auth', trustHost: true, skipCSRFCheck,
      logger: { error: () => {}, warn: () => {}, debug: () => {} },
    };
    expect(off.providers).toEqual([]);
    const other = new Browser(off);
    browser.jar.forEach((value, key) => other.jar.set(key, value));
    expect(await other.session()).toMatchObject({ error: 'SessionExpired' });
    const target = await new Browser(off).startSignIn();
    expect(target.origin).not.toBe(ISSUER);
    expect(fake.requested).toHaveLength(requests);
  });
});
