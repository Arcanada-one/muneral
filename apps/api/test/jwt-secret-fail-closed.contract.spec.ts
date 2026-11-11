// MUN-HYG: the JWT signing secret has NO default. Without JWT_SECRET the API
// refuses to start (module construction / config time); with it, behaviour is
// unchanged. Nothing here prints or asserts a real secret: the value used is a
// throwaway string defined in this test.
import { jest } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { getJwtSecret } from '../src/auth/jwt-secret.js';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy.js';
import { KanbanGateway } from '../src/ws/kanban.gateway.js';

const apiRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(apiRoot, 'src');
const OLD_PUBLIC_DEFAULT = ['change-me', 'in-production'].join('-');
const TEST_VALUE = 'contract-test-only-5d2b7c91e0a346f8';

const FOUR_CONSUMERS = [
  'auth/auth.module.ts',
  'auth/strategies/jwt.strategy.ts',
  'ws/kanban.gateway.ts',
  'ws/ws.module.ts',
];

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listTs(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

describe('JWT_SECRET fails closed', () => {
  const saved = process.env.JWT_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved;
  });

  describe('(a) unset or blank: every consumer refuses', () => {
    it.each([undefined, '', '   '])('getJwtSecret throws for %j and names only the variable', (v) => {
      if (v === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = v;
      expect(() => getJwtSecret()).toThrow(/JWT_SECRET/);
      expect(() => getJwtSecret()).not.toThrow(new RegExp(OLD_PUBLIC_DEFAULT));
    });

    it('JwtStrategy construction (used by auth.module) throws', () => {
      delete process.env.JWT_SECRET;
      expect(() => new JwtStrategy({} as never)).toThrow(/JWT_SECRET/);
    });

    it('KanbanGateway rejects the connection and never verifies a token', async () => {
      delete process.env.JWT_SECRET;
      const jwtService = { verify: jest.fn() };
      const gateway = new KanbanGateway(jwtService as never, {} as never);
      const socket = { handshake: { auth: { token: 'any.token.value' } }, data: {}, disconnect: jest.fn() };
      await gateway.handleConnection(socket as never);
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(jwtService.verify).not.toHaveBeenCalled();
    });

    it.each(FOUR_CONSUMERS)('%s uses the shared helper and has no secret default', (rel) => {
      const text = fs.readFileSync(path.join(srcRoot, rel), 'utf8');
      expect(text).toMatch(/import \{ getJwtSecret \} from '[./]*(auth\/)?(\.\.\/)?jwt-secret\.js'/);
      expect(text).toContain('getJwtSecret()');
      expect(text).not.toMatch(/process\.env\.JWT_SECRET/);
      expect(text).not.toContain(OLD_PUBLIC_DEFAULT);
    });
  });

  describe('(b) set: behaviour is unchanged', () => {
    it('getJwtSecret returns the configured value verbatim', () => {
      process.env.JWT_SECRET = TEST_VALUE;
      expect(getJwtSecret()).toBe(TEST_VALUE);
    });

    it('JwtStrategy constructs', () => {
      process.env.JWT_SECRET = TEST_VALUE;
      expect(() => new JwtStrategy({} as never)).not.toThrow();
    });

    it('KanbanGateway verifies with the configured secret', async () => {
      process.env.JWT_SECRET = TEST_VALUE;
      const jwtService = { verify: jest.fn().mockReturnValue({ sub: 'u1', type: 'access' }) };
      const gateway = new KanbanGateway(jwtService as never, {} as never);
      const socket = { handshake: { auth: { token: 't' } }, data: {} as Record<string, unknown>, disconnect: jest.fn() };
      await gateway.handleConnection(socket as never);
      expect(jwtService.verify).toHaveBeenCalledWith('t', { secret: TEST_VALUE });
      expect(socket.data['userId']).toBe('u1');
      expect(socket.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('(c) repo-wide: no literal default for a secret-like env var in apps/api/src', () => {
    // process.env.<NAME containing SECRET|KEY|TOKEN|PASSWORD> followed by ?? or ||
    // and a NON-EMPTY string literal. An empty-string default is not flagged here.
    const PATTERN = /process\.env\.[A-Z0-9_]*(?:SECRET|KEY|TOKEN|PASSWORD)[A-Z0-9_]*\s*(?:\?\?|\|\|)\s*(['"`])(?!\1)/;

    it('the pattern flags a re-added literal fallback (mutant control)', () => {
      const mutant = `secret: process.env.JWT_SECRET ?? '${OLD_PUBLIC_DEFAULT}',`;
      expect(PATTERN.test(mutant)).toBe(true);
      const otherName = ['PROBE', 'SECRET'].join('_');
      expect(PATTERN.test(`x: process.env.${otherName} || "abc"`)).toBe(true);
      expect(PATTERN.test("x: process.env.GITHUB_CLIENT_SECRET ?? ''")).toBe(false);
      expect(PATTERN.test("keyPrefix: process.env.REDIS_PREFIX ?? 'muneral:'")).toBe(false);
    });

    it('no source file matches', () => {
      const hits = listTs(srcRoot).flatMap((f) =>
        fs
          .readFileSync(f, 'utf8')
          .split('\n')
          .flatMap((line, i) => (PATTERN.test(line) ? [`${path.relative(apiRoot, f)}:${i + 1}`] : [])),
      );
      expect(hits).toEqual([]);
    });
  });
});
