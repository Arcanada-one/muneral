import NextAuth from 'next-auth';
import { buildAuthConfig } from './config';
import { loadOidcConfig } from './oidc-config';

export const { handlers, signIn, signOut, auth } = NextAuth(async () =>
  buildAuthConfig(await loadOidcConfig()),
);
