/**
 * Focused unit controls for disposable PostgreSQL mode selection.
 *
 * These exercise the real planDisposablePostgresProvision helper with declared
 * Docker-boundary doubles only. They do not open sockets, run Docker, connect
 * to PostgreSQL, or apply migrations — those remain NOT_MEASURED here.
 */
import { jest as _jestRuntime } from '@jest/globals';
import { planDisposablePostgresProvision } from './disposable-postgres.js';

const jest = _jestRuntime as unknown as typeof globalThis.jest;

const EPHEMERAL_BASE = 'postgresql://muneral_test:muneral_test_pass@127.0.0.1:5432/postgres';

describe('planDisposablePostgresProvision', () => {
  it('honors explicit MUN0021_PG_BASE_URL before any Docker/sudo probe', () => {
    const resolveDocker = jest.fn(() => {
      throw new Error('resolveDocker must not run when explicit base is set');
    });

    const plan = planDisposablePostgresProvision(
      { MUN0021_PG_BASE_URL: EPHEMERAL_BASE, DATABASE_URL: 'postgresql://should-not-use@127.0.0.1/db' },
      resolveDocker,
    );

    expect(plan).toEqual({ kind: 'database', baseUrl: EPHEMERAL_BASE });
    expect(resolveDocker).not.toHaveBeenCalled();
  });

  it('refuses invalid explicit base before Docker probes or fallback', () => {
    const resolveDocker = jest.fn(() => ['docker']);

    expect(() =>
      planDisposablePostgresProvision(
        { MUN0021_PG_BASE_URL: 'postgresql://prod.example.com:5432/app' },
        resolveDocker,
      ),
    ).toThrow(/non-local host/);

    expect(resolveDocker).not.toHaveBeenCalled();
  });

  it('refuses forbidden explicit base tokens without Docker fallback', () => {
    const resolveDocker = jest.fn(() => ['docker']);

    expect(() =>
      planDisposablePostgresProvision(
        // "prod" is checked before "production"; assert the real refusal token.
        { MUN0021_PG_BASE_URL: 'postgresql://127.0.0.1:5432/production_scratch' },
        resolveDocker,
      ),
    ).toThrow(/containing "prod"/);

    expect(resolveDocker).not.toHaveBeenCalled();
  });

  it('preserves Docker-first selection when explicit base is absent', () => {
    const resolveDocker = jest.fn(() => ['sudo', '-n', 'docker']);

    const plan = planDisposablePostgresProvision(
      { DATABASE_URL: EPHEMERAL_BASE },
      resolveDocker,
    );

    expect(plan).toEqual({ kind: 'container', dockerCmd: ['sudo', '-n', 'docker'] });
    expect(resolveDocker).toHaveBeenCalledTimes(1);
  });

  it('falls back to DATABASE_URL only after Docker resolution misses', () => {
    const resolveDocker = jest.fn(() => null);

    const plan = planDisposablePostgresProvision(
      { DATABASE_URL: EPHEMERAL_BASE },
      resolveDocker,
    );

    expect(plan).toEqual({ kind: 'database', baseUrl: EPHEMERAL_BASE });
    expect(resolveDocker).toHaveBeenCalledTimes(1);
  });

  it('treats empty explicit base as absent and keeps legacy Docker-first order', () => {
    const resolveDocker = jest.fn(() => ['docker']);

    const plan = planDisposablePostgresProvision(
      { MUN0021_PG_BASE_URL: '', DATABASE_URL: EPHEMERAL_BASE },
      resolveDocker,
    );

    expect(plan).toEqual({ kind: 'container', dockerCmd: ['docker'] });
    expect(resolveDocker).toHaveBeenCalledTimes(1);
  });

  it('throws when neither Docker nor any base URL is available', () => {
    const resolveDocker = jest.fn(() => null);

    expect(() => planDisposablePostgresProvision({}, resolveDocker)).toThrow(
      /No disposable PostgreSQL target available/,
    );
    expect(resolveDocker).toHaveBeenCalledTimes(1);
  });
});
