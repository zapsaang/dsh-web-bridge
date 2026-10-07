/** Ordered raw fields preserve duplicates and wire values. */
export type RawHeaders = readonly string[];

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'cf-access-jwt-assertion'] as const;
const PROTECTED = new Set(['host', 'origin', 'cookie', 'authorization', 'cf-access-jwt-assertion']);

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

/** Reject protected Connection nominations before any filtering (§7.2). */
export function rejectConnectionNominations(headers: RawHeaders): void {
  if (connectionNominations(headers).some(name => PROTECTED.has(name) ||
    name.startsWith('sec-fetch-') || name.startsWith('sec-websocket-'))) {
    throw new ConnectionNominationError();
  }
}

/** Remove static/dynamic hop-by-hop fields and Access JWT in both directions. */
export function filterHopByHopHeaders(headers: RawHeaders): RawHeaders {
  const removed = new Set<string>([...HOP_BY_HOP, ...connectionNominations(headers)]);
  const result: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    const name = headers[index];
    const value = headers[index + 1];
    if (name !== undefined && value !== undefined && !removed.has(name.toLowerCase())) result.push(name, value);
  }
  return result;
}
