import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';

describe('production deploy readiness gate', () => {
  it('polls dependency readiness with bounded curl and refuses exhausted attempts', () => {
    const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const step = workflow.split('- name: Wait for database readiness')[1]?.split('\n      - name:')[0];
    expect(step).toBeDefined();
    expect(step).toMatch(/if curl --connect-timeout 2 --max-time 3 -fsS http:\/\/localhost:3500\/health\/ready/);
    expect(step).toMatch(/for i in \$\(seq 1 20\)/);
    expect(step).toMatch(/exit 1/);
    expect(step).toMatch(/exit 0/);
  });
});
