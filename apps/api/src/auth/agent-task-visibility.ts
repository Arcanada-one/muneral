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

/**
 * MUN-0050 / MUN-0053 — the tasks an agent key may MOVE: the ones it created
 * (the same authorship pair as above) or holds an `executor` assignment for. A
 * lead or reviewer assignment reads and comments, it does not move the card.
 * Shared by the status route's scope check and the migration transition, so the
 * two doors that change a task's status cannot drift apart. Callers add the
 * workspace clause.
 */
export function agentStatusAuthorityWhere(agentId: string): Prisma.TaskWhereInput {
  return {
    OR: [
      { createdById: agentId, actorType: 'agent' },
      { agents: { some: { agentId, role: 'executor' } } },
    ],
  };
}
