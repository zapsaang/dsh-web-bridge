import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as openUpstream } from 'node:http';
import type { Duplex } from 'node:stream';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import type { ExchangeEndpoint } from './session.js';
import { exchange } from './session.js';
import type { RawHeaders } from './headers.js';
import { filterHopByHopHeaders, rawHeaderValues, rejectConnectionNominations, ConnectionNominationError } from './headers.js';
import { ensureSecure } from './cookie.js';
import { createBootstrapResponse } from './bootstrap.js';

export interface RequestHead {
  readonly method: string;
  readonly target: string;
  readonly rawHeaders: RawHeaders;
}

export interface RejectionResponse {
  readonly statusCode: 400 | 403;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export function isCanonicalAuthority(authority: string): boolean {
  return authority.length > 0 && authority.length <= 253 && isIP(authority) === 0 &&
    authority.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

export function validateAuthorities(authorities: readonly string[]): boolean {
  return authorities.length > 0 && authorities.every(isCanonicalAuthority);
}

export function isOriginFormTarget(target: string): boolean {
  return target.startsWith('/') && !target.startsWith('//') && !/[#\\]/.test(target) &&
    ![...target].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127);
}

function querySegments(target: string): readonly string[] {
  const question = target.indexOf('?');
  return question < 0 ? [] : target.slice(question + 1).split('&');
}

function segmentHasKey(segment: string, key: string): boolean {
  return new URLSearchParams('&' + segment).has(key);
}

export function hasTokenQuery(target: string): boolean {
  return querySegments(target).some(segment => segmentHasKey(segment, 'token'));
}

export function hasRetryMarker(target: string): boolean {
  return querySegments(target).some(segment => segmentHasKey(segment, '__dsh_bridge_retry'));
}

export function stripRetryMarker(target: string): string {
  const segments = querySegments(target);
  const kept = segments.filter(segment => !segmentHasKey(segment, '__dsh_bridge_retry'));
  if (kept.length === segments.length) return target;
  const path = target.slice(0, target.indexOf('?'));
  return kept.length === 0 ? path : path + '?' + kept.join('&');
}

export function classifyRequest(request: RequestHead, authorities: readonly string[]): 400 | 403 | undefined {
  const hosts = rawHeaderValues(request.rawHeaders, 'host');
  const host = hosts[0];
  if (!isOriginFormTarget(request.target) || hosts.length !== 1 || host === undefined ||
    [...host].some(character => character.charCodeAt(0) > 127) ||
    !isCanonicalAuthority(host.toLowerCase()) || hasTokenQuery(request.target)) return 400;
  try {
    rejectConnectionNominations(request.rawHeaders);
  } catch (error) {
    if (error instanceof ConnectionNominationError) return 400;
    throw error;
  }
  return authorities.includes(host.toLowerCase()) ? undefined : 403;
}

const HTTP_TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const MEDIA_RANGE = new RegExp(`^(?:${HTTP_TOKEN})/(?:${HTTP_TOKEN})$`);
const PARAMETER = new RegExp(`^(${HTTP_TOKEN})[ \\t]*=[ \\t]*(${HTTP_TOKEN}|"(?:[\\t\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\t\\x20-\\x7e])*")$`);

function splitHeaderList(value: string, separator: string): readonly string[] | undefined {
  const parts: string[] = [];
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (quoted && character === '\\') escaped = true;
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === separator) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  return quoted || escaped ? undefined : [...parts, value.slice(start).trim()];
}

function acceptsHtml(value: string): boolean {
  if ([...value].some(character => (character.charCodeAt(0) < 32 && character !== '\t') || character.charCodeAt(0) >= 127)) return false;
  const items = splitHeaderList(value, ',');
  if (items === undefined) return false;
  let htmlCount = 0;
  let htmlQuality = 0;
  for (const item of items) {
    const parts = splitHeaderList(item, ';');
    const media = parts?.[0]?.toLowerCase();
    if (parts === undefined || media === undefined || !MEDIA_RANGE.test(media) ||
      (media.startsWith('*/') && media !== '*/*')) return false;
    let quality = 1;
    let qualitySeen = false;
    for (const part of parts.slice(1)) {
      const match = PARAMETER.exec(part);
      if (match === null) return false;
      if (match[1]?.toLowerCase() === 'q') {
        const q = match[2];
        if (qualitySeen || q === undefined || !/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/.test(q)) return false;
        qualitySeen = true;
        quality = Number(q);
      }
    }
    if (media === 'text/html') {
      htmlCount++;
      htmlQuality = quality;
    }
  }
  return htmlCount === 1 && htmlQuality > 0;
}

export function isNavigationEligible(request: RequestHead, upstreamStatus: number): boolean {
  const headers = request.rawHeaders;
  const lengths = rawHeaderValues(headers, 'content-length');
  if (upstreamStatus !== 401 || request.method !== 'GET' || request.target.split('?')[0] !== '/' ||
    rawHeaderValues(headers, 'upgrade').length > 0 || rawHeaderValues(headers, 'transfer-encoding').length > 0 ||
    lengths.length > 1 || (lengths.length === 1 && lengths[0] !== '0')) return false;
  const metadataPresent = headers.some((name, index) => index % 2 === 0 && name.toLowerCase().startsWith('sec-fetch-'));
  if (metadataPresent) {
    const mode = rawHeaderValues(headers, 'sec-fetch-mode');
    const dest = rawHeaderValues(headers, 'sec-fetch-dest');
    const site = rawHeaderValues(headers, 'sec-fetch-site');
    const user = rawHeaderValues(headers, 'sec-fetch-user');
    return mode.length === 1 && mode[0] === 'navigate' && dest.length === 1 && dest[0] === 'document' &&
      site.length <= 1 && (site[0] === undefined || ['cross-site', 'same-site', 'same-origin', 'none'].includes(site[0])) &&
      user.length <= 1 && (user[0] === undefined || user[0] === '?1');
  }
  const accept = rawHeaderValues(headers, 'accept');
  return accept.length === 1 && accept[0] !== undefined && acceptsHtml(accept[0]);
}

export function shouldExchange(request: RequestHead, upstreamStatus: number): boolean {
  return !hasRetryMarker(request.target) && isNavigationEligible(request, upstreamStatus);
}

/** Marked root GET document verification (§5.3): the 401 literal neutralizes the status clause of the navigation predicate. */
function isMarkedRootDocument(head: RequestHead): boolean {
  return hasRetryMarker(head.target) && isNavigationEligible(head, 401);
}

export function createRejectionResponse(statusCode: 400 | 403): RejectionResponse {
  return { statusCode, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
    body: 'Request rejected.\n' };
}

/** Untrusted URL/header/error context is never suitable for diagnostic output. */
export function redactLogContext(_context: unknown): string {
  return '[redacted]';
}

export interface BridgeTimeouts {
  readonly connect: number;
  readonly firstHeader: number;
  readonly upload: number;
  readonly exchange: number;
}

/** §8.3 pinned values; never presented as Cloudflare defaults. */
export const DEFAULT_TIMEOUTS: BridgeTimeouts = {
  connect: 2_000,
  firstHeader: 30_000,
  upload: 300_000,
  exchange: 2_000,
};

export interface BridgeRuntime {
  readonly endpoint: ExchangeEndpoint;
  readonly authorities: readonly string[];
  readonly signal: AbortSignal;
  readonly timeouts?: Partial<BridgeTimeouts>;
}

/** HTTP request entry; streaming, eligibility and response ownership (§5–§8). */
export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: BridgeRuntime,
): Promise<void> {
  const head = requestHead(request);
  const verdict = classifyRequest(head, runtime.authorities);
  if (verdict !== undefined) return deny(request, response, verdict);
  if (rawHeaderValues(head.rawHeaders, 'trailer').length > 0) return deny(request, response, 501);
  if (rawHeaderValues(head.rawHeaders, 'expect').length > 0) return deny(request, response, 417);
  await proxyRequest(request, response, runtime, head);
}

