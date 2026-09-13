// FIRST, before anything that carries a decorator. `Optional()`/`Inject()` write
// their marks through `Reflect.defineMetadata`, which is a polyfill, not a
// language feature. Only `src/main.ts` imported it, and tests never load main.ts;
// under the CommonJS transpile it arrived transitively, under ESM it does not.
// Without it `__param(0, Optional())` silently no-ops while `design:paramtypes`
// still resolves, so Nest reads `AuthModuleOptions` as a REQUIRED dependency:
// `Nest can't resolve dependencies of the JwtAuthGuard (?) … AuthModuleOptions
// at index [0] … in the AgentsModule module`, 80 times in CI.
import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
import * as url from 'node:url';

// ESM has no __dirname, and declaring that NAME would mark the module CommonJS.
const thisDir = path.dirname(url.fileURLToPath(import.meta.url));

// Load .env for integration/e2e tests
dotenv.config({ path: path.join(thisDir, '../.env') });
