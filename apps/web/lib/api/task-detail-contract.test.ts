import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailReadFailure, TaskDetailController, type TaskSelection, type DetailTask } from './task-detail-controller';

const a = {workspaceSlug: 'own', projectSlug: 'project', taskId: 'task-a'};
const b = {...a, taskId: 'task-b'};
const task = (s: TaskSelection): DetailTask => ({id: s.taskId, projectId: 'project-id', title: 'Protected title', revision:7,
  description: 'Protected description', status: 'todo', priority: 'medium', actorType: 'human',
  createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:01Z'});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function fixture() {
  let location: TaskSelection | null = a;
  const cached = new Map<string,DetailTask>();
  const loads: {selection: TaskSelection; signal: AbortSignal; resolve: (t: DetailTask) => void; reject: (e: unknown) => void}[] = [];
  const read = {load: vi.fn((selection: TaskSelection, signal: AbortSignal) => new Promise<DetailTask>((resolve,reject) => {
    // Deliberately ignore cancellation to prove the publication fence independently.
    loads.push({selection, signal, resolve: t => {cached.set(JSON.stringify(selection),t); resolve(t);}, reject});
  })), peek: (s: TaskSelection) => cached.get(JSON.stringify(s)), clear: vi.fn(() => {cached.clear();})};
  const navigation = {current: () => location, open: vi.fn((s: TaskSelection) => {location=s;})};
  const controller = new TaskDetailController(read,navigation);
  return {controller,loads,read,navigation,commit: (s: TaskSelection | null) => {location=s;}};
}
afterEach(() => {vi.useRealTimers();});
describe('I05 replace-read contract', () => {
  it('renders exact backend task after committed navigation, without exposing content in snapshot', async () => {
    const f=fixture(); f.controller.openTask(a); f.loads[0].resolve(task(a)); await flush();
    expect(f.controller.snapshot().outcome).toBe('ready');
    expect(f.controller.snapshot()).toMatchObject({revision:7,freshness:'readback'});
    expect(f.controller.taskFor(a)?.title).toBe('Protected title');
    expect(f.navigation.open).toHaveBeenCalledWith(a);
    const snapshot=JSON.stringify(f.controller.snapshot());
    expect(snapshot).not.toContain('Protected'); expect(snapshot.length).toBeLessThan(16*1024);
    f.controller.dispose();
  });
  it('late A cannot publish over B, even when the transport ignores abort', async () => {
    const f=fixture(); f.controller.openTask(a); f.controller.openTask(b);
    expect(f.loads[0].signal.aborted).toBe(true);
    f.loads[1].resolve(task(b)); await flush();
    f.loads[0].resolve(task(a)); await flush();
    expect(f.controller.snapshot().selection).toEqual(b);
    expect(f.controller.snapshot().outcome).toBe('ready');
    expect(f.controller.taskFor(a)).toBeUndefined();
    expect(f.controller.taskFor(b)?.id).toBe(b.taskId);
    f.controller.dispose();
  });
  it('same-task workspace/project switch rejects the earlier generation', async () => {
    const f=fixture();const foreign={...a,workspaceSlug:'other',projectSlug:'other'};
    f.controller.openTask(a);f.controller.openTask(foreign);
    f.loads[0].resolve(task(a));await flush();
    expect(f.controller.snapshot().outcome).toBe('loading');
    expect(f.controller.taskFor(foreign)).toBeUndefined();f.controller.dispose();
  });
  it('logout invalidates pending read and later protected response cannot restore it', async () => {
    const f=fixture();f.controller.openTask(a);f.controller.leave();
    f.loads[0].resolve(task(a));await flush();
    expect(f.controller.snapshot().outcome).toBe('idle');
    expect(f.controller.snapshot().selection).toBeNull();expect(f.controller.taskFor(a)).toBeUndefined();f.controller.dispose();
  });
  it('revocation clears a ready projection immediately', async () => {
    const f=fixture();f.controller.openTask(a);f.loads[0].resolve(task(a));await flush();
    f.controller.leave();expect(f.controller.taskFor(a)).toBeUndefined();expect(f.read.clear).toHaveBeenCalledTimes(2);f.controller.dispose();
    expect(f.controller.snapshot()).toMatchObject({revision:null,freshness:'unknown'});
  });
  it('same task under a new session never receives the previous session projection', async () => {
    const old=fixture(),fresh=fixture();old.controller.openTask(a);old.controller.dispose();fresh.controller.openTask(a);
    old.loads[0].resolve(task(a));await flush();
    expect(fresh.controller.taskFor(a)).toBeUndefined();expect(fresh.controller.snapshot().outcome).toBe('loading');fresh.controller.dispose();
  });
  it('an intent whose URL never commits cannot become ready', async () => {
    const f=fixture();f.controller.openTask(b);f.commit(a);f.loads[0].resolve(task(b));await flush();
    expect(f.controller.snapshot().outcome).toBe('denied');expect(f.controller.taskFor(b)).toBeUndefined();f.controller.dispose();
  });
  it('a direct committed URL loads without inventing a navigation acknowledgement', async () => {
    const f=fixture();f.commit(b);f.controller.openTask(b,false);f.loads[0].resolve(task(b));await flush();
    expect(f.navigation.open).not.toHaveBeenCalled();expect(f.controller.taskFor(b)?.id).toBe(b.taskId);f.controller.dispose();
  });
  it('a mismatched task ID fails closed', async () => {
    const f=fixture();f.controller.openTask(a);f.loads[0].resolve(task(b));await flush();
    expect(f.controller.snapshot().outcome).toBe('denied');expect(f.controller.taskFor(a)).toBeUndefined();f.controller.dispose();
  });
  it.each(['denied','missing','unavailable'] as const)('keeps %s distinct and does not retry permanent failures', async outcome => {
    const f=fixture();f.controller.openTask(a);f.loads[0].reject(new DetailReadFailure(outcome));await flush();
    expect(f.controller.snapshot().outcome).toBe(outcome);expect(f.read.load).toHaveBeenCalledTimes(1);f.controller.dispose();
  });
  it('retries one transient failure, then stops', async () => {
    const f=fixture();f.controller.openTask(a);f.loads[0].reject(new DetailReadFailure('unavailable',true));await flush();
    expect(f.loads.length).toBe(2);f.loads[1].reject(new DetailReadFailure('unavailable',true));await flush();
    expect(f.read.load).toHaveBeenCalledTimes(2);expect(f.controller.snapshot().outcome).toBe('unavailable');f.controller.dispose();
  });
  it('one total deadline bounds both attempts and rejects a late success', async () => {
    vi.useFakeTimers();const f=fixture();f.controller.openTask(a);
    await vi.advanceTimersByTimeAsync(9000);f.loads[0].reject(new DetailReadFailure('unavailable',true));await flush();
    await vi.advanceTimersByTimeAsync(1000);expect(f.controller.snapshot().outcome).toBe('unavailable');
    f.loads[1].resolve(task(a));await flush();expect(f.controller.taskFor(a)).toBeUndefined();f.controller.dispose();
  });
  it('duplicate command is idempotent and double disposal leaves no observers', async () => {
    const f=fixture();const observed=vi.fn();const unsubscribe=f.controller.subscribe(observed);
    f.controller.openTask(a);f.controller.openTask(a);expect(f.read.load).toHaveBeenCalledTimes(1);
    f.controller.dispose();const count=observed.mock.calls.length;f.controller.dispose();f.controller.openTask(b);
    expect(observed).toHaveBeenCalledTimes(count);unsubscribe();expect(f.controller.snapshot().outcome).toBe('disposed');
  });
  it('invalid route tuple never reaches the HTTP or navigation adapter', () => {
    const f=fixture();f.controller.openTask({...a,workspaceSlug:'../../other'});
    expect(f.read.load).not.toHaveBeenCalled();expect(f.navigation.open).not.toHaveBeenCalled();
    expect(f.controller.snapshot().outcome).toBe('denied');f.controller.dispose();
  });
});
