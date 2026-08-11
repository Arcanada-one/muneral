import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Credentials from 'next-auth/providers/credentials';
import { verifyTelegramLogin } from './telegram';
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
        const botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';

        const valid = verifyTelegramLogin(data, botToken);
        if (!valid) return null;

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
    async signIn({ user, account }) {
      if (account?.provider === 'github') {
        try {
          const res = await apiClient.post<{ access_token: string; refresh_token: string }>(
            '/auth/github',
            {
              githubId: account.providerAccountId,
              username: (user as { login?: string }).login ?? user.name ?? '',
              email: user.email ?? '',
              avatarUrl: user.image ?? '',
              name: user.name ?? '',
            },
          );
          (user as Record<string, unknown>).accessToken = res.data.access_token;
          (user as Record<string, unknown>).refreshToken = res.data.refresh_token;
        } catch {
          return false;
        }
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        const u = user as Record<string, unknown>;
        if (typeof u.accessToken === 'string') token.accessToken = u.accessToken;
        if (typeof u.refreshToken === 'string') token.refreshToken = u.refreshToken;
      }
      return token;
    },
    async session({ session, token }) {
      (session as Record<string, unknown>).accessToken = token.accessToken;
      (session as Record<string, unknown>).refreshToken = token.refreshToken;
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
});
