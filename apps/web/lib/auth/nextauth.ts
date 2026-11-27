import NextAuth from 'next-auth';
import { z } from 'zod';
import { buildAuthConfig } from './config';
import { loadOidcConfig } from './oidc-config';

// Unused on purpose (its Telegram provider is removed): follow-up Muneral task 133e3530-be16-4b67-9551-5fcbbc135e88.
const telegramSchema = z.object({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.number(),
  hash: z.string(),
});

export const { handlers, signIn, signOut, auth } = NextAuth(async () =>
  buildAuthConfig(await loadOidcConfig()),
);
