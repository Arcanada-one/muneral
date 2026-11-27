/**
 * What a human (JWT) caller must belong to, per route.
 *
 * Every route that accepts a human has one entry, keyed by `Controller.handler`.
 * A route without an entry is refused. Agent API keys are not read from here:
 * their scope rules live in AgentTaskScopeGuard.
 *
 * Membership means any role. The routes that require a higher role keep
 * WorkspaceRoleGuard on the handler.
 */
export type ResourceKind =
  | 'workspace'
  | 'project'
  | 'task'
  | 'sprint'
  | 'milestone'
  | 'agent'
  | 'apiKey'
  | 'webhook'
  | 'gitRef'
  | 'taskDependency';

/** `id`: must be a UUID, and the service or a later guard binds it to its parent.
 *  `text`: not an id. */
export type ParamKind = ResourceKind | 'id' | 'text';

export interface RouteAccess {
  params?: Readonly<Record<string, ParamKind>>;
  /** Dot paths into the raw body or query; `[]` walks an array. Absent and null values are skipped. */
  body?: Readonly<Record<string, ResourceKind>>;
  query?: Readonly<Record<string, ResourceKind>>;
  /**
   * Why this route may be admitted without resolving any workspace here:
   * `caller`      the service returns or creates only what belongs to the caller;
   * `memberGuard` WorkspaceMemberGuard on the handler checks the membership;
   * `agentOnly`   the handler or service refuses every human caller.
   */
  unbound?: 'caller' | 'memberGuard' | 'agentOnly';
}

const task: RouteAccess = { params: { taskId: 'task' } };
const project: RouteAccess = { params: { projectId: 'project' } };
const members: RouteAccess = { params: { workspaceId: 'id' }, unbound: 'memberGuard' };
const member: RouteAccess = { params: { workspaceId: 'id', userId: 'id' }, unbound: 'memberGuard' };

export const HUMAN_ROUTE_ACCESS: Readonly<Record<string, RouteAccess>> = {
  'WorkspacesController.create': { unbound: 'caller' },
  'WorkspacesController.findAll': { unbound: 'caller' },
  'WorkspacesController.findOne': members,
  'WorkspacesController.listMembers': members,
  'WorkspacesController.addMember': member,
  'WorkspacesController.updateMemberRole': member,
  'WorkspacesController.removeMember': member,

  'ProjectsController.create': { body: { workspaceId: 'workspace' } },
  'ProjectsController.findByWorkspace': { params: { workspaceId: 'workspace' } },
  'ProjectsController.findOne': project,
  'ProjectsController.delete': project,
  'ProjectsController.addGitRef': { body: { taskId: 'task' } },
  'ProjectsController.getGitRefs': task,
  'ProjectsController.removeGitRef': { params: { refId: 'gitRef' } },

  'MilestonesController.createMilestone': { body: { projectId: 'project' } },
  'MilestonesController.getMilestones': project,
  'MilestonesController.deleteMilestone': { params: { milestoneId: 'milestone' } },
  'MilestonesController.createSprint': { body: { projectId: 'project', milestoneId: 'milestone' } },
  'MilestonesController.getSprints': project,
  'MilestonesController.deleteSprint': { params: { sprintId: 'sprint' } },

  'WebhooksController.create': { body: { workspaceId: 'workspace' } },
  'WebhooksController.findByWorkspace': { params: { workspaceId: 'workspace' } },
  'WebhooksController.delete': { params: { webhookId: 'webhook' } },
  'WebhooksController.activate': { params: { webhookId: 'webhook' } },
  'WebhooksController.deactivate': { params: { webhookId: 'webhook' } },

  'AgentsController.register': { body: { workspaceId: 'workspace' } },
  'AgentsController.findByWorkspace': { params: { workspaceId: 'workspace' } },
  'AgentsController.assignToTask': { params: { taskId: 'task' }, body: { agentId: 'agent' } },
  'AgentsController.removeFromTask': { params: { taskId: 'task', agentId: 'agent' } },
  'AgentsController.createApiKey': { params: { agentId: 'agent' } },
  'AgentsController.rotateApiKey': { params: { keyId: 'apiKey' } },
  'AgentsController.revokeApiKey': { params: { keyId: 'apiKey' } },

  'TasksController.create': { body: { projectId: 'project', sprintId: 'sprint', parentId: 'task' } },
  'TasksController.query': { query: { projectId: 'project' }, unbound: 'caller' },
  'TasksController.digestTransitions': { unbound: 'agentOnly' },
  'TasksController.digest': { unbound: 'agentOnly' },
  'TasksController.getIdentity': task,
  'TasksController.findOne': task,
  'TasksController.findByProject': project,
  'TasksController.indexForProject': project,
  'TasksController.getActiveStatusStalenessReport': project,
  'TasksController.getStatusTransitionCounts': project,
  'TasksController.getTransitionReport': project,
  'TasksController.getStalenessReport': project,
  'TasksController.updateStatus': task,
  'TasksController.updateMetadata': { params: { taskId: 'task' }, body: { sprintId: 'sprint' } },
  'TasksController.redact': task,
  'TasksController.attachEvidence': task,
  'TasksController.listEvidence': task,
  'TasksController.delete': task,
  'TasksController.getChecklist': task,
  'TasksController.addChecklistItem': task,
  'TasksController.toggleChecklistItem': { params: { taskId: 'task', itemId: 'id' } },
  'TasksController.deleteChecklistItem': { params: { taskId: 'task', itemId: 'id' } },
  'TasksController.listChildren': task,
  'TasksController.getAssignees': task,
  'TasksController.getDependencies': task,
  'TasksController.getDependencyGraph': task,
  'TasksController.getReadiness': task,
  'TasksController.addDependency': { params: { taskId: 'task' }, body: { toTaskId: 'task' } },
  'TasksController.removeDependency': { params: { taskId: 'task', depId: 'taskDependency' } },
  'TasksController.addComment': task,
  'TasksController.getComments': task,
  'TasksController.getActivity': task,

  'TaskContentController.upload': task,
  'TaskContentController.uploadBytes': task,
  'TaskContentController.list': task,
  'TaskContentController.bySha': { params: { taskId: 'task', sha256: 'text' } },
  'TaskContentController.get': { params: { taskId: 'task', artifactId: 'id' } },

  'TaskContractBindingController.bind': { params: { taskId: 'task' }, body: { expectedProjectId: 'project' } },

  'PlanGraphController.associateCommand': {
    body: {
      projectId: 'project',
      rootTaskId: 'task',
      'command.parentId': 'task',
      'command.sprintId': 'sprint',
    },
  },
  'PlanGraphController.getPlan': task,
  'PlanGraphController.putPlan': { params: { taskId: 'task' }, body: { 'nodes[].taskId': 'task' } },
  'PlanGraphController.bindLease': task,
  'PlanGraphController.planReadiness': task,

  'SyncController.exportDatarim': project,

  'MigrationController.getBatch': { params: { batchId: 'id' }, unbound: 'caller' },
  'MigrationController.search': { unbound: 'caller' },
  'MigrationController.getByLegacy': { params: { sourceNamespace: 'text', legacyId: 'text' }, unbound: 'caller' },
  'MigrationController.mappings': { params: { identityId: 'id' }, unbound: 'caller' },
};
