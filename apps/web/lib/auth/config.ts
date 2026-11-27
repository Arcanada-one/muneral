import { customFetch } from '@auth/core';
import type { NextAuthConfig } from 'next-auth';
import { refreshTokens, tokenRequestFetch } from './auth-arcana';
import { API_RESOURCE, PROVIDER_ID, SCOPES, type OidcConfig } from './oidc-config';
import { tokenStore } from './token-store';

const SESSION_MAX_AGE_SECONDS = 14 * 24 * 60 * 60;

function provider(oidc: OidcConfig): NextAuthConfig['providers'][number] {
  return {
    id: PROVIDER_ID,
    name: 'Arcana',
    type: 'oidc',
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    client: {
      token_endpoint_auth_method: 'private_key_jwt',
      id_token_signed_response_alg: 'EdDSA',
    },
    token: { clientPrivateKey: oidc.privateKey },
    // The Auth.js default is PKCE alone.
    checks: ['pkce', 'state', 'nonce'],
    // prompt=consent: without it the provider drops offline_access, and with it the refresh token.
    authorization: { params: { scope: SCOPES, resource: API_RESOURCE, prompt: 'consent' } },
    profile: (profile: { sub?: string | null; name?: string | null }) => ({
      id: profile.sub ?? undefined,
      name: profile.name ?? null,
    }),
    [customFetch]: tokenRequestFetch(oidc),
  };
}

export function buildAuthConfig(oidc: OidcConfig | null): NextAuthConfig {
  return {
    providers: oidc ? [provider(oidc)] : [],
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_SECONDS },
    secret: process.env.NEXTAUTH_SECRET,
    // Every page Auth.js would draw itself is the login page, which has the switchers.
    pages: {
      signIn: '/login',
      signOut: '/signout',
      error: '/auth-error',
      verifyRequest: '/auth-error',
    },
    callbacks: {
      // The returned token is the whole content of the session cookie. It is built from scratch so
      // that no provider token or profile field can be carried into it.
      async jwt({ token, user, account }) {
        if (account) {
          const accessToken = account.access_token;
          const idToken = account.id_token;
          if (account.provider !== PROVIDER_ID || !accessToken || !idToken) {
            throw new Error('Sign-in did not return the expected tokens');
          }
          const sid = tokenStore().create({
            accessToken,
            idToken,
            refreshToken: account.refresh_token,
            expiresAt: account.expires_at
              ? account.expires_at * 1000
              : Date.now() + 300_000,
          });
          return {
            name: user?.name ?? null,
            sub: account.providerAccountId,
            sid,
            loginSessionId: crypto.randomUUID(),
          };
        }
        // A cookie without a server-side id (from an earlier sign-in method) is dropped.
        if (typeof token.sid !== 'string') return null;
        return {
          name: token.name,
          sub: token.sub,
          sid: token.sid,
          loginSessionId: token.loginSessionId,
        };
      },
      // What the browser receives from /api/auth/session. Refresh and ID tokens never appear here;
      // the access token is held by page scripts in memory only, to call the API.
      async session({ session, token }) {
        const base = {
          expires: session.expires,
          // Always present: next-auth's server-side auth() falls back to the raw token without it.
          user: { name: token.name ?? null },
          loginSessionId: token.loginSessionId as string | undefined,
        };
        const access =
          oidc && typeof token.sid === 'string'
            ? await tokenStore().access(token.sid, (value) => refreshTokens(oidc, value))
            : ({ status: 'expired' } as const);
        if (access.status === 'ok') return { ...base, accessToken: access.accessToken };
        return {
          ...base,
          error: access.status === 'expired' ? 'SessionExpired' : 'TemporarilyUnavailable',
        } as typeof base;
      },
    },
    events: {
      async signOut(message) {
        const sid = 'token' in message ? message.token?.sid : undefined;
        if (typeof sid === 'string') tokenStore().end(sid);
      },
    },
  };
}
