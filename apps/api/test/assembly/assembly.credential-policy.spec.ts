import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { credentialRuleId } from '../../src/assembly/assembly.errors';
import { CREDENTIAL_POLICY_MANIFEST_SHA256 } from '../../src/assembly/credential-policy-v0.generated';

const manifest = path.join(__dirname, 'credential-policy-v0.json');
const generator = path.join(__dirname, 'generate-credential-policy.js');
const validator = path.join(__dirname, 'validate_assembly_fixtures.py');

function pythonRuleId(value: string): string | null {
  const script = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("v", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'print(json.dumps(module.credential_rule_id(sys.stdin.read())))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', script, validator], {
    input: value,
    encoding: 'utf8',
  }).trim()) as string | null;
}

describe('generated credential policy parity', () => {
  it('binds both generated outputs to the exact manifest bytes', () => {
    const expected = createHash('sha256').update(fs.readFileSync(manifest)).digest('hex');
    expect(CREDENTIAL_POLICY_MANIFEST_SHA256).toBe(expected);
  });

  it('passes the check-only freshness gate', () => {
    expect(execFileSync('node', [generator, '--check'], { encoding: 'utf8' }))
      .toContain('current');
  });

  it.each([
    ['ordinary', null],
    ['Bearer synthetic-example', 'bearer'],
    [`sk-${'a'.repeat(20)}`, 'openai_style'],
    [`github_pat_${'a'.repeat(24)}`, 'github_pat'],
    [`xoxb-${'a'.repeat(20)}`, 'slack'],
    [`AKIA${'A'.repeat(16)}`, 'aws_access_key'],
    [`glpat-${'a'.repeat(20)}`, 'gitlab_pat'],
    [`eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`, 'jwt'],
    ['A'.repeat(40), 'generic_base64'],
  ])('agrees across TypeScript and Python for %#', (value, expected) => {
    expect(credentialRuleId(value)).toBe(expected);
    expect(pythonRuleId(value)).toBe(expected);
  });
});
