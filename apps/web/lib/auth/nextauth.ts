import { randomUUID } from 'node:crypto';
import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Credentials from 'next-auth/providers/credentials';
import { apiClient } from '@/lib/api/client';
import { z } from 'zod';

const telegramSchema = z.object({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  photo_url: z.string().optional(),
  auth_date: z.number(),
  hash: z.string(),
});

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID ?? '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
    }),
    Credentials({
      id: 'telegram',
      name: 'Telegram',
      credentials: {
        telegramData: { label: 'Telegram Data', type: 'text' },
      },
      async authorize(credentials) {
        const raw = credentials?.telegramData;
        if (typeof raw !== 'string') return null;

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return null;
        }

        const result = telegramSchema.safeParse(parsed);
        if (!result.success) return null;

        const data = result.data;

        try {
          const res = await apiClient.post<{ access_token: string; refresh_token: string }>(
            '/auth/telegram',
            data,
          );
          return {
            id: String(data.id),
            name: data.first_name + (data.last_name ? ` ${data.last_name}` : ''),
            image: data.photo_url ?? null,
            accessToken: res.data.access_token,
            refreshToken: res.data.refresh_token,
          };
        } catch {
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, account }) {
      if (account?.provider === 'github') {
        if (!account.access_token) {
          throw new Error('GitHub sign-in did not return an access token');
        }
        const { data } = await apiClient.post<{ access_token: string; refresh_token: string }>(
          '/auth/github',
          { access_token: account.access_token },
        ).catch(() => {
          // Axios errors may carry request bodies. Keep the provider token out of Auth.js logs.
          throw new Error('GitHub sign-in could not be completed');
        });
        token.accessToken = data.access_token;
        token.refreshToken = data.refresh_token;
      } else if (user) {
        const u = user as Record<string, unknown>;
        if (typeof u.accessToken === 'string') token.accessToken = u.accessToken;
        if (typeof u.refreshToken === 'string') token.refreshToken = u.refreshToken;
      }
      if (account && user) token.loginSessionId = randomUUID();
      return token;
    },
    async session({ session, token }) {
      return Object.assign(session, {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        loginSessionId: token.loginSessionId,
      });
    },
  },
  pages: {
    signIn: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
});