/** Expect: 100-continue entry; validates boundaries before a single 100 (§8.4). */
export async function handleCheckContinue(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: BridgeRuntime,
): Promise<void> {
  const head = requestHead(request);
  const verdict = classifyRequest(head, runtime.authorities);
  if (verdict !== undefined) return deny(request, response, verdict);
  if (rawHeaderValues(head.rawHeaders, 'trailer').length > 0) return deny(request, response, 501);
  response.writeContinue();
  await proxyRequest(request, response, runtime, head);
}

function requestHead(request: IncomingMessage): RequestHead {
  return { method: request.method ?? '', target: request.url ?? '', rawHeaders: request.rawHeaders };
}

function deny(request: IncomingMessage, response: ServerResponse, status: number): void {
  const rejection = status === 400 || status === 403
    ? createRejectionResponse(status)
    : { statusCode: status, headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      body: 'Request rejected.\n' };
  response.writeHead(rejection.statusCode, rejection.headers);
  response.end(rejection.body);
  request.resume();
}

function applyEnsureSecure(headers: RawHeaders): RawHeaders {
  const result: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    const name = headers[index];
    const value = headers[index + 1];
    if (name === undefined || value === undefined) continue;
    result.push(name, name.toLowerCase() === 'set-cookie' ? ensureSecure(value) : value);
  }
  return result;
}

