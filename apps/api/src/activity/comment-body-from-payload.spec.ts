/**
 * MUN-0078 — pure projection helper: comment body only, never raw payload.
 */
import { commentBodyFromPayload } from './comment-body.js';

describe('commentBodyFromPayload (MUN-0078)', () => {
  it('returns the string body from a comment payload', () => {
    expect(commentBodyFromPayload({ body: 'hello' })).toBe('hello');
  });

  it('returns empty string for missing or non-string body', () => {
    expect(commentBodyFromPayload(null)).toBe('');
    expect(commentBodyFromPayload(undefined)).toBe('');
    expect(commentBodyFromPayload({})).toBe('');
    expect(commentBodyFromPayload({ body: 12 })).toBe('');
    expect(commentBodyFromPayload(['body'])).toBe('');
  });

  it('does not surface extra payload keys as the body', () => {
    expect(commentBodyFromPayload({ body: 'ok', secret: 'x' })).toBe('ok');
  });
});
