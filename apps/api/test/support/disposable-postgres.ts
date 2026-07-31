// MUN-0021: task-owned disposable PostgreSQL harness.
//
// Every empirical database proof in this task runs against a uniquely named
// throwaway target. Two provisioning modes exist, because the two environments
// that must run these proofs have different capabilities:
//
//   container — spawn a uniquely named PostgreSQL container on a dynamic
//               loopback port. Used on a developer machine with docker access.
//
//   database  — create a uniquely named database on an already-ephemeral
//               PostgreSQL server and drop it afterwards. Used on the CI
//               runner, which deliberately has no docker escalation (SEC-0028)
//               but does provide a per-job PostgreSQL service container.
//
// Both modes are task-owned and disposable, and both clean up fail-closed: a
// surviving container, task-named volume, listening port or leftover database
// throws, so a leaked resource fails the suite instead of silently persisting.
//
// If neither mode is available the harness throws. It never degrades to
// "skipped but reported green" — an unrun database proof is not a passing one.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { Client } = require('pg');

const PG_IMAGE = 'postgres:16-alpine';
const PG_USER = 'muneral_test';
const PG_PASS = 'muneral_test_pass';

export type ProvisioningMode = 'container' | 'database';

export interface DisposablePostgres {
  /** Unique task-owned identity — container name, or database name in
   *  database mode. Always task-prefixed. */
  readonly containerName: string;
  /** How this instance was provisioned. Empty until start(). */
  mode(): ProvisioningMode;
  /** Connection string for the disposable target. Empty until start(). */
  url(): string;
  port(): number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const assigned = addr.port;
        server.close(() => resolve(assigned));
      } else {
        server.close();
        reject(new Error('Failed to allocate dynamic port'));
      }
    });
  });
}

