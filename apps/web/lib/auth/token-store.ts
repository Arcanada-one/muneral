/**
 * Where the Auth Arcana tokens live: in the memory of the web server process. The browser holds only
 * an encrypted HttpOnly cookie with an opaque id that points here.
 *
 * Why not in the cookie: Auth rotates refresh tokens and treats reuse as theft, and a server
 * component render cannot write cookies, so a rotation made there would be lost. Here a rotation
 * is saved wherever it happens, and concurrent callers share one refresh.
 *
 * Limits: one web process only; a restart signs every user out (fail closed).
 */
import { RefreshRefused, type RefreshedTokens } from './auth-arcana';

export interface Login {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Access token expiry, in milliseconds since the epoch. */
  expiresAt: number;
}

interface Entry extends Login {
  touchedAt: number;
  refreshing?: Promise<void>;
}

export type Access =
  | { status: 'ok'; accessToken: string }
  | { status: 'expired' }
  | { status: 'unavailable' };

/** Refresh this long before expiry, so a token handed to the browser is still usable. */
export const REFRESH_MARGIN_MS = 60_000;
export const IDLE_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_LOGINS = 10_000;

export class TokenStore {
  private readonly logins = new Map<string, Entry>();

  constructor(private readonly maxLogins = MAX_LOGINS) {}

  create(login: Login, now = Date.now()): string {
    this.prune(now);
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    this.logins.set(id, { ...login, touchedAt: now });
    return id;
  }

  /** Removes the login and returns what logout needs. */
  end(id: string): Login | undefined {
    const login = this.logins.get(id);
    this.logins.delete(id);
    return login;
  }

  async access(
    id: string,
    refresh: (refreshToken: string) => Promise<RefreshedTokens>,
    clock: () => number = Date.now,
  ): Promise<Access> {
    const entry = this.logins.get(id);
    if (!entry || clock() - entry.touchedAt > IDLE_LIMIT_MS) {
      this.logins.delete(id);
      return { status: 'expired' };
    }
    entry.touchedAt = clock();
    if (entry.expiresAt - clock() > REFRESH_MARGIN_MS) {
      return { status: 'ok', accessToken: entry.accessToken };
    }
    if (entry.refreshToken) {
      // Single flight: the check and the assignment happen without an await in between.
      entry.refreshing ??= this.rotate(id, entry, entry.refreshToken, refresh, clock).finally(() => {
        entry.refreshing = undefined;
      });
      await entry.refreshing;
    }
    // Logout or a refused grant may have removed the login while we waited.
    if (this.logins.get(id) !== entry) return { status: 'expired' };
    if (entry.expiresAt > clock()) return { status: 'ok', accessToken: entry.accessToken };
    if (!entry.refreshToken) {
      this.logins.delete(id);
      return { status: 'expired' };
    }
    return { status: 'unavailable' };
  }

  private async rotate(
    id: string,
    entry: Entry,
    refreshToken: string,
    refresh: (refreshToken: string) => Promise<RefreshedTokens>,
    clock: () => number,
  ): Promise<void> {
    try {
      const tokens = await refresh(refreshToken);
      entry.accessToken = tokens.accessToken;
      entry.refreshToken = tokens.refreshToken ?? refreshToken;
      entry.idToken = tokens.idToken ?? entry.idToken;
      entry.expiresAt = clock() + tokens.expiresInSeconds * 1000;
    } catch (error) {
      if (error instanceof RefreshRefused) {
        if (this.logins.get(id) === entry) this.logins.delete(id);
      }
      // Anything else is temporary; the next call tries again.
    }
  }

  private prune(now: number): void {
    for (const [id, entry] of this.logins) {
      if (now - entry.touchedAt > IDLE_LIMIT_MS) this.logins.delete(id);
    }
    // A Map iterates in insertion order, so the first key is the oldest login.
    while (this.logins.size >= this.maxLogins) {
      const oldest = this.logins.keys().next().value;
      if (oldest === undefined) break;
      this.logins.delete(oldest);
    }
  }
}

// Route handlers and server components can load separate copies of a module in one process.
const STORE = Symbol.for('muneral.web.token-store');
const shared = globalThis as typeof globalThis & { [STORE]?: TokenStore };

export function tokenStore(): TokenStore {
  shared[STORE] ??= new TokenStore();
  return shared[STORE];
}
