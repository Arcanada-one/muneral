// The session this application sends to the browser (lib/auth/config.ts): the access token, held in
// memory only, and never a refresh or ID token. Declaring the fields keeps every reader and mock
// type-checked. The type import below matters: without it `declare module` replaces the module.
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session extends DefaultSession {
    accessToken?: string;
    loginSessionId?: string;
    error?: 'SessionExpired' | 'TemporarilyUnavailable';
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    sid?: string;
    loginSessionId?: string;
  }
}