/** Resolve how docker can be invoked, or null when it cannot. */
function resolveDockerCommand(): string[] | null {
  for (const candidate of [['docker'], ['sudo', '-n', 'docker']]) {
    const probe = spawnSync(candidate[0], [...candidate.slice(1), 'info'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function migrationSqlFiles(): string[] {
  const migrationsDir = join(__dirname, '..', '..', 'prisma', 'migrations');
  return readdirSync(migrationsDir)
    .filter((d: string) => d.startsWith('202'))
    .sort()
    .map((d: string) => join(migrationsDir, d, 'migration.sql'))
    .filter((p: string) => existsSync(p));
}

/**
 * Apply every migration to `url`. The simple query protocol is used
 * deliberately: migration files contain dollar-quoted trigger function bodies
 * and several statements per file, neither of which survives the extended
 * protocol.
 */
async function applyMigrations(url: string, label: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const sqlPath of migrationSqlFiles()) {
      console.log(`[${label}-pg]   Applying ${sqlPath.split('/').slice(-2).join('/')}`);
      await client.query(readFileSync(sqlPath, 'utf8'));
    }
  } finally {
    await client.end();
  }
}

async function waitForReady(url: string, label: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      console.log(`[${label}-pg] PostgreSQL is ready.`);
      return;
    } catch {
      try {
        await client.end();
      } catch {
        // The connection never opened; nothing to close.
      }
      if (i === 59) {
        throw new Error('PostgreSQL did not become ready within 60s');
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** Swap the database component of a connection string. */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Refuse to provision against anything that is not an obviously ephemeral
 * local server. The harness creates and drops databases, so pointing it at a
 * shared or production host must be impossible rather than merely discouraged.
 */
function assertEphemeralBase(url: string): void {
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a disposable PostgreSQL target for one test suite.
 *
 * @param label short suite identifier, used in the container/database name
 */
export function createDisposablePostgres(label: string): DisposablePostgres {
  const suffix = randomUUID().slice(0, 8);
  const containerName = `muneral-${label}-test-${suffix}`;
  const baseDatabase = `muneral_${label.replace(/-/g, '_')}_test`;
  // In database mode the name must also be unique — the server is shared with
  // whatever else runs in the same CI job.
  const scratchDatabase = `${baseDatabase}_${suffix}`;

  let resolvedMode: ProvisioningMode | '' = '';
  let dockerCmd: string[] | null = null;
  let assignedPort = 0;
  let connectionString = '';
  let adminUrl = '';
  let started = false;

  function docker(...args: string[]): string {
    if (!dockerCmd) throw new Error('docker is not available');
    const result = spawnSync(dockerCmd[0], [...dockerCmd.slice(1), ...args], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `docker ${args.join(' ')} exited ${result.status}: ${String(result.stderr ?? '').slice(0, 500)}`,
      );
    }
    return (result.stdout ?? '').trim();
  }

  /** Only the pre-test sweep of a stale container is best-effort. */
  function stopAndRemove(failClosed: boolean): void {
    try {
      docker('rm', '-f', containerName);
    } catch (err) {
      if (failClosed) throw err;
    }
  }

  return {
    containerName,
    mode: () => {
      if (!resolvedMode) throw new Error('start() has not run yet');
      return resolvedMode;
    },
    url: () => connectionString,
    port: () => assignedPort,

    async start(): Promise<void> {
      dockerCmd = resolveDockerCommand();
      const base = process.env.MUN0021_PG_BASE_URL ?? process.env.DATABASE_URL;

      if (dockerCmd) {
        resolvedMode = 'container';
        assignedPort = await allocatePort();
        console.log(
          `\n[${label}-pg] Mode: container. Allocated dynamic port: ${assignedPort}`,
        );
        stopAndRemove(false);

        console.log(`[${label}-pg] Starting disposable container: ${containerName}`);
        docker(
          'run', '-d',
          '--name', containerName,
          '-e', `POSTGRES_USER=${PG_USER}`,
          '-e', `POSTGRES_PASSWORD=${PG_PASS}`,
          '-e', `POSTGRES_DB=${baseDatabase}`,
          '-p', `127.0.0.1:${assignedPort}:5432`,
          PG_IMAGE,
        );
        started = true;
        connectionString =
          `postgresql://${PG_USER}:${PG_PASS}@localhost:${assignedPort}/${baseDatabase}?schema=public`;
      } else if (base) {
        resolvedMode = 'database';
        assertEphemeralBase(base);
        adminUrl = base;
        assignedPort = Number(new URL(base).port || 5432);
        console.log(
          `\n[${label}-pg] Mode: database (no docker escalation available). ` +
          `Creating disposable database: ${scratchDatabase}`,
        );

        await waitForReady(adminUrl, label);
        const admin = new Client({ connectionString: adminUrl });
        await admin.connect();
        try {
          // Identifier is generated here from a fixed prefix and a UUID
          // fragment, so it cannot carry caller-controlled SQL.
          await admin.query(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
          await admin.query(`CREATE DATABASE "${scratchDatabase}"`);
        } finally {
          await admin.end();
        }
        started = true;
        connectionString = withDatabase(base, scratchDatabase);
      } else {
        throw new Error(
          'No disposable PostgreSQL target available: docker is not reachable and ' +
          'neither MUN0021_PG_BASE_URL nor DATABASE_URL is set. The database proofs ' +
          'must run — they are not optional coverage.',
        );
      }

      console.log(`[${label}-pg] Waiting for PostgreSQL to accept connections...`);
      await waitForReady(connectionString, label);

      console.log(`[${label}-pg] Applying migrations...`);
      await applyMigrations(connectionString, label);
      console.log(`[${label}-pg] All migrations applied.`);
    },

    async stop(): Promise<void> {
      if (!started) return;
      const failures: string[] = [];

      if (resolvedMode === 'database') {
        console.log(`\n[${label}-pg] Dropping disposable database: ${scratchDatabase}`);
        const admin = new Client({ connectionString: adminUrl });
        try {
          await admin.connect();
          await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
              WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [scratchDatabase],
          );
          await admin.query(`DROP DATABASE IF EXISTS "${scratchDatabase}"`);
          const remaining = await admin.query(
            'SELECT 1 FROM pg_database WHERE datname = $1',
            [scratchDatabase],
          );
          if (remaining.rowCount && remaining.rowCount > 0) {
            failures.push(`disposable database survived cleanup: ${scratchDatabase}`);
          }
        } catch (err) {
          failures.push(
            `database cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          try {
            await admin.end();
          } catch {
            // Already closed.
          }
        }
        console.log(
          `[${label}-pg] Cleanup evidence: database=${scratchDatabase} dropped from the ` +
          'per-job PostgreSQL service. No shared or production database was touched.',
        );
        if (failures.length > 0) {
          throw new Error(`Disposable PostgreSQL cleanup failed: ${failures.join('; ')}`);
        }
        return;
      }

      console.log(`\n[${label}-pg] Removing container: ${containerName}`);
      try {
        stopAndRemove(true);
      } catch (err) {
        failures.push(
          `docker removal failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const cmd = dockerCmd ?? ['docker'];
      const inspect = spawnSync(cmd[0], [...cmd.slice(1), 'inspect', containerName], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      if (inspect.error) {
        failures.push(`docker inspect failed: ${inspect.error.message}`);
      } else if (inspect.status === 0) {
        failures.push(`container still exists after removal: ${containerName}`);
      } else if (!/no such object/i.test(String(inspect.stderr))) {
        failures.push(
          `docker inspect returned unclassified failure ${inspect.status}: ${String(inspect.stderr).slice(0, 300)}`,
        );
      }

      const remaining = spawnSync(
        cmd[0],
        [...cmd.slice(1), 'ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}'],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      if (remaining.error || remaining.status !== 0) {
        failures.push(
          `docker ps cleanup verification failed: ${
            remaining.error?.message ?? String(remaining.stderr).slice(0, 300)
          }`,
        );
      } else if (String(remaining.stdout).trim()) {
        failures.push(`container survived cleanup: ${String(remaining.stdout).trim()}`);
      }

      const listener = spawnSync('ss', ['-tlnp', `sport = :${assignedPort}`], {
        encoding: 'utf8',
        stdio: 'pipe',
      });
      if (listener.error || listener.status !== 0) {
        failures.push(
          `listener verification failed: ${
            listener.error?.message ?? String(listener.stderr).slice(0, 300)
          }`,
        );
      } else if (String(listener.stdout).includes('LISTEN')) {
        failures.push(`port ${assignedPort} remains in LISTEN state`);
      }

      const volumes = spawnSync(
        cmd[0],
        [...cmd.slice(1), 'volume', 'ls', '--filter', `name=${containerName}`, '--format', '{{.Name}}'],
        { encoding: 'utf8', stdio: 'pipe' },
      );
      if (volumes.error || volumes.status !== 0) {
        failures.push(
          `volume verification failed: ${
            volumes.error?.message ?? String(volumes.stderr).slice(0, 300)
          }`,
        );
      } else if (String(volumes.stdout).trim()) {
        failures.push(`task-named volume survived cleanup: ${String(volumes.stdout).trim()}`);
      }

      console.log(
        `[${label}-pg] Cleanup evidence: container=${containerName} port=${assignedPort} ` +
        `database=${connectionString.replace(/:[^:@]+@/, ':****@')}`,
      );
      console.log(`[${label}-pg] No shared or production database was touched.`);

      if (failures.length > 0) {
        throw new Error(`Disposable PostgreSQL cleanup failed: ${failures.join('; ')}`);
      }
    },
  };
}
