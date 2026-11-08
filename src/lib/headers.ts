/** Ordered raw fields preserve duplicates and wire values. */
export type RawHeaders = readonly string[];

/** RFC hop-by-hop fields: meaningful for one transport connection only. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'] as const;

/**
 * External-proxy identity credentials. These are cleaned in both directions as
 * defensive sanitation; they are never a condition for trusting a request.
 */
export const SENSITIVE_PROXY_HEADERS = ['cf-access-jwt-assertion'] as const;

const PROTECTED = new Set(['host', 'origin', 'cookie', 'authorization', ...SENSITIVE_PROXY_HEADERS]);

export class ConnectionNominationError extends Error {
  readonly code = 'ERR_CONNECTION_NOMINATION';
  constructor() {
    super('Protected Connection nomination.');
    this.name = 'ConnectionNominationError';
  }
}

export function rawHeaderValues(headers: RawHeaders, name: string): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    const field = headers[index];
    const value = headers[index + 1];
    if (field?.toLowerCase() === name.toLowerCase() && value !== undefined) values.push(value);
  }
  return values;
}

function connectionNominations(headers: RawHeaders): readonly string[] {
  return rawHeaderValues(headers, 'connection').flatMap(value =>
    value.split(',').map(name => name.trim().toLowerCase()));
}

function withoutFields(headers: RawHeaders, removed: ReadonlySet<string>): RawHeaders {
  const result: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    const name = headers[index];
    const value = headers[index + 1];
    if (name !== undefined && value !== undefined && !removed.has(name.toLowerCase())) result.push(name, value);
  }
  return result;
}

/** Reject protected Connection nominations before any filtering (§7.2). */
export function rejectConnectionNominations(headers: RawHeaders): void {
  if (connectionNominations(headers).some(name => PROTECTED.has(name) ||
    name.startsWith('sec-fetch-') || name.startsWith('sec-websocket-'))) {
    throw new ConnectionNominationError();
  }
}

/** Remove static/dynamic hop-by-hop fields (protocol ownership, not credentials). */
export function filterHopByHopHeaders(headers: RawHeaders): RawHeaders {
  return withoutFields(headers, new Set<string>([...HOP_BY_HOP, ...connectionNominations(headers)]));
}

/** Strip external-proxy identity credentials in either direction (defensive sanitation). */
export function stripSensitiveProxyHeaders(headers: RawHeaders): RawHeaders {
  return withoutFields(headers, new Set<string>(SENSITIVE_PROXY_HEADERS));
}

/**
 * Strip Authorization on the request direction only (D2). DSH does not consume
 * the header today; this keeps proxy credentials out of the DSH process. The
 * response direction is deliberately untouched.
 */
export function stripRequestAuthorization(headers: RawHeaders): RawHeaders {
  return withoutFields(headers, new Set(['authorization']));
}
