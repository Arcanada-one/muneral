import { SetMetadata } from '@nestjs/common';

/**
 * A single-route opt-in for a project grant to admit only the task metadata
 * projection. The route must still carry its ordinary @AgentScope('task');
 * this marker is not an AgentScopeKind and does not widen history or writes.
 */
export const PROJECT_READ_TASK_METADATA_KEY = 'mun0052:projectReadTaskMetadata';

export const ProjectReadTaskMetadata = () =>
  SetMetadata(PROJECT_READ_TASK_METADATA_KEY, true);
