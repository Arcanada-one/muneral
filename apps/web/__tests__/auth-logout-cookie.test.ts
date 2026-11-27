// @vitest-environment node
// Logout with nothing about the cookie mocked: a real encoded session cookie under the https name.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from '@auth/core/jwt';

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock('@/lib/auth/nextauth', () => ({ signOut: mocks.signOut }));
vi.mock('@/lib/preferences/server', () => ({ readPreferences: async () => ({ locale: 'ru', theme: 'light' }) }));

import { POST } from '@/app/api/logout/route';
import { tokenStore } from '@/lib/auth/token-store';

const SECRET = 'synthetic-cookie-secret-for-this-test-only';
const APP = 'https://app.example.test';

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_SECRET', SECRET);
  mocks.signOut.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('logout reads the real session cookie', () => {
  it.each([
    ['https', APP, '__Secure-authjs.session-token'],
    ['local http', 'http://localhost:3501', 'authjs.session-token'],
  ])('ends exactly the login the %s cookie names', async (_label, origin, name) => {
    const mine = tokenStore().create({ accessToken: 'a', expiresAt: Date.now() + 1e6 });
    const other = tokenStore().create({ accessToken: 'b', expiresAt: Date.now() + 1e6 });
    const cookie = await encode({ token: { sid: mine }, secret: SECRET, salt: name });
    const response = await POST(new Request(`${origin}/api/logout`, {
      method: 'POST',
      headers: { origin, host: new URL(origin).host, cookie: `${name}=${cookie}` },
    }));
    expect(response.status).toBe(303);
    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false });
    expect(tokenStore().end(mine)).toBeUndefined();
    expect(tokenStore().end(other)).toBeDefined();
  });
});
