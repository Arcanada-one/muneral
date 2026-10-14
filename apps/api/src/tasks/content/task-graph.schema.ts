import { z } from 'zod';

const text = z.string().min(1).max(512);
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const artifact = z.object({ artifact_id: z.string().uuid(), sha256: hash }).strict();
const budget = z.object({ unit: text, limit: z.number().finite().nonnegative() }).strict();
const output = z.object({ name: id, schema: text, version: z.number().int().positive(), artifact_refs: z.array(artifact).max(100) }).strict();
const node = z.object({
  node_id: id, node_version: z.number().int().positive(), task_id: z.string().uuid().nullable(),
  dependencies: z.array(id).max(200), inputs: z.array(artifact).max(100),
  expected_outputs: z.array(output).max(100), verifier: text,
  acceptance: z.array(text).min(1).max(100), risk: text, state: text, budget: budget.nullable(),
}).strict();
const edge = z.object({
  from: id, to: id, type: z.enum(['depends_on', 'blocks', 'related_to', 'duplicates']),
  accepted_outcome_predicate: text, schema: text, version: z.number().int().positive(),
  artifact_refs: z.array(artifact).max(100),
}).strict();

/** Physical CTR-008 / AEAS-0503 document. Stored assertions never transition native tasks. */
export const TaskGraphSchema = z.object({
  schema: z.literal('WorkItemTaskGraph/v1'), kind: z.literal('task_graph'),
  work_id: z.string().uuid(), graph_revision: z.number().int().positive(), root_goal_digest: hash,
  nodes: z.array(node).min(1).max(200), edges: z.array(edge).max(1000),
  decomposition: z.object({ decision: z.enum(['split', 'no_split']), reason: text }).strict(),
}).strict();

const run = z.object({
  node_id: id, run_id: id, agent_id: z.string().uuid(), task_id: z.string().uuid(),
  attempt_id: z.string().uuid().nullable(), attempt_binding_reason: text.nullable(),
  node_version: z.number().int().positive(), retry_ordinal: z.number().int().nonnegative().nullable(),
  lease_ref: text.nullable(), fence: z.number().int().nonnegative().nullable(), package_digest: hash.nullable(),
  state: text, session_id: id.nullable(), dispatch_id: id.nullable(), terminal_id: id.nullable(),
  invocation_ids: z.array(id).max(100),
}).strict();
const delegation = z.object({
  parent_node_id: id, child_node_id: id, objective: text,
  invariants: z.array(text).min(1).max(100), context_refs: z.array(artifact).max(100),
  tools: z.array(text).max(100), budget: budget.nullable(), stop_escalation: text, return_schema: text,
}).strict();

/** CTR-009/010 and AEAS-1503: native attempt, run, invocation and artifact IDs stay separate. */
export const AgentGraphSchema = z.object({
  schema: z.literal('WorkItemAgentGraph/v1'), kind: z.literal('agent_graph'),
  work_id: z.string().uuid(), graph_revision: z.number().int().positive(),
  runs: z.array(run).min(1).max(200), delegations: z.array(delegation).max(1000),
}).strict();

export type GraphDocument = z.infer<typeof TaskGraphSchema> | z.infer<typeof AgentGraphSchema>;
export type GraphKind = GraphDocument['kind'];

/** Bound the DAG before any dispatch; no self edge, cycle, duplicate or dangling identity. */
export function checkDag(ids: string[], edges: Array<{ from: string; to: string }>) {
  const known = new Set(ids);
  if (known.size !== ids.length) return false;
  const next = new Map(ids.map(value => [value, [] as string[]]));
  const degrees = new Map(ids.map(value => [value, 0]));
  const pairs = new Set<string>();
  for (const edge of edges) {
    const pair = `${edge.from}\u0000${edge.to}`;
    if (edge.from === edge.to || !known.has(edge.from) || !known.has(edge.to) || pairs.has(pair)) return false;
    pairs.add(pair); next.get(edge.from)!.push(edge.to); degrees.set(edge.to, degrees.get(edge.to)! + 1);
  }
  const queue = ids.filter(value => degrees.get(value) === 0);
  let visited = 0;
  while (queue.length) {
    const current = queue.pop()!; visited++;
    for (const target of next.get(current)!) {
      degrees.set(target, degrees.get(target)! - 1);
      if (degrees.get(target) === 0) queue.push(target);
    }
  }
  return visited === ids.length;
}
