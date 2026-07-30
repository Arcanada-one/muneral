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

  it('accepts an ordinary null-prototype record', () => {
    const ref = Object.assign(Object.create(null), validRef);
    expect(validateEvidenceRef(ref)).toBeNull();
  });

  it('rejects unknown fields with a typed validation error', () => {
    const err = validateEvidenceRef({
      ...validRef,
      extra: 'not part of EvidenceRef',
    });
    expect(err?.code).toBe('INVALID_EVIDENCE_REF');
    expect(err?.reason).toBe('evidence reference contains unknown fields');
    expect(err?.reason).not.toContain('extra');
  });

  it('rejects a pathological payload hidden in an unknown field', () => {
    const err = validateEvidenceRef({
      ...validRef,
      extra: 'x'.repeat(1_000_000),
    });
    expect(err?.code).toBe('INVALID_EVIDENCE_REF');
    expect(err?.reason).toBe('evidence reference contains unknown fields');
    expect(err?.reason).not.toContain('x'.repeat(100));
  });

  it('keeps diagnostics bounded for a pathological unknown field name', () => {
    const attackerKey = 'x'.repeat(100_000);
    const err = validateEvidenceRef({
      ...validRef,
      [attackerKey]: true,
    });

    expect(err?.code).toBe('INVALID_EVIDENCE_REF');
    expect(err?.reason).toBe('evidence reference contains unknown fields');
    expect(err!.reason.length).toBeLessThanOrEqual(128);
    expect(err!.message.length).toBeLessThanOrEqual(192);
    expect(err!.message).not.toContain(attackerKey.slice(0, 100));
  });

  it('rejects a non-enumerable required field', () => {
    const ref = {
      digest: validRef.digest,
      contentType: validRef.contentType,
    };
    Object.defineProperty(ref, 'uri', {
      value: validRef.uri,
      enumerable: false,
      configurable: true,
    });

    const err = validateEvidenceRef(ref);
    expect(err?.code).toBe('INVALID_EVIDENCE_REF');
    expect(err?.reason).toBe(
      'evidence reference fields must be own enumerable data properties',
    );
  });

  it('rejects a non-enumerable optional field', () => {
    const ref = { ...validRef };
    Object.defineProperty(ref, 'label', {
      value: 'hidden label',
      enumerable: false,
      configurable: true,
    });

    const err = validateEvidenceRef(ref);
    expect(err?.code).toBe('INVALID_EVIDENCE_REF');
    expect(err?.reason).toBe(
      'evidence reference fields must be own enumerable data properties',
    );
  });

  it('rejects an accessor without invoking it', () => {
    let getterHits = 0;
    const ref = {
      digest: validRef.digest,
      contentType: validRef.contentType,
      get uri() {
        getterHits += 1;
        return validRef.uri;
      },
    };

    const err = validateEvidenceRef(ref);
    expect(err?.code).toBe('INVALID_EVIDENCE_REF');
    expect(err?.reason).toBe(
      'evidence reference fields must be own enumerable data properties',
    );
    expect(getterHits).toBe(0);
  });

  it('rejects class instances', () => {
    class EvidenceFixture {
      uri = validRef.uri;
      digest = validRef.digest;
      contentType = validRef.contentType;
    }

    const err = validateEvidenceRef(new EvidenceFixture());
    expect(err?.code).toBe('INVALID_EVIDENCE_REF');
    expect(err?.reason).toBe('evidence reference must be a plain object');
  });

  it('rejects inherited required fields under Object.prototype pollution', () => {
    const fieldNames = ['uri', 'digest', 'contentType'] as const;
    const previous = new Map(
      fieldNames.map((field) => [
        field,
        Object.getOwnPropertyDescriptor(Object.prototype, field),
      ]),
    );

    try {
      Object.defineProperties(Object.prototype, {
        uri: {
          value: validRef.uri,
          enumerable: true,
          configurable: true,
        },
        digest: {
          value: validRef.digest,
          enumerable: true,
          configurable: true,
        },
        contentType: {
          value: validRef.contentType,
          enumerable: true,
          configurable: true,
        },
      });

      const err = validateEvidenceRef({});
      expect(err?.code).toBe('INVALID_EVIDENCE_REF');
      expect(err?.reason).toBe(
        'evidence reference fields must be own enumerable data properties',
      );
    } finally {
      for (const field of fieldNames) {
        const descriptor = previous.get(field);
        if (descriptor) {
          Object.defineProperty(Object.prototype, field, descriptor);
        } else {
          delete (Object.prototype as Record<string, unknown>)[field];
        }
      }
    }
  });

  it('rejects symbol-keyed fields', () => {
    const err = validateEvidenceRef({
      ...validRef,
      [Symbol('extra')]: true,
    });
    expect(err?.code).toBe('INVALID_EVIDENCE_REF');
    expect(err?.reason).toBe('evidence reference contains unknown fields');
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
