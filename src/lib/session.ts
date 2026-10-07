import { request as openExchange } from 'node:http';
import { validateExchangeSetCookie } from './cookie.js';
import { rawHeaderValues } from './headers.js';

/** §8.3 pinned exchange budget; hard TOTAL deadline from before the URL factory call (§6). */
export const EXCHANGE_TIMEOUT = 2_000;

export interface ExchangeEndpoint {
  readonly port: number;
  readonly authenticatedUrl: (baseUrl: string) => string;
}

export type ExchangeFailureCode = 'factory' | 'status' | 'cookie' | 'transport' | 'timeout';

export type ExchangeResult =
  | { readonly kind: 'success'; readonly setCookie: string }
  | { readonly kind: 'failure'; readonly code: ExchangeFailureCode }
  | { readonly kind: 'cancelled' };

export interface ExchangeInput {
  readonly endpoint: ExchangeEndpoint;
  /** Browser Host wire value, forwarded untouched (§6.2, I5). */
  readonly rawAuthority: string;
  readonly signal: AbortSignal;
  readonly timeout?: number;
}

/**
 * One isolated internal token exchange (§6): a fresh process-token URL from the
 * factory, a single `GET /?token=<t>` over an `agent:false` loopback connection
 * carrying only the browser's raw Host, and strict §6 response validation. The
 * token never enters logs or error details: failures are fixed codes only.
 */
export function exchange(input: ExchangeInput): Promise<ExchangeResult> {
  if (input.signal.aborted) return Promise.resolve({ kind: 'cancelled' });
  const deadline = AbortSignal.timeout(input.timeout ?? EXCHANGE_TIMEOUT);
  const combined = AbortSignal.any([input.signal, deadline]);
  let path: string;
  try {
    const url = new URL(input.endpoint.authenticatedUrl(`http://127.0.0.1:${input.endpoint.port}/`));
    const token = url.searchParams.get('token');
    if (token === null) return Promise.resolve({ kind: 'failure', code: 'factory' });
    path = `/?token=${encodeURIComponent(token)}`;
  } catch {
    return Promise.resolve({ kind: 'failure', code: 'factory' });
  }
  return new Promise<ExchangeResult>((resolve) => {
    let settled = false;
    const settle = (result: ExchangeResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const request = openExchange({
      host: '127.0.0.1',
      port: input.endpoint.port,
      method: 'GET',
      path,
      headers: { Host: input.rawAuthority },
      setHost: false,
      agent: false,
      signal: combined,
    });
    request.on('response', (exchangeResponse) => {
      const locations = rawHeaderValues(exchangeResponse.rawHeaders, 'location');
      const cacheControls = rawHeaderValues(exchangeResponse.rawHeaders, 'cache-control');
      const referrerPolicies = rawHeaderValues(exchangeResponse.rawHeaders, 'referrer-policy');
      const setCookie = validateExchangeSetCookie(exchangeResponse.rawHeaders);
      exchangeResponse.destroy();
      const headValid = exchangeResponse.statusCode === 303 &&
        locations.length === 1 && locations[0] === './' &&
        cacheControls.length === 1 && cacheControls[0] === 'no-store' &&
        referrerPolicies.length === 1 && referrerPolicies[0] === 'no-referrer';
      if (!headValid) {
        settle({ kind: 'failure', code: 'status' });
      } else if (setCookie === undefined) {
        settle({ kind: 'failure', code: 'cookie' });
      } else {
        settle({ kind: 'success', setCookie });
      }
    });
    request.on('error', () => {
      if (input.signal.aborted) settle({ kind: 'cancelled' });
      else if (deadline.aborted) settle({ kind: 'failure', code: 'timeout' });
      else settle({ kind: 'failure', code: 'transport' });
    });
    request.end();
  });
}
