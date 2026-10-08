import type { Task } from './tasks';

export interface TaskSelection {
  workspaceSlug: string;
  projectSlug: string;
  taskId: string;
}
export type ReadOutcome = 'idle' | 'loading' | 'ready' | 'denied' | 'missing' | 'unavailable' | 'disposed';
export interface DetailSnapshot {
  outcome: ReadOutcome;
  selection: Readonly<TaskSelection> | null;
  generation: number;
  serverUpdatedAt: string | null;
  revision: number | null;
  freshness: 'unknown' | 'readback';
}
export type DetailTask = Task & {revision?: number};
export interface DetailReadPort {
  load(selection: TaskSelection, signal: AbortSignal): Promise<DetailTask>;
  peek(selection: TaskSelection): DetailTask | undefined;
  clear(): void;
}
export interface DetailNavigationPort {
  current(): TaskSelection | null;
  open(selection: TaskSelection): void;
}
export class DetailReadFailure extends Error {
  constructor(readonly outcome: 'denied' | 'missing' | 'unavailable', readonly transient = false) {
    super(outcome);
  }
}
export function sameSelection(a: TaskSelection | null, b: TaskSelection | null): boolean {
  return !!a && !!b && a.workspaceSlug === b.workspaceSlug && a.projectSlug === b.projectSlug && a.taskId === b.taskId;
}
const valid = (s: TaskSelection) => [s.workspaceSlug, s.projectSlug, s.taskId]
  .every(v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\s/\\?#]/.test(v));

/** Per-session replace-read controller. Query owns content; the internal snapshot never contains it.
 * Cancellation saves work; the generation and committed-location checks decide publication.
 * reuse: existing Query projection and Next router; no persistence or external control port.
 */
export class TaskDetailController {
  private state: DetailSnapshot = Object.freeze({outcome: 'idle', selection: null, generation: 0, serverUpdatedAt: null,
    revision: null, freshness: 'unknown'});
  private observers = new Set<() => void>();
  private pending?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly read: DetailReadPort, private readonly navigation: DetailNavigationPort,
    private readonly deadlineMs = 10_000) {}

  snapshot = (): DetailSnapshot => this.state;
  subscribe = (observer: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  };
  private publish(outcome: ReadOutcome, selection: TaskSelection | null, serverUpdatedAt: string | null = null, revision: number | null = null) {
    this.state = Object.freeze({outcome, selection: selection ? Object.freeze({...selection}) : null,
      generation: this.state.generation, serverUpdatedAt, revision, freshness: outcome === 'ready' ? 'readback' : 'unknown'});
    this.observers.forEach(fn => fn());
  }
  private invalidate() {
    this.pending?.abort();
    this.pending = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.state = {...this.state, generation: this.state.generation + 1};
    this.read.clear();
  }
  /** Caller may request navigation; only the committed route can receive the loaded projection. */
  openTask(selection: TaskSelection, navigate = true): void {
    if (this.disposed) return;
    if (!valid(selection)) { this.invalidate(); this.publish('denied', null); return; }
    if (sameSelection(this.state.selection, selection) && ['loading', 'ready'].includes(this.state.outcome)) return;
    this.invalidate();
    const chosen = {...selection};
    const generation = this.state.generation;
    const request = new AbortController();
    this.pending = request;
    this.publish('loading', chosen);
    if (navigate) {
      try { this.navigation.open(chosen); }
      catch { this.invalidate(); this.publish('unavailable', chosen); return; }
    }
    const current = () => !this.disposed && generation === this.state.generation &&
      !request.signal.aborted && sameSelection(this.state.selection, chosen);
    this.timer = setTimeout(() => {
      if (!current()) return;
      this.invalidate();
      this.publish('unavailable', chosen);
    }, this.deadlineMs);
    const run = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const task = await this.read.load(chosen, request.signal);
          if (!current()) return;
          if (task.id !== chosen.taskId || !sameSelection(this.navigation.current(), chosen)) {
            this.invalidate(); this.publish('denied', chosen); return;
          }
          clearTimeout(this.timer);
          this.timer = undefined;
          this.pending = undefined;
          this.publish('ready', chosen, task.updatedAt, task.revision ?? null);
          return;
        } catch (e) {
          if (!current()) return;
          if (attempt === 0 && e instanceof DetailReadFailure && e.transient) continue;
          const outcome = e instanceof DetailReadFailure ? e.outcome : 'unavailable';
          this.invalidate(); this.publish(outcome, chosen); return;
        }
      }
    };
    void run();
  }
  /** A caller cannot render cached content for a different committed route. */
  taskFor(selection: TaskSelection): Task | undefined {
    if (this.disposed || this.state.outcome !== 'ready' || !sameSelection(this.state.selection, selection) ||
      !sameSelection(this.navigation.current(), selection)) return undefined;
    const task = this.read.peek(selection);
    return task?.id === selection.taskId ? task : undefined;
  }
  leave(): void {
    if (this.disposed) return;
    this.invalidate(); this.publish('idle', null);
  }
  dispose(): void {
    if (this.disposed) return;
    this.invalidate(); this.disposed = true; this.publish('disposed', null); this.observers.clear();
  }
}
