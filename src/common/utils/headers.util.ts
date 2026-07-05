/**
 * Extracts a single string value from a Fastify/Node HTTP header.
 * If the header is an array, returns the first element.
 * If the header is absent or empty, returns undefined.
 */
export function getFirstHeader(headerValue: string | string[] | undefined): string | undefined {
  if (typeof headerValue === 'string') {
    return headerValue;
  }
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    return headerValue[0];
  }
  return undefined;
}
