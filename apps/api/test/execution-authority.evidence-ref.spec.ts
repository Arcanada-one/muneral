// MUN-0020: EvidenceRef validation tests — exhaustive coverage of bounds,
// null safety, control characters, label bounds, digest casing, and max count.

import {
  validateEvidenceRef,
  validateEvidenceRefs,
} from '../src/execution-authority/evidence-ref.validator';

const validRef = {
  uri: 'tasks/task-1/evidence/log.txt',
  digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  contentType: 'text/plain',
};

describe('validateEvidenceRef', () => {
  it('accepts a valid evidence reference', () => {
    expect(validateEvidenceRef(validRef)).toBeNull();
  });

  it('accepts optional label', () => {
    expect(
      validateEvidenceRef({ ...validRef, label: 'Log output' }),
    ).toBeNull();
  });

  // -- null/non-object safety --

  it('rejects null input', () => {
    const err = validateEvidenceRef(null);
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('non-null object');
  });

  it('rejects undefined input', () => {
    const err = validateEvidenceRef(undefined);
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('non-null object');
  });

  it('rejects non-object (string) input', () => {
    const err = validateEvidenceRef('not an object');
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('non-null object');
  });

  // -- URI validation --

  it('rejects empty URI', () => {
    const err = validateEvidenceRef({ ...validRef, uri: '' });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('uri');
  });

  it('rejects URI over 512 chars', () => {
    const err = validateEvidenceRef({
      ...validRef,
      uri: 'x'.repeat(513),
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('512');
  });

  it('rejects protocol-qualified URL', () => {
    const err = validateEvidenceRef({
      ...validRef,
      uri: 'https://example.com/evidence',
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('colon');
  });

  it('rejects URI with control characters', () => {
    const err = validateEvidenceRef({
      ...validRef,
      uri: 'tasks/\x00evidence',
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('control characters');
  });

  // -- digest validation --

  it('rejects non-string digest', () => {
    const err = validateEvidenceRef({
      ...validRef,
      digest: 123 as unknown as string,
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('digest');
  });

  it('rejects digest with uppercase hex', () => {
    const err = validateEvidenceRef({
      ...validRef,
      digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('lowercase');
  });

  it('rejects digest with wrong length', () => {
    const err = validateEvidenceRef({
      ...validRef,
      digest: 'abc123',
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('digest');
  });

  it('rejects digest with non-hex characters', () => {
    const err = validateEvidenceRef({
      ...validRef,
      digest: 'gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg',
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('digest');
  });

  // -- contentType validation --

  it('rejects unknown content type', () => {
    const err = validateEvidenceRef({
      ...validRef,
      contentType: 'application/octet-stream',
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('contentType');
  });

  // -- label validation --

  it('rejects non-string label', () => {
    const err = validateEvidenceRef({
      ...validRef,
      label: 123 as unknown as string,
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('label');
  });

  it('rejects label over 128 chars', () => {
    const err = validateEvidenceRef({
      ...validRef,
      label: 'x'.repeat(129),
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('128');
  });

  it('rejects label with control characters', () => {
    const err = validateEvidenceRef({
      ...validRef,
      label: 'bad\x01label',
    });
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('control characters');
  });
});

describe('validateEvidenceRefs', () => {
  it('accepts an empty array', () => {
    expect(validateEvidenceRefs([])).toBeNull();
  });

  it('accepts a single valid ref', () => {
    expect(validateEvidenceRefs([validRef])).toBeNull();
  });

  it('rejects non-array input', () => {
    const err = validateEvidenceRefs('not array' as unknown as unknown[]);
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('array');
  });

  it('rejects array exceeding max count (64)', () => {
    const refs = Array.from({ length: 65 }, () => validRef);
    const err = validateEvidenceRefs(refs);
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('64');
  });

  it('accepts exactly max count (64)', () => {
    const refs = Array.from({ length: 64 }, () => validRef);
    expect(validateEvidenceRefs(refs)).toBeNull();
  });

  it('rejects on first invalid ref in array', () => {
    const err = validateEvidenceRefs([validRef, null as unknown as never]);
    expect(err).not.toBeNull();
    expect(err!.reason).toContain('non-null object');
  });
});
