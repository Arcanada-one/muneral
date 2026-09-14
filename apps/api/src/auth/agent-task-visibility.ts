import type { Prisma } from '@prisma/client';

/**
 * MUN-0051 — which tasks an agent key may see, as one Prisma filter shared by
 * the single-task scope check and the two project collections that narrow to
 * the key (`TasksService.findByProject`, `TaskStalenessService.reportForProject`).
 *
 * A task is the agent's when a `task_agents` row names the agent (MUN-0043), or
 * when the agent CREATED it: `created_by_id` is the agent AND `actor_type` is
 * 'agent'. The pair matters — a human's user id can never satisfy it, and an
 * agent id stored under a human actor type is not authorship. Before MUN-0051
 * only the first half counted, so a task created with the key (MUN-0045) was
 * invisible to that same key until somebody assigned it.
 */
export function agentOwnTaskWhere(agentId: string): Prisma.TaskWhereInput {
  return {
    OR: [
      { agents: { some: { agentId } } },
      { createdById: agentId, actorType: 'agent' },
    ],
  };
}
