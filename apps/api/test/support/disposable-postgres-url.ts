// Shared fail-closed URL guard for disposable database tests and candidate image proof.
export function assertEphemeralBase(url: string): void {
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      `Refusing to provision a disposable database on non-local host "${host}". ` +
      'The disposable harness may only target a per-job or per-developer PostgreSQL instance.',
    );
  }
  for (const forbidden of ['prod', 'production', 'rds.amazonaws.com', 'supabase', 'neon.tech']) {
    if (url.includes(forbidden)) {
      throw new Error(
        `Refusing to provision a disposable database against a URL containing "${forbidden}".`,
      );
    }
  }
}

