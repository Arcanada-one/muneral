// MUN-0022 Phase F — the single pinned instant the fixture corpus is judged at.
//
// Every fixture embeds this authority-supplied instant, so corpus validity does
// not depend on the process calendar and the Python validator applies the same
// predicate against the same decision-bearing value.
//
// The corpus carries `deadline: 2027-01-01`, `deadline: 2027-06-01` and
// `expiresAt: 2027-07-30`. So on 2027-01-01 those specs flip to
// DEADLINE_EXCEEDED and the suite turns red for reasons unrelated to any change,
// while the Python validator stays green — which is the precise TS/Python
// disagreement the pinned instant was introduced to remove.
//
// The value is read from the independent Python validator rather than duplicated
// here. The fixture generator verifies that every request embeds this value.

import * as fs from 'node:fs';
import * as path from 'node:path';

const VALIDATOR = path.join(__dirname, 'validate_assembly_fixtures.py');

function readPinnedInstant(): string {
  const src = fs.readFileSync(VALIDATOR, 'utf8');
  const m = src.match(/^FIXTURE_EVALUATED_AT\s*=\s*"([^"]+)"/m);
  if (!m) {
    throw new Error(
      'FIXTURE_EVALUATED_AT is not defined in validate_assembly_fixtures.py — ' +
      'the fixture corpus has no explicit instant to pin against.',
    );
  }
  return m[1];
}

/**
 * The instant every fixture-driven TypeScript assertion evaluates against.
 * Identical, by construction, to the Python validator's own constant.
 */
export const FIXTURE_EVALUATED_AT = readPinnedInstant();
