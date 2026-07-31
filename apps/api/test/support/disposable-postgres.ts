// MUN-0021: task-owned disposable PostgreSQL harness.
//
// Every empirical database proof in this task runs against a uniquely named
// throwaway container on a dynamic loopback port. No shared or production
// database is ever reachable from here: the connection string is built from
// the container this module started, and nothing reads DATABASE_URL.
//
// Cleanup is fail-closed. Post-test removal that leaves a container, a
// task-named volume, or a listening port throws, so a leaked resource fails
// the suite instead of silently surviving.

import { execSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const PG_IMAGE = 'postgres:16-alpine';
const PG_USER = 'muneral_test';
const PG_PASS = 'muneral_test_pass';

export interface DisposablePostgres {
  /** Container name — unique per instance, always task-prefixed. */
  readonly containerName: string;
  /** Connection string for the disposable instance. Empty until start(). */
  url(): string;
  port(): number;
  /** Start the container, wait for readiness, and apply every migration. */
  start(): Promise<void>;
  /** Remove the container and prove no residue survives. Throws if any does. */
  stop(): Promise<void>;
}

/** Allocate a free loopback port by binding to port 0 and reading it back.
 *  The socket closes immediately; the window before `docker run` binds is
 *  unavoidable but bounded by the immediate call in start(). */
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

function run(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} exited ${result.status}: ${String(result.stderr ?? '').slice(0, 500)}`,
    );
  }
  return (result.stdout ?? '').trim();
}

function docker(...args: string[]): string {
  return run('sudo', ['docker', ...args]);
}

/**
 * Fail-closed container removal. Only the pre-test sweep of a stale container
 * from a prior crashed run is best-effort; post-test removal must surface.
 */
function stopAndRemove(name: string, failClosed: boolean): void {
  try {
    docker('rm', '-f', name);
  } catch (err) {
    if (failClosed) throw err;
  }
}

/**
 * Create a disposable PostgreSQL instance for one test suite.
 *
 * @param label short suite identifier, used in the container and database name
 */
export function createDisposablePostgres(label: string): DisposablePostgres {
  const containerName = `muneral-${label}-test-${randomUUID().slice(0, 8)}`;
  const database = `muneral_${label.replace(/-/g, '_')}_test`;
  let assignedPort = 0;
  let connectionString = '';
  let started = false;

  return {
    containerName,
    url: () => connectionString,
    port: () => assignedPort,

    async start(): Promise<void> {
      assignedPort = await allocatePort();
      console.log(`\n[${label}-pg] Allocated dynamic port: ${assignedPort}`);

      stopAndRemove(containerName, false);

      console.log(`[${label}-pg] Starting disposable container: ${containerName}`);
      docker(
        'run', '-d',
        '--name', containerName,
        '-e', `POSTGRES_USER=${PG_USER}`,
        '-e', `POSTGRES_PASSWORD=${PG_PASS}`,
        '-e', `POSTGRES_DB=${database}`,
        '-p', `127.0.0.1:${assignedPort}:5432`,
        PG_IMAGE,
      );
      started = true;

      connectionString =
        `postgresql://${PG_USER}:${PG_PASS}@localhost:${assignedPort}/${database}?schema=public`;

      console.log(`[${label}-pg] Waiting for PostgreSQL to accept connections...`);
      for (let i = 0; i < 60; i += 1) {
        try {
          execSync(
            `pg_isready -h localhost -p ${assignedPort} -U ${PG_USER} -d ${database}`,
            { stdio: 'pipe', env: { ...process.env, PGPASSWORD: PG_PASS } },
          );
          console.log(`[${label}-pg] PostgreSQL is ready.`);
          break;
        } catch {
          if (i === 59) {
            throw new Error('PostgreSQL did not become ready within 60s');
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      console.log(`[${label}-pg] Applying migrations via psql...`);
      const migrationsDir = join(__dirname, '..', '..', 'prisma', 'migrations');
      const dirs = readdirSync(migrationsDir)
        .filter((d: string) => d.startsWith('202'))
        .sort();
      for (const dir of dirs) {
        const sqlPath = join(migrationsDir, dir, 'migration.sql');
        if (existsSync(sqlPath)) {
          console.log(`[${label}-pg]   Applying ${dir}/migration.sql`);
          execSync(
            `psql -h localhost -p ${assignedPort} -U ${PG_USER} -d ${database} -f ${sqlPath} -v ON_ERROR_STOP=1`,
            { stdio: 'pipe', env: { ...process.env, PGPASSWORD: PG_PASS } },
          );
        }
      }
      console.log(`[${label}-pg] All migrations applied.`);
    },

    async stop(): Promise<void> {
      if (!started) return;
      const failures: string[] = [];

      console.log(`\n[${label}-pg] Removing container: ${containerName}`);
      try {
        stopAndRemove(containerName, true);
      } catch (err) {
        failures.push(
          `docker removal failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const inspect = spawnSync('sudo', ['docker', 'inspect', containerName], {
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
        'sudo',
        ['docker', 'ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}'],
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
        'sudo',
        ['docker', 'volume', 'ls', '--filter', `name=${containerName}`, '--format', '{{.Name}}'],
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
