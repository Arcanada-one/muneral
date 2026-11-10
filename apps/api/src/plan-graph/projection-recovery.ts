// KCLIVE-10 projection recovery rematch of KCLIVE-01 observation reducer
// semantics: recover from authorized snapshot + watermark; never replay a
// business command. Live package consume of @arcanada/access-contracts remains
// NOT_MEASURED until published (KCLIVE-01 residual).

export type ProjectionMode = 'live' | 'replay' | 'fixture';

export type ProjectionHealth =
  | 'current'
  | 'reconciling'
  | 'stale'
  | 'failed_closed';

export interface AuthorizedSnapshotV1 {
  schema: 'MuneralAuthorizedProjectionSnapshot/v1';
  watermark: string;
  digest: string;
  view: Record<string, unknown>;
}

export interface ObservationEventV1 {
  sequence: number;
  eventId: string;
  /** Business command payloads are refused for recovery paths. */
  kind: 'observation' | 'business_command';
  payload: Record<string, unknown>;
}

export interface ProjectionStateV1 {
  health: ProjectionHealth;
  mode: ProjectionMode;
  watermark: string | null;
  view: Record<string, unknown> | null;
  holds: string[];
  lastError: string | null;
}

export class ProjectionRecoveryError extends Error {
  readonly code = 'PROJECTION_RECOVERY_REFUSED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectionRecoveryError';
  }
}

export function emptyProjection(mode: ProjectionMode): ProjectionStateV1 {
  return {
    health: 'stale',
    mode,
    watermark: null,
    view: null,
    holds: ['no_authorized_snapshot'],
    lastError: null,
  };
}

/**
 * Restore from an authorized consistent snapshot. This is the only restart
 * path that clears a gap/reconciling hold. Does not execute commands.
 */
export function recoverFromAuthorizedSnapshot(
  mode: ProjectionMode,
  snapshot: AuthorizedSnapshotV1,
): ProjectionStateV1 {
  if (snapshot.schema !== 'MuneralAuthorizedProjectionSnapshot/v1') {
    throw new ProjectionRecoveryError(
      `unknown snapshot schema: ${snapshot.schema}`,
    );
  }
  if (!snapshot.watermark || !snapshot.digest) {
    throw new ProjectionRecoveryError(
      'authorized snapshot requires watermark and digest',
    );
  }
  return {
    health: 'current',
    mode,
    watermark: snapshot.watermark,
    view: { ...snapshot.view },
    holds: [],
    lastError: null,
  };
}

/**
 * Fold observation events only. Duplicate/out-of-order/gapped sequences set
 * reconciling/stale; business_command events are refused (never replayed).
 */
export function foldObservationEvents(
  state: ProjectionStateV1,
  events: ObservationEventV1[],
): ProjectionStateV1 {
  if (state.health === 'failed_closed') return state;

  let next: ProjectionStateV1 = {
    ...state,
    view: state.view ? { ...state.view } : null,
    holds: [...state.holds],
  };

  const seen = new Set<string>();
  let expected =
    next.watermark !== null ? Number.parseInt(next.watermark, 10) + 1 : null;

  for (const event of events) {
    if (event.kind === 'business_command') {
      throw new ProjectionRecoveryError(
        'projection recovery never replays a business command',
      );
    }

    if (seen.has(event.eventId)) {
      // duplicate — ignore, do not re-apply
      continue;
    }
    seen.add(event.eventId);

    if (expected !== null && event.sequence > expected) {
      next = {
        ...next,
        health: 'reconciling',
        holds: uniqueHold(next.holds, `gap_before_${event.sequence}`),
      };
      expected = null;
      continue;
    }

    if (expected !== null && event.sequence < expected) {
      // out-of-order behind watermark — ignore
      continue;
    }

    if (next.view === null) {
      next = {
        ...next,
        health: 'reconciling',
        holds: uniqueHold(next.holds, 'missing_authorized_snapshot'),
      };
      continue;
    }

    next = {
      ...next,
      health: next.holds.length === 0 ? 'current' : 'reconciling',
      watermark: String(event.sequence),
      view: {
        ...next.view,
        lastEventId: event.eventId,
        lastSequence: event.sequence,
      },
    };
    expected = event.sequence + 1;
  }

  return next;
}

function uniqueHold(holds: string[], hold: string): string[] {
  return holds.includes(hold) ? holds : [...holds, hold];
}
