// The session this application issues carries the Auth Arcana tokens: lib/auth/nextauth.ts
// returns accessToken and refreshToken from its session callback. The Session type of
// next-auth declares neither, so every reader cast the session to Record<string, unknown>
// to reach them - a cast that also silences a genuine typo.
//
// Surfaced by vitest 4: ReturnType<typeof vi.fn> erased the mocked signature, so
// mockResolvedValue({ accessToken }) was never checked against Session. vi.mocked() keeps
// the real signature, and the missing declaration became visible.
//
// Measured while writing this file: with NO import at all, declare module is a REPLACEMENT
// rather than an augmentation - it erased the callback types of next-auth and produced six
// fresh TS7031 "implicitly has an any type" errors in lib/auth/nextauth.ts, against a
// baseline of zero measured on a clean clone of main.
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session extends DefaultSession {
    accessToken?: string;
    refreshToken?: string | null;
  }
}
