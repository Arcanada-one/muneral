/** Extract the comment body string; never forward the raw payload object. */
export function commentBodyFromPayload(payload: unknown): string {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    'body' in payload &&
    typeof (payload as { body: unknown }).body === 'string'
  ) {
    return (payload as { body: string }).body;
  }
  return '';
}
