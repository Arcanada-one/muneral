/**
 * MUN-0052 — which agent keys may read a project's task INDEX, and until when.
 *
 * Inside its workspace an agent key sees its own slice of a project: the tasks
 * it is assigned to or created (MUN-0043, MUN-0051). The Arcanada Universal
 * Program's board was registered on 2026-09-05 through a human JWT, so the
 * fleet's own key could not see 471 of the 477 program tasks and the program's
 * status-parity check could not be measured at all. Widening the own-slice rule
 * for every key of the workspace was rejected (program decision DEC-AUP-0029,
 * five-role consilium): the in-workspace `field-changes` read already returns a
 * task's title and description to anybody who knows its id, and the one thing a
 * key cannot do today is list the ids — a workspace-wide list would hand every
 * key of the workspace the whole board, including titles known to carry secrets.
 *
 * So the read is granted per key and per project, here, and it opens exactly one
 * route: `GET /tasks/project/:projectId/index` (`@AgentScope('project-index')`),
 * which answers ids, status and a sha256 of the title — no free text. Every other
 * route keeps the own-slice rule, and nothing here is consulted by any write.
 *
 * The list lives in code, not in a table or the environment, on purpose — the
 * same choice as `assign-compat-window.ts`: a grant is a reviewed change that
 * names its decision, and it lapses by itself at `until` without a deploy.
 */
export interface ProjectReadGrantEntry {
  agentId: string;
  agentName: string;
  projectId: string;
  /** Exclusive: the grant is closed at and after this instant. */
  until: string;
  /** The program decision that admitted the grant. */
  decision: string;
  evidence: string;
}

/** Injection token, so a test module can supply its own list. */
export const PROJECT_READ_GRANTS = 'mun0052:projectReadGrants';

export const PROJECT_READ_GRANT_LIST: readonly ProjectReadGrantEntry[] = [
  {
    agentId: '9437639a-5f7c-4fe4-be04-18112ba0bada',
    agentName: 'aup-orchestrator',
    projectId: '08a50f9a-a735-4605-91ce-ce4a41193fbb',
    until: '2026-09-21T00:00:00Z',
    decision: 'DEC-AUP-0029',
    evidence:
      'A2-P3-13 / MUN-0051: the agent key listed 369 then 416 rows of project aup; 471 of the 477 registered tasks were not among them',
  },
];

/** The grant that admits `agentId` to `projectId` at `now`, if any. */
export function projectReadGrantFor(
  agentId: string,
  projectId: string,
  now: Date,
  grants: readonly ProjectReadGrantEntry[] = PROJECT_READ_GRANT_LIST,
): ProjectReadGrantEntry | undefined {
  return grants.find(
    (g) =>
      g.agentId === agentId &&
      g.projectId === projectId &&
      now.getTime() < Date.parse(g.until),
  );
}
