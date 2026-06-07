import * as path from 'path';
import * as dotenv from 'dotenv';

// Load .env for integration/e2e tests
dotenv.config({ path: path.join(__dirname, '../.env') });
