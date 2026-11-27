import { getToken } from 'next-auth/jwt';
import { signOut } from '@/lib/auth/nextauth';
import { afterLogoutUrl } from '@/lib/auth/logout';
import { loadOidcConfig } from '@/lib/auth/oidc-config';
import { tokenStore } from '@/lib/auth/token-store';
import { readPreferences } from '@/lib/preferences/server';

/** Whether the request was sent by a page of this application. */
function sameOrigin(request: Request, appOrigin: string | undefined): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  if (appOrigin) return origin === appOrigin ? origin : null;
  // Sign-in is off, so no public origin is configured: compare with the requested host.
  try {
    return new URL(origin).host === request.headers.get('host') ? origin : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const oidc = await loadOidcConfig();
  const origin = sameOrigin(request, oidc?.appOrigin);
  if (!origin) return new Response(null, { status: 403 });

  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET ?? '',
    secureCookie: origin.startsWith('https:'),
  }).catch(() => null);
  const ended = typeof token?.sid === 'string' ? tokenStore().end(token.sid) : undefined;
  // Clears the session cookie. The server-side tokens are already gone.
  await signOut({ redirect: false });

  const { locale } = await readPreferences();
  const location = await afterLogoutUrl(oidc, origin, ended?.idToken, locale);
  return new Response(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}
