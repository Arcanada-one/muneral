// KCLIVE-10: normalize create/run commands and digest them with the same
// canonical JSON instrument execution authority already uses.

import {
  jsonDigest,
  type JsonObject,
} from '../execution-authority/canonical-json.js';
import type { NormalizedCreateCommand } from './plan-graph.types.js';

export function normalizeCreateCommand(
  input: Partial<NormalizedCreateCommand> & {
    operation: NormalizedCreateCommand['operation'];
    projectId: string;
    title: string;
  },
): NormalizedCreateCommand {
  const tags = [...(input.tags ?? [])].map(String).sort();
  return {
    operation: input.operation,
    projectId: input.projectId,
    parentId: input.parentId ?? null,
    title: input.title,
    description: input.description ?? null,
    status: input.status ?? null,
    priority: input.priority ?? null,
    sprintId: input.sprintId ?? null,
    contractDigest: input.contractDigest ?? null,
    tags,
  };
}

export function digestCreateCommand(command: NormalizedCreateCommand): string {
  return jsonDigest(command as unknown as JsonObject);
}
