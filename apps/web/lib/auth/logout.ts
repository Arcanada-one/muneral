import { discover } from './auth-arcana';
import type { OidcConfig } from './oidc-config';

/**
 * Where the browser goes after the local session is gone: Auth's end_session endpoint, so the
 * Auth session ends too, or the local login page when Auth cannot be reached.
 */
export async function afterLogoutUrl(
  oidc: OidcConfig | null,
  appOrigin: string,
  idToken: string | undefined,
  uiLocale: string,
): Promise<string> {
  const login = `${appOrigin}/login`;
  if (!oidc) return login;
  try {
    const { endSessionEndpoint } = await discover(oidc);
    if (!endSessionEndpoint) return login;
    const url = new URL(endSessionEndpoint);
    url.searchParams.set('client_id', oidc.clientId);
    url.searchParams.set('post_logout_redirect_uri', login);
    url.searchParams.set('ui_locales', uiLocale);
    if (idToken) url.searchParams.set('id_token_hint', idToken);
    return url.href;
  } catch {
    return login;
  }
}
