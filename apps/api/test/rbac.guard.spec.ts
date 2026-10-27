import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WorkspaceRoleGuard } from '../src/common/guards/workspace-role.guard.js';
import type { WorkspaceMemberRole } from '@muneral/types';
import { WorkspaceMemberGuard } from '../src/common/guards/workspace-member.guard.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

function makeContext(role: WorkspaceMemberRole | null): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        workspaceMember: role ? { role } : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('WorkspaceRoleGuard', () => {
  const roles: WorkspaceMemberRole[] = ['viewer', 'developer', 'manager', 'owner'];

  // Role hierarchy matrix: [userRole, requiredRole] -> expected result
  const matrix: Array<[WorkspaceMemberRole, WorkspaceMemberRole, boolean]> = [
    // viewer
    ['viewer', 'viewer', true],
    ['viewer', 'developer', false],
    ['viewer', 'manager', false],
    ['viewer', 'owner', false],
    // developer
    ['developer', 'viewer', true],
    ['developer', 'developer', true],
    ['developer', 'manager', false],
    ['developer', 'owner', false],
    // manager
    ['manager', 'viewer', true],
    ['manager', 'developer', true],
    ['manager', 'manager', true],
    ['manager', 'owner', false],
    // owner
    ['owner', 'viewer', true],
    ['owner', 'developer', true],
    ['owner', 'manager', true],
    ['owner', 'owner', true],
  ];

  test.each(matrix)(
    '%s user accessing %s endpoint → %s',
    (userRole, requiredRole, expected) => {
      const GuardClass = WorkspaceRoleGuard(requiredRole);
      const guard = new GuardClass();
      const ctx = makeContext(userRole);

      if (expected) {
        expect(guard.canActivate(ctx)).toBe(true);
      } else {
        expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
      }
    },
  );

  it('throws ForbiddenException when workspaceMember is not set', () => {
    const GuardClass = WorkspaceRoleGuard('developer');
    const guard = new GuardClass();
    const ctx = makeContext(null);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});

// e4d18373: the guard runs before ActorInterceptor, so it must resolve the
// caller from `req.user` / `req.apiKeyAgent` itself and never from `req.actor`.
function makeMemberContext(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('WorkspaceMemberGuard', () => {
  const member = { workspaceId: 'ws-1', userId: 'user-1', role: 'owner' };
  let findUnique: jest.Mock;
  let guard: WorkspaceMemberGuard;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(member);
    guard = new WorkspaceMemberGuard({ workspaceMember: { findUnique } } as unknown as PrismaService);
  });

  it('admits an authenticated member from req.user without req.actor', async () => {
    const req: Record<string, unknown> = { user: { id: 'user-1', name: 'Owner' }, params: { workspaceId: 'ws-1' } };
    await expect(guard.canActivate(makeMemberContext(req))).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({ where: { workspaceId_userId: { workspaceId: 'ws-1', userId: 'user-1' } } });
    expect(req.workspaceMember).toBe(member);
  });

  it('refuses an API-key agent even if req.user is also present', async () => {
    const req = { user: { id: 'user-1' }, apiKeyAgent: { id: 'agent-1' }, params: { workspaceId: 'ws-1' } };
    await expect(guard.canActivate(makeMemberContext(req))).rejects.toThrow(new ForbiddenException('Human authentication required'));
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses an API-key agent without req.user', async () => {
    const req = { apiKeyAgent: { id: 'agent-1' }, params: { workspaceId: 'ws-1' } };
    await expect(guard.canActivate(makeMemberContext(req))).rejects.toThrow(ForbiddenException);
  });

  it('does not trust a forged req.actor without req.user', async () => {
    const req = { actor: { type: 'human', id: 'user-1', name: 'x' }, params: { workspaceId: 'ws-1' } };
    await expect(guard.canActivate(makeMemberContext(req))).rejects.toThrow(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('refuses a non-member', async () => {
    findUnique.mockResolvedValue(null);
    const req = { user: { id: 'user-2' }, params: { workspaceId: 'ws-1' } };
    await expect(guard.canActivate(makeMemberContext(req))).rejects.toThrow(new ForbiddenException('Not a member of this workspace'));
  });

  it('requires a workspaceId route param', async () => {
    const req = { user: { id: 'user-1' }, params: {} };
    await expect(guard.canActivate(makeMemberContext(req))).rejects.toThrow(NotFoundException);
  });
});