function removeHeader(headers: RawHeaders, name: string): RawHeaders {
  const result: string[] = [];
  for (let index = 0; index < headers.length; index += 2) {
    if (headers[index]?.toLowerCase() !== name) result.push(headers[index] ?? '', headers[index + 1] ?? '');
  }
  return result;
}

function proxyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: BridgeRuntime,
  head: RequestHead,
): Promise<void> {
  return new Promise((resolve) => {
    const timeouts: BridgeTimeouts = { ...DEFAULT_TIMEOUTS, ...runtime.timeouts };
    const outbound = removeHeader(filterHopByHopHeaders(head.rawHeaders), 'expect');
    const timers = new Set<NodeJS.Timeout>();
    const arm = (milliseconds: number, fire: () => void): NodeJS.Timeout => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fire();
      }, milliseconds);
      timers.add(timer);
      return timer;
    };
    const disarm = (timer: NodeJS.Timeout | undefined): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    };

    let committed = false;
    let finished = false;
    let responseArrived = false;
    let connectTimer: NodeJS.Timeout | undefined;
    let uploadTimer: NodeJS.Timeout | undefined;
    let headerTimer: NodeJS.Timeout | undefined;
    let exchangeAbort: AbortController | undefined;

    const upstream = openUpstream({
      host: '127.0.0.1',
      port: runtime.endpoint.port,
      method: head.method,
      path: stripRetryMarker(head.target),
      headers: outbound as string[],
      setHost: false,
      agent: false,
    });

    const settle = (): void => {
      if (settled) return;
      settled = true;
      disarm(connectTimer);
      disarm(uploadTimer);
      disarm(headerTimer);
      runtime.signal.removeEventListener('abort', onAbort);
      resolve();
    };
    let settled = false;

    const abortAll = (): void => {
      exchangeAbort?.abort();
      upstream.destroy();
      if (!response.destroyed) response.destroy();
      request.destroy();
      settle();
    };

    const denyPreCommit = (status: number): void => {
      if (committed) {
        abortAll();
        return;
      }
      exchangeAbort?.abort();
      committed = true;
      const body = 'Request rejected.\n';
      response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      response.end(body);
      upstream.destroy();
      request.destroy();
      settle();
    };

    upstream.on('socket', (socket) => {
      connectTimer = arm(timeouts.connect, () => {
        upstream.destroy(new Error('connect timeout'));
      });
      socket.once('connect', () => disarm(connectTimer));
    });

    uploadTimer = arm(timeouts.upload, () => denyPreCommit(408));

    upstream.on('finish', () => {
      finished = true;
      disarm(uploadTimer);
      if (!responseArrived) {
        headerTimer = arm(timeouts.firstHeader, () => denyPreCommit(504));
      }
    });

    const relayResponse = (upRes: IncomingMessage, status: number, earlyFinal: boolean): void => {
      const noBody = head.method === 'HEAD' || status === 204 || status === 304;
      let headers = applyEnsureSecure(filterHopByHopHeaders(upRes.rawHeaders));
      if (status === 204) headers = removeHeader(headers, 'content-length');
      committed = true;
      response.writeHead(status, headers as string[]);
      if (noBody) {
        upRes.resume();
        upRes.once('end', () => {
          response.end();
          if (earlyFinal) upstream.destroy();
          settle();
        });
        upRes.once('error', abortAll);
        return;
      }
      upRes.pipe(response, { end: false });
      upRes.once('end', () => {
        if (upRes.rawTrailers.length > 0) {
          abortAll();
          return;
        }
        response.end();
        if (earlyFinal) {
          upstream.destroy();
          request.destroy();
        }
        settle();
      });
      upRes.once('error', abortAll);
    };

    // §5.3/§5.7: the eligible 401 stays paused while one isolated exchange runs;
    // success destroys it and commits the bootstrap, failure resumes it untouched.
    const attemptBootstrapExchange = async (upRes: IncomingMessage, earlyFinal: boolean): Promise<void> => {
      const controller = new AbortController();
      exchangeAbort = controller;
      upRes.once('error', () => controller.abort());
      try {
        const result = await exchange({
          endpoint: runtime.endpoint,
          rawAuthority: rawHeaderValues(head.rawHeaders, 'host')[0] ?? '',
          signal: AbortSignal.any([runtime.signal, controller.signal]),
          timeout: timeouts.exchange,
        });
        if (settled) {
          upRes.destroy();
          return;
        }
        if (result.kind === 'success') {
          upRes.destroy();
          committed = true;
          const bootstrap = createBootstrapResponse(result.setCookie);
          response.writeHead(bootstrap.statusCode, bootstrap.headers as Record<string, string>);
          response.end(bootstrap.body);
          upstream.destroy();
          settle();
          return;
        }
        if (result.kind === 'cancelled') {
          upRes.destroy();
          settle();
          return;
        }
        relayResponse(upRes, upRes.statusCode ?? 401, earlyFinal);
      } catch {
        abortAll();
      } finally {
        exchangeAbort = undefined;
      }
    };

    upstream.on('response', (upRes) => {
      responseArrived = true;
      disarm(headerTimer);
      const earlyFinal = !finished;
      if (earlyFinal) {
        disarm(uploadTimer);
        request.unpipe(upstream);
        request.resume();
      }
      if (rawHeaderValues(upRes.rawHeaders, 'trailer').length > 0) {
        upRes.resume();
        denyPreCommit(502);
        return;
      }
      const status = upRes.statusCode ?? 502;
      if (status === 401 && shouldExchange(head, 401)) {
        void attemptBootstrapExchange(upRes, earlyFinal);
        return;
      }
      if (status === 200 && isMarkedRootDocument(head)) {
        upRes.destroy();
        committed = true;
        response.writeHead(303, { location: '/', 'cache-control': 'no-store' });
        response.end();
        if (earlyFinal) upstream.destroy();
        settle();
        return;
      }
      relayResponse(upRes, status, earlyFinal);
    });

    upstream.on('error', () => {
      if (!committed) denyPreCommit(502);
      else abortAll();
    });

    response.on('close', () => {
      if (!response.writableFinished) abortAll();
    });
    request.on('aborted', abortAll);
    const onAbort = (): void => abortAll();
    runtime.signal.addEventListener('abort', onAbort, { once: true });

    request.pipe(upstream);
  });
}

