import type { ProjectReadGrantEntry } from './project-read-grants.js';
import { ARCANADA_WORKSPACE_ID, AUP_ORCHESTRATOR_AGENT_ID, AUP_ANCHOR_PROJECT_ID } from './workspace-bindings.js';

/** Index enumeration only. Never consulted by digest, task reads or writes. */
export interface WorkspaceIndexGrantEntry {
  agentId: string;
  agentName: string;
  workspaceId: string;
  anchorProjectId: string;
  excludedProjectSlugs: readonly string[];
  until: string;
  decision: string;
  evidence: string;
}
export interface WorkspaceIndexProjectGrant extends ProjectReadGrantEntry {
  kind: 'workspace-index';
  workspaceId: string;
  anchorProjectId: string;
}
export type ProjectIndexGrant = ProjectReadGrantEntry | WorkspaceIndexProjectGrant;
export const WORKSPACE_INDEX_GRANTS = 'workspace:projectIndexGrants';
export const WORKSPACE_INDEX_GRANT_LIST: readonly WorkspaceIndexGrantEntry[] = [{
  agentId: AUP_ORCHESTRATOR_AGENT_ID,
  agentName: 'aup-orchestrator',
  workspaceId: ARCANADA_WORKSPACE_ID,
  anchorProjectId: AUP_ANCHOR_PROJECT_ID,
  excludedProjectSlugs: ['tbt', 'mt5-bridge'],
  until: '2026-11-04T00:00:00Z',
  decision: 'DEC-AUP-0113',
  evidence: 'Named coordinator index-only workspace scope; independent five-role council, fixed identity bindings, unchanged explicit expiries, transactional admission and audit. Current excluded slugs are denied. Expiry closes this entry without deployment; renewal requires a reviewed decision and PR.',
}];
