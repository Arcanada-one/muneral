import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { WorkspaceRoleGuard } from '../src/common/guards/workspace-role.guard';
import { WorkspaceMemberRole } from '@muneral/types';

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
