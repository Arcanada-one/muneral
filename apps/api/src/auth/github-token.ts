import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { GithubProfile } from './dto/github-profile.dto.js';

/** Resolve the bearer token against this OAuth app before trusting its user. */
export async function verifyGithubToken(accessToken: string): Promise<GithubProfile> {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) {
    throw new ServiceUnavailableException('GitHub exchange is not configured');
  }

  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  let result: {
    app?: { client_id?: unknown };
    user?: { id?: unknown; login?: unknown; avatar_url?: unknown };
  } | null;
  try {
    const response = await fetch(
      `https://api.github.com/applications/${encodeURIComponent(clientId)}/token`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${authorization}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        body: JSON.stringify({ access_token: accessToken }),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      },
    );
    result = response.status === 200 ? await response.json() : null;
  } catch {
    throw new ServiceUnavailableException('GitHub token verification is unavailable');
  }

  const user = result?.user;
  if (
    result?.app?.client_id !== clientId ||
    typeof user?.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0 ||
    typeof user.login !== 'string' || user.login.length === 0
  ) {
    throw new UnauthorizedException('Invalid GitHub exchange token');
  }

  return {
    id: String(user.id),
    username: user.login,
    displayName: user.login,
    photos: typeof user.avatar_url === 'string' ? [{ value: user.avatar_url }] : [],
  };
}
