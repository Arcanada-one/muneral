import { describe, expect, it } from '@jest/globals';
import {
  freezeActivitySet,
  signSnapshotCursor,
  turnSnapshotPage,
  TaskActivitySnapshotProposalError,
  type SnapshotActivityRow,
  type SnapshotOpenState,
} from '../src/activity-snapshot/task-activity-snapshot-cursor-proposal.js';

const SECRET = 'proposal-test-secret-not-for-production';
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const KEY_HASH = 'keyhash-aaaa';
const NOW = Date.parse('2026-11-10T14:00:00.000Z');

function expectProposalError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected proposal error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TaskActivitySnapshotProposalError);
    expect((error as TaskActivitySnapshotProposalError).code).toBe(code);
  }
}

function openState(rows: SnapshotActivityRow[]): SnapshotOpenState {
  return {
    snapshot_id: '55555555-5555-4555-8555-555555555555',
    task_id: TASK_ID,
    epoch: 7,
    consistency: 'seq-prefix',
    order: 'created_at_desc_id_desc',
    high_water: { task_seq: 4, kb_revision: 42, task_deleted: false },
    digest: 'sha256:deadbeef',
    rows,
    captured_at_ms: NOW,
  };
}

function seedRows(): SnapshotActivityRow[] {
  return freezeActivitySet([
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000004', created_at: '2026-11-10T12:00:00.000000Z', task_seq: 4 },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003', created_at: '2026-11-10T12:00:00.000000Z', task_seq: 3 },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', created_at: '2026-11-10T11:00:00.000000Z', task_seq: 2 },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', created_at: '2026-11-10T10:00:00.000000Z', task_seq: 1 },
  ]);
}

describe('TaskActivitySnapshot cursor proposal (no route)', () => {
  it('contiguous pages: duplicate created_at uses id DESC tie-break without gaps', () => {
    const rows = seedRows();
    expect(rows.map((row) => row.id.slice(-1))).toEqual(['4', '3', '2', '1']);
    expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4]);

    const open = openState(rows);
    const page1 = turnSnapshotPage(
      { task_id: TASK_ID, page_size: 2 },
      { authorized: true, key_id_hash: KEY_HASH },
      open,
      SECRET,
      NOW,
    );
    expect(page1.rows.map((row) => row.position)).toEqual([1, 2]);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBeTruthy();

    const page2 = turnSnapshotPage(
      { task_id: TASK_ID, page_size: 2, cursor: page1.next_cursor! },
      { authorized: true, key_id_hash: KEY_HASH },
      open,
      SECRET,
      NOW,
    );
    expect(page2.rows.map((row) => row.position)).toEqual([3, 4]);
    expect(page2.has_more).toBe(false);
    expect(page2.next_cursor).toBeNull();
    expect([...page1.rows, ...page2.rows].map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(page1.digest).toBe(page2.digest);
  });

  it('concurrent writes during paging: later inserts do not appear in the opened cut', () => {
    const open = openState(seedRows());
    const page1 = turnSnapshotPage(
      { task_id: TASK_ID, page_size: 2 },
      { authorized: true, key_id_hash: KEY_HASH },
      open,
      SECRET,
      NOW,
    );

    // A concurrent writer commits a newer row after page 1. The opened cut is frozen.
    const mutatedWorld = freezeActivitySet([
      ...seedRows().map(({ position: _position, ...rest }) => rest),
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099', created_at: '2026-11-10T13:00:00.000000Z', task_seq: 5 },
    ]);
    expect(mutatedWorld).toHaveLength(5);

    const page2 = turnSnapshotPage(
      { task_id: TASK_ID, page_size: 2, cursor: page1.next_cursor! },
      { authorized: true, key_id_hash: KEY_HASH },
      open,
      SECRET,
      NOW,
    );
    expect(page2.total).toBe(4);
    expect(page2.rows.some((row) => row.id.endsWith('0099'))).toBe(false);
  });

  it('stale or expired cursor is refused; forged high-water is malformed/changed', () => {
    const open = openState(seedRows());
    const page1 = turnSnapshotPage(
      { task_id: TASK_ID, page_size: 2 },
      { authorized: true, key_id_hash: KEY_HASH },
      open,
      SECRET,
      NOW,
    );

    expectProposalError(
      () =>
        turnSnapshotPage(
          { task_id: TASK_ID, page_size: 2, cursor: page1.next_cursor! },
          { authorized: true, key_id_hash: KEY_HASH },
          open,
          SECRET,
          NOW + 901_000,
        ),
      'CURSOR_EXPIRED',
    );

    const forged = signSnapshotCursor(
      {
        snapshot_id: open.snapshot_id,
        task_id: TASK_ID,
        epoch: open.epoch,
        high_water: { task_seq: 999, kb_revision: 42, task_deleted: false },
        last_position: 2,
        last_seq: 3,
        key_id_hash: KEY_HASH,
        expires_at_ms: NOW + 60_000,
      },
      SECRET,
    );
    expectProposalError(
      () =>
        turnSnapshotPage(
          { task_id: TASK_ID, page_size: 2, cursor: forged },
          { authorized: true, key_id_hash: KEY_HASH },
          open,
          SECRET,
          NOW,
        ),
      'SNAPSHOT_CHANGED',
    );

    const otherTask = signSnapshotCursor(
      {
        snapshot_id: open.snapshot_id,
        task_id: '99999999-9999-4999-8999-999999999999',
        epoch: open.epoch,
        high_water: open.high_water,
        last_position: 2,
        last_seq: 3,
        key_id_hash: KEY_HASH,
        expires_at_ms: NOW + 60_000,
      },
      SECRET,
    );
    expectProposalError(
      () =>
        turnSnapshotPage(
          { task_id: TASK_ID, page_size: 2, cursor: otherTask },
          { authorized: true, key_id_hash: KEY_HASH },
          open,
          SECRET,
          NOW,
        ),
      'NOT_AUTHORIZED',
    );
  });

  it('revoked grant mid-pagination refuses page 2 with no rows returned', () => {
    const open = openState(seedRows());
    const page1 = turnSnapshotPage(
      { task_id: TASK_ID, page_size: 2 },
      { authorized: true, key_id_hash: KEY_HASH },
      open,
      SECRET,
      NOW,
    );
    expect(page1.rows).toHaveLength(2);

    expectProposalError(
      () =>
        turnSnapshotPage(
          { task_id: TASK_ID, page_size: 2, cursor: page1.next_cursor! },
          { authorized: false, key_id_hash: KEY_HASH },
          open,
          SECRET,
          NOW,
        ),
      'NOT_AUTHORIZED',
    );
  });
});
