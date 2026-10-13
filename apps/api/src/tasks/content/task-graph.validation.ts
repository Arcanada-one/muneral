import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AgentGraphSchema, TaskGraphSchema, checkDag } from './task-graph.schema.js';
import type { GraphDocument, GraphKind } from './task-graph.schema.js';

export function parseGraph(kind: GraphKind, taskId: string, expected: number, raw: unknown): GraphDocument {
  const parsed = (kind === 'task_graph' ? TaskGraphSchema : AgentGraphSchema).safeParse(raw);
  if (!parsed.success) throw new BadRequestException('INVALID_GRAPH_DOCUMENT');
  const doc = parsed.data;
  if (doc.work_id !== taskId || doc.graph_revision !== expected + 1) throw new BadRequestException('GRAPH_IDENTITY_OR_REVISION_MISMATCH');
  const ids = doc.kind === 'task_graph' ? doc.nodes.map(n => n.node_id) : doc.runs.map(n => n.node_id);
  const edges = doc.kind === 'task_graph' ? doc.edges : doc.delegations.map(d => ({ from: d.parent_node_id, to: d.child_node_id }));
  if (!checkDag(ids, edges)) throw new BadRequestException('GRAPH_NOT_A_DAG');
  if (doc.kind === 'task_graph') {
    for (const n of doc.nodes) {
      const incoming = doc.edges.filter(e => e.to === n.node_id).map(e => e.from).sort();
      if (JSON.stringify([...n.dependencies].sort()) !== JSON.stringify(incoming)) throw new BadRequestException('GRAPH_DEPENDENCY_MISMATCH');
    }
    for (const e of doc.edges) {
      const producer = doc.nodes.find(n => n.node_id === e.from)!;
      if (!producer.expected_outputs.some(o => o.schema === e.schema && o.version === e.version)) throw new BadRequestException('GRAPH_OUTPUT_SCHEMA_MISMATCH');
    }
  } else {
    // An orchestration run can contain several agent sessions/dispatches. Keep
    // its observed identity distinct from the node, session and dispatch IDs.
    const identities = doc.runs.map(r => JSON.stringify([r.run_id, r.agent_id, r.session_id, r.dispatch_id]));
    if (new Set(identities).size !== doc.runs.length) throw new BadRequestException('DUPLICATE_RUN_BINDING');
    const invocations = doc.runs.flatMap(r => r.invocation_ids);
    if (new Set(invocations).size !== invocations.length) throw new BadRequestException('DUPLICATE_INVOCATION_ID');
    for (const r of doc.runs) {
      if (r.task_id !== taskId || (r.attempt_id === null ? r.attempt_binding_reason === null || r.retry_ordinal !== null : r.attempt_binding_reason !== null || r.retry_ordinal === null)) {
        throw new BadRequestException('INVALID_ATTEMPT_BINDING');
      }
    }
  }
  return doc;
}

/** Resolve native references under the same custody lock as the immutable write. */
export async function validateGraphReferences(tx: Prisma.TransactionClient, doc: GraphDocument) {
  const task = await tx.task.findUniqueOrThrow({ where: { id: doc.work_id }, select: { description: true, title: true, project: { select: { workspaceId: true } } } });
  const refs = doc.kind === 'task_graph'
    ? [...doc.nodes.flatMap(n => [...n.inputs, ...n.expected_outputs.flatMap(o => o.artifact_refs)]), ...doc.edges.flatMap(e => e.artifact_refs)]
    : doc.delegations.flatMap(d => d.context_refs);
  const ids = [...new Set(refs.map(r => r.artifact_id))];
  const rows = ids.length ? await tx.taskArtifactRevision.findMany({ where: { taskId: doc.work_id, id: { in: ids } }, select: { id: true, sha256: true } }) : [];
  if (refs.some(ref => !rows.some(row => row.id === ref.artifact_id && row.sha256 === ref.sha256))) throw new BadRequestException('INVALID_TASK_ARTIFACT_REF');
  if (doc.kind === 'task_graph') {
    const rootDigest = createHash('sha256').update(task.description ?? task.title, 'utf8').digest('hex');
    if (rootDigest !== doc.root_goal_digest) throw new BadRequestException('ROOT_GOAL_DIGEST_MISMATCH');
    const linked = [...new Set(doc.nodes.flatMap(n => n.task_id === null ? [] : [n.task_id]))];
    const tasks = linked.length ? await tx.task.count({ where: { id: { in: linked }, project: { workspaceId: task.project.workspaceId }, OR: [{ id: doc.work_id }, { parentId: doc.work_id }] } }) : 0;
    if (tasks !== linked.length) throw new BadRequestException('INVALID_TASK_NODE_REF');
  } else {
    const agents = await tx.taskAgent.findMany({ where: { taskId: doc.work_id, agent: { workspaceId: task.project.workspaceId } }, select: { agentId: true } });
    if (doc.runs.some(r => !agents.some(a => a.agentId === r.agent_id))) throw new BadRequestException('INVALID_ASSIGNED_AGENT_REF');
    const attempts = doc.runs.flatMap(r => r.attempt_id === null ? [] : [r.attempt_id]);
    const native = attempts.length ? await tx.taskExecutionAttempt.findMany({ where: { taskId: doc.work_id, attemptId: { in: attempts } }, select: { attemptId: true, ordinal: true, status: true } }) : [];
    if (doc.runs.some(r => r.attempt_id !== null && !native.some(a => a.attemptId === r.attempt_id && a.ordinal - 1 === r.retry_ordinal && a.status === r.state))) throw new BadRequestException('INVALID_NATIVE_ATTEMPT_REF');
  }
}
