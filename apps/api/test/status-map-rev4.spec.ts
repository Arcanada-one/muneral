import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mapHistoricalStatus } from '../src/migration/migration.status.js';
import { SUPPORTED_STATUS_MAP_REVISIONS, STATUS_MAP_REVISION } from '../src/migration/status-map/status-map.js';

const rows = [
  ['canonical', 'todo'], ['compliance_done', 'review'], ['deployed', 'review'],
  ['draft', 'todo'], ['implemented', 'review'], ['partial', 'in_progress'],
  ['pending_operator_gates', 'blocked'], ['prd', 'in_progress'], ['proposed', 'todo'],
  ['scaffold', 'in_progress'], ['blocked_pending', 'blocked'], ['promoted_to_active', 'in_progress'],
];

describe('DEC-AUP-0102 revision 4', () => {
  it('loads revision 4 and retains the prior replay set', () => {
    expect(STATUS_MAP_REVISION).toBe(4);
    expect(SUPPORTED_STATUS_MAP_REVISIONS).toEqual([2, 3, 4]);
  });
  it.each(rows)('projects %s to %s without asserting completion', (raw, status) => {
    expect(mapHistoricalStatus(raw, 4)).toEqual({
      taskStatus: status, historicalStatus: raw, historicalAssertedDone: false,
      currentVerification: 'not_revalidated', unmapped: false, statusMapRevision: 4,
    });
    expect(mapHistoricalStatus(raw, 3).unmapped).toBe(true);
  });
  it('preserves unknown-value and unknown-revision refusals', () => {
    expect(mapHistoricalStatus('frobnicated', 4).unmapped).toBe(true);
    expect(() => mapHistoricalStatus('canonical', 99)).toThrow(/revision 99 is not vendored/);
  });
  it('pins the frozen bytes reviewed for server/contract parity', () => {
    const file = fileURLToPath(new URL('../src/migration/status-map/status-map-v1-rev4.json', import.meta.url));
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(
      '57d60d1740b2a7b12bc593e11913eb4747ebf764c58fb904975fe371024f6bc5',
    );
  });
});