/** Upgrade entry; normalized WS handshake or raw close-delimited denial (§8.5). */
export function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  runtime: BridgeRuntime,
): void {
  const reqHead = requestHead(request);
  const verdict = classifyRequest(reqHead, runtime.authorities);
  if (verdict !== undefined) {
    writeRawDenial(socket, verdict);
    return;
  }
  if (rawHeaderValues(reqHead.rawHeaders, 'trailer').length > 0) {
    writeRawDenial(socket, 501);
    return;
  }
  const failure = validateWebSocketHandshake(reqHead);
  if (failure !== undefined) {
    writeRawDenial(socket, failure);
    return;
  }
  proxyUpgrade(reqHead, socket, head, runtime);
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function splitTokens(values: readonly string[]): readonly string[] {
  return values.flatMap((value) => value.split(',').map((token) => token.trim()).filter(Boolean));
}

function writeRawDenial(socket: Duplex, status: 400 | 403 | 501 | 502 | 504): void {
  const reasons: Record<number, string> = {
    400: 'Bad Request',
    403: 'Forbidden',
    501: 'Not Implemented',
    502: 'Bad Gateway',
    504: 'Gateway Timeout',
  };
  const body = 'Request rejected.\n';
  socket.end(
    `HTTP/1.1 ${status} ${reasons[status]}\r\ncache-control: no-store\r\ncontent-type: text/plain; charset=utf-8\r\nconnection: close\r\ncontent-length: ${body.length}\r\n\r\n${body}`,
    'latin1',
  );
}

function validateWebSocketHandshake(head: RequestHead): 400 | 501 | undefined {
  const upgradeTokens = splitTokens(rawHeaderValues(head.rawHeaders, 'upgrade')).map((token) => token.toLowerCase());
  if (!upgradeTokens.includes('websocket')) return 501;
  if (upgradeTokens.length !== 1) return 400;
  const connectionTokens = splitTokens(rawHeaderValues(head.rawHeaders, 'connection')).map((token) => token.toLowerCase());
  const versions = rawHeaderValues(head.rawHeaders, 'sec-websocket-version');
  const keys = rawHeaderValues(head.rawHeaders, 'sec-websocket-key');
  const lengths = rawHeaderValues(head.rawHeaders, 'content-length');
  const key = keys[0];
  if (
    head.method !== 'GET'
    || !connectionTokens.includes('upgrade')
    || versions.length !== 1
    || versions[0] !== '13'
    || keys.length !== 1
    || key === undefined
    || Buffer.from(key, 'base64').toString('base64') !== key
    || Buffer.from(key, 'base64').length !== 16
    || lengths.some((value) => value !== '0')
    || rawHeaderValues(head.rawHeaders, 'transfer-encoding').length > 0
  ) {
    return 400;
  }
  return undefined;
}

function proxyUpgrade(
  head: RequestHead,
  socket: Duplex,
  headBytes: Buffer,
  runtime: BridgeRuntime,
): void {
  const timeouts: BridgeTimeouts = { ...DEFAULT_TIMEOUTS, ...runtime.timeouts };
  const key = rawHeaderValues(head.rawHeaders, 'sec-websocket-key')[0] ?? '';
  const offeredProtocols = splitTokens(rawHeaderValues(head.rawHeaders, 'sec-websocket-protocol'));
  const requestedExtensions = splitTokens(rawHeaderValues(head.rawHeaders, 'sec-websocket-extensions'))
    .map((extension) => extension.split(';')[0]?.trim() ?? '');

  const outbound: string[] = [...removeHeader(filterHopByHopHeaders(head.rawHeaders), 'expect')];
  outbound.push('Connection', 'Upgrade', 'Upgrade', 'websocket');

  let committed = false;
  let connectTimer: NodeJS.Timeout | undefined;
  let headerTimer: NodeJS.Timeout | undefined;
  const clearTimers = (): void => {
    if (connectTimer !== undefined) clearTimeout(connectTimer);
    if (headerTimer !== undefined) clearTimeout(headerTimer);
  };

  const upstream = openUpstream({
    host: '127.0.0.1',
    port: runtime.endpoint.port,
    method: 'GET',
    path: stripRetryMarker(head.target),
    headers: outbound,
    setHost: false,
    agent: false,
  });

  const failPreCommit = (status: 502 | 504): void => {
    if (committed) return;
    committed = true;
    clearTimers();
    writeRawDenial(socket, status);
    upstream.destroy();
  };

  upstream.on('socket', (upstreamSocket) => {
    connectTimer = setTimeout(() => upstream.destroy(new Error('connect timeout')), timeouts.connect);
    upstreamSocket.once('connect', () => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
    });
  });
  upstream.on('finish', () => {
    if (!committed) headerTimer = setTimeout(() => failPreCommit(504), timeouts.firstHeader);
  });

  upstream.on('upgrade', (upRes, upSocket: Duplex, upHead: Buffer) => {
    clearTimers();
    const accepts = rawHeaderValues(upRes.rawHeaders, 'sec-websocket-accept');
    const protocols = splitTokens(rawHeaderValues(upRes.rawHeaders, 'sec-websocket-protocol'));
    const extensions = splitTokens(rawHeaderValues(upRes.rawHeaders, 'sec-websocket-extensions'));
    const upgradeTokens = splitTokens(rawHeaderValues(upRes.rawHeaders, 'upgrade')).map((token) => token.toLowerCase());
    const connectionTokens = splitTokens(rawHeaderValues(upRes.rawHeaders, 'connection')).map((token) => token.toLowerCase());
    const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
    const valid =
      accepts.length === 1
      && accepts[0] === expected
      && upgradeTokens.includes('websocket')
      && connectionTokens.includes('upgrade')
      && protocols.length <= 1
      && protocols.every((protocol) => offeredProtocols.includes(protocol))
      && extensions.every((extension) => requestedExtensions.includes(extension.split(';')[0]?.trim() ?? ''));
    if (!valid) {
      failPreCommit(502);
      upSocket.destroy();
      return;
    }
    committed = true;
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accepts[0] ?? ''}`,
    ];
    if (protocols[0] !== undefined) lines.push(`Sec-WebSocket-Protocol: ${protocols[0]}`);
    if (extensions.length > 0) lines.push(`Sec-WebSocket-Extensions: ${extensions.join(', ')}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n', 'latin1');
    if (headBytes.length > 0) upSocket.write(headBytes);
    if (upHead.length > 0) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    socket.once('close', () => upSocket.destroy());
    upSocket.once('close', () => socket.destroy());
    socket.once('error', () => upSocket.destroy());
    upSocket.once('error', () => socket.destroy());
  });

  upstream.on('response', (upRes) => {
    clearTimers();
    if (rawHeaderValues(upRes.rawHeaders, 'trailer').length > 0) {
      upRes.resume();
      failPreCommit(502);
      return;
    }
    committed = true;
    const status = upRes.statusCode ?? 502;
    let headers = applyEnsureSecure(filterHopByHopHeaders(upRes.rawHeaders));
    headers = removeHeader(headers, 'content-length');
    const lines = [`HTTP/1.1 ${status} ${upRes.statusMessage ?? ''}`];
    for (let index = 0; index < headers.length; index += 2) {
      lines.push(`${headers[index]}: ${headers[index + 1]}`);
    }
    lines.push('Connection: close');
    socket.write(lines.join('\r\n') + '\r\n\r\n', 'latin1');
    const noBody = status === 204 || status === 304 || head.method === 'HEAD';
    if (noBody) {
      upRes.resume();
      upRes.once('end', () => socket.end());
      upRes.once('error', () => socket.destroy());
      return;
    }
    upRes.on('data', (chunk: Buffer) => {
      if (!socket.write(chunk)) {
        upRes.pause();
        socket.once('drain', () => upRes.resume());
      }
    });
    upRes.once('end', () => {
      if (upRes.rawTrailers.length > 0) socket.destroy();
      else socket.end();
    });
    upRes.once('error', () => {
      socket.destroy();
      upstream.destroy();
    });
  });

  upstream.on('error', () => {
    if (!committed) failPreCommit(502);
    else socket.destroy();
  });
  socket.once('close', () => {
    if (!committed) upstream.destroy();
  });
  runtime.signal.addEventListener('abort', () => {
    upstream.destroy();
    socket.destroy();
  }, { once: true });

  upstream.end();
}
