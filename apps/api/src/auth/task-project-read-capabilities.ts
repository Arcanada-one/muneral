import { ARCANADA_WORKSPACE_ID, AUP_ORCHESTRATOR_AGENT_ID, AUP_ANCHOR_PROJECT_ID } from './workspace-bindings.js';

/** Additional full task/evidence disclosure; an index grant alone does not admit it. */
export interface TaskProjectReadCapability {
  agentId: string;
  workspaceId: string;
  anchorProjectId: string;
  excludedProjectSlugs: readonly string[];
  until: string;
  decision: string;
}
export const TASK_PROJECT_READ_CAPABILITIES = 'task:projectReadCapabilities';
export const TASK_PROJECT_READ_CAPABILITY_LIST: readonly TaskProjectReadCapability[] = [{
  agentId: AUP_ORCHESTRATOR_AGENT_ID,
  workspaceId: ARCANADA_WORKSPACE_ID,
  anchorProjectId: AUP_ANCHOR_PROJECT_ID,
  excludedProjectSlugs: ['tbt', 'mt5-bridge'],
  until: '2026-11-04T00:00:00Z',
  decision: 'DEC-AUP-0116',
}];
