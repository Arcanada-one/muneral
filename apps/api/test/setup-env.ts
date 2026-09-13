import * as dotenv from 'dotenv';
import * as path from 'node:path';
import * as url from 'node:url';

// ESM has no __dirname, and declaring that NAME would mark the module CommonJS.
const thisDir = path.dirname(url.fileURLToPath(import.meta.url));

// Load .env for integration/e2e tests
dotenv.config({ path: path.join(thisDir, '../.env') });
