import {
  assertEdgeMapping,
  assertNoBlockingCycle,
  PlanCycleError,
  PlanEdgeMappingError,
} from '../src/plan-graph/plan-cycle.js';
import {
  digestCreateCommand,
  normalizeCreateCommand,
} from '../src/plan-graph/command-digest.js';
import { evaluatePlanReadiness } from '../src/plan-graph/plan-readiness.js';
import { buildPlanSnapshot } from '../src/plan-graph/plan-snapshot.js';
import {
  emptyProjection,
  foldObservationEvents,
  ProjectionRecoveryError,
  recoverFromAuthorizedSnapshot,
} from '../src/plan-graph/projection-recovery.js';
import {
  maySubscribeToProject,
  scopeOutboxEventsByMembership,
} from '../src/plan-graph/project-membership.js';
import type { PlanSnapshotV1 } from '../src/plan-graph/plan-graph.types.js';

describe('KCLIVE-10 plan-graph unit surface', () => {
  describe('AC1 command digest association', () => {
    it('same normalized content yields the same digest', () => {
      const a = normalizeCreateCommand({
        operation: 'task.create',
        projectId: '11111111-1111-1111-1111-111111111111',
        title: 'Root',
        tags: ['b', 'a'],
        description: null,
      });
      const b = normalizeCreateCommand({
        operation: 'task.create',
        projectId: '11111111-1111-1111-1111-111111111111',
        title: 'Root',
        tags: ['a', 'b'],
      });
      expect(digestCreateCommand(a)).toBe(digestCreateCommand(b));
    });

    it('different content yields a different digest', () => {
      const a = normalizeCreateCommand({
        operation: 'task.create',
        projectId: '11111111-1111-1111-1111-111111111111',
        title: 'Root A',
      });
      const b = normalizeCreateCommand({
        operation: 'task.create',
        projectId: '11111111-1111-1111-1111-111111111111',
        title: 'Root B',
      });
      expect(digestCreateCommand(a)).not.toBe(digestCreateCommand(b));
    });
  });

  describe('AC2/AC3 plan revision graph', () => {
    it('rejects blocking cycles among required_for_acceptance edges', () => {
      expect(() =>
        assertNoBlockingCycle([
          {
            fromNodeId: 'a',
            toNodeId: 'b',
            acceptanceRole: 'required_for_acceptance',
          },
          {
            fromNodeId: 'b',
            toNodeId: 'a',
            acceptanceRole: 'required_for_acceptance',
          },
        ]),
      ).toThrow(PlanCycleError);
    });

    it('allows shared prerequisites (DAG join) and optional edges that close a loop', () => {
      expect(() =>
        assertNoBlockingCycle([
          {
            fromNodeId: 'shared',
            toNodeId: 'left',
            acceptanceRole: 'required_for_acceptance',
          },
          {
            fromNodeId: 'shared',
            toNodeId: 'right',
            acceptanceRole: 'required_for_acceptance',
          },
          {
            fromNodeId: 'left',
            toNodeId: 'shared',
            acceptanceRole: 'optional',
            nativeType: 'related_to',
          },
        ]),
      ).not.toThrow();
    });

    it('refuses optional → depends_on mapping', () => {
      expect(() =>
        assertEdgeMapping({
          fromNodeId: 'a',
          toNodeId: 'b',
          acceptanceRole: 'optional',
          nativeType: 'depends_on',
        }),
      ).toThrow(PlanEdgeMappingError);
    });

    it('builds a digested snapshot with exact revision readback fields', () => {
      const snap = buildPlanSnapshot({
        rootTaskId: '22222222-2222-2222-2222-222222222222',
        revision: 1,
        nodes: [
          { nodeId: 'root' },
          { nodeId: 'child', acceptedOutputContract: 'sha256:abc' },
        ],
        edges: [
          {
            fromNodeId: 'root',
            toNodeId: 'child',
            acceptanceRole: 'required_for_acceptance',
            nativeType: 'depends_on',
          },
        ],
      });
      expect(snap.schema).toBe('MuneralPlanSnapshot/v1');
      expect(snap.revision).toBe(1);
      expect(snap.planDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('cancelled alone does not satisfy required_for_acceptance readiness', () => {
      const snapshot: PlanSnapshotV1 = {
        schema: 'MuneralPlanSnapshot/v1',
        rootTaskId: 'r',
        revision: 1,
        nodes: [{ nodeId: 'dep' }, { nodeId: 'work' }],
        edges: [
          {
            fromNodeId: 'dep',
            toNodeId: 'work',
            acceptanceRole: 'required_for_acceptance',
          },
        ],
        planDigest: '0'.repeat(64),
      };
      const result = evaluatePlanReadiness(
        snapshot,
        new Map([
          [
            'dep',
            {
              nodeId: 'dep',
              status: 'cancelled',
              acceptedOutputSatisfied: false,
            },
          ],
        ]),
        'work',
      );
      expect(result.ready).toBe(false);
      expect(result.blockedBy.some((b) => b.reason === 'accepted_output_missing')).toBe(
        true,
      );
    });

    it('optional edges never block readiness', () => {
      const snapshot: PlanSnapshotV1 = {
        schema: 'MuneralPlanSnapshot/v1',
        rootTaskId: 'r',
        revision: 1,
        nodes: [{ nodeId: 'research' }, { nodeId: 'work' }],
        edges: [
          {
            fromNodeId: 'research',
            toNodeId: 'work',
            acceptanceRole: 'optional',
          },
        ],
        planDigest: '0'.repeat(64),
      };
      const result = evaluatePlanReadiness(snapshot, new Map(), 'work');
      expect(result.ready).toBe(true);
    });
  });

  describe('AC4 project membership subscription scope', () => {
    it('refuses join when socket is authenticated but not a project member', () => {
      const decision = maySubscribeToProject(
        'user-1',
        'proj-1',
        { userId: 'user-1', projectId: 'proj-1', isMember: false },
      );
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('not_project_workspace_member');
    });

    it('scopes outbox events by current membership set', () => {
      const { delivered, withheld } = scopeOutboxEventsByMembership(
        [
          { eventId: 'e1', projectId: 'p1' },
          { eventId: 'e2', projectId: 'p2' },
        ],
        new Set(['p1']),
      );
      expect(delivered.map((e) => e.eventId)).toEqual(['e1']);
      expect(withheld.map((e) => e.eventId)).toEqual(['e2']);
    });
  });

  describe('AC5 projection recovery rematch', () => {
    it('recovers from an authorized snapshot and ignores duplicates', () => {
      let state = emptyProjection('replay');
      state = recoverFromAuthorizedSnapshot('replay', {
        schema: 'MuneralAuthorizedProjectionSnapshot/v1',
        watermark: '10',
        digest: 'd'.repeat(64),
        view: { root: true },
      });
      expect(state.health).toBe('current');
      state = foldObservationEvents(state, [
        {
          sequence: 11,
          eventId: 'evt-11',
          kind: 'observation',
          payload: {},
        },
        {
          sequence: 11,
          eventId: 'evt-11',
          kind: 'observation',
          payload: {},
        },
      ]);
      expect(state.watermark).toBe('11');
      expect(state.health).toBe('current');
    });

    it('marks reconciling on gaps and refuses business command replay', () => {
      let state = recoverFromAuthorizedSnapshot('replay', {
        schema: 'MuneralAuthorizedProjectionSnapshot/v1',
        watermark: '1',
        digest: 'd'.repeat(64),
        view: {},
      });
      state = foldObservationEvents(state, [
        {
          sequence: 5,
          eventId: 'evt-5',
          kind: 'observation',
          payload: {},
        },
      ]);
      expect(state.health).toBe('reconciling');
      expect(() =>
        foldObservationEvents(state, [
          {
            sequence: 6,
            eventId: 'cmd-1',
            kind: 'business_command',
            payload: { op: 'task.create' },
          },
        ]),
      ).toThrow(ProjectionRecoveryError);
    });
  });
});
