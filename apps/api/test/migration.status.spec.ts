// MUN-0040: AUP-X03 HistoricalTaskImport — the two rules that keep an imported
// card's past from being restated as a present claim.

import { mapHistoricalStatus, NOT_REVALIDATED } from '../src/migration/migration.status';

describe('historical status mapping', () => {
  it.each(['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'])(
    'maps the known status %s onto itself',
    (status) => {
      expect(mapHistoricalStatus(status)).toMatchObject({
        taskStatus: status,
        historicalStatus: status,
        unmapped: false,
      });
    },
  );

  it('treats an old done as an assertion about the past, never a fresh verdict', () => {
    const mapped = mapHistoricalStatus('done');
    expect(mapped.historicalAssertedDone).toBe(true);
    expect(mapped.currentVerification).toBe(NOT_REVALIDATED);
  });

  it('never asserts done for any other status', () => {
    for (const status of ['todo', 'in_progress', 'review', 'blocked', 'cancelled', 'shipped']) {
      expect(mapHistoricalStatus(status).historicalAssertedDone).toBe(false);
    }
  });

  it('parks an unmappable status in todo and keeps the raw string verbatim', () => {
    const mapped = mapHistoricalStatus('Wontfix-2019');
    expect(mapped).toMatchObject({
      taskStatus: 'todo',
      historicalStatus: 'Wontfix-2019',
      unmapped: true,
      historicalAssertedDone: false,
      currentVerification: NOT_REVALIDATED,
    });
  });

  it('normalizes case and padding without rewriting what it stores', () => {
    const mapped = mapHistoricalStatus('  DONE  ');
    expect(mapped.taskStatus).toBe('done');
    expect(mapped.historicalAssertedDone).toBe(true);
    // The source's own spelling survives for audit.
    expect(mapped.historicalStatus).toBe('  DONE  ');
  });

  it('always reports not_revalidated — this path never re-verifies anything', () => {
    for (const status of ['done', 'todo', 'anything-at-all']) {
      expect(mapHistoricalStatus(status).currentVerification).toBe('not_revalidated');
    }
  });
});
