import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { callBridge, headerValue, headerValues, makeRuntime, startBridge, startUpstream } from './helpers.js';

const UNAUTHORIZED = 'dsh web authentication required; reopen the URL printed by dsh web.\n';
const VALID_COOKIE =
  'dsh-auth-stub=opaque-payload; Max-Age=2592000; Path=/; Expires=Thu, 07 Oct 2027 00:00:00 GMT; HttpOnly; SameSite=Strict';

const NAV = { host: 'dsh.example.com', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } as const;

interface FailureFixture {
  readonly factory?: () => string;
  readonly exchange?: (response: ServerResponse) => void;
  readonly exchangeDelay?: number;
  readonly exchangeTimeout?: number;
}

async function runFailure(fixture: FailureFixture): Promise<{
  readonly status: number;
  readonly rawHeaders: readonly string[];
  readonly body: Buffer;
  readonly exchangeRequests: number;
  readonly totalRequests: number;
}> {
  const upstream = await startUpstream((request, response) => {
    if ((request.url ?? '').startsWith('/?token=')) {
      const respond = (): void => fixture.exchange?.(response);
      // The bridge may have destroyed the exchange socket before a delayed answer.
      response.on('error', () => undefined);
      if (fixture.exchangeDelay !== undefined) setTimeout(respond, fixture.exchangeDelay);
      else respond();
      return;
    }
    response.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-native-marker': 'native-401',
    });
    response.end(UNAUTHORIZED);
  });
  const runtime = makeRuntime(upstream.port, {
    endpoint: {
      port: upstream.port,
      authenticatedUrl: fixture.factory ?? (() => `http://127.0.0.1:${upstream.port}/?token=stub-token`),
    },
    ...(fixture.exchangeTimeout !== undefined ? { timeouts: { exchange: fixture.exchangeTimeout } } : {}),
  });
  const bridge = await startBridge(runtime);
  try {
    const response = await callBridge(bridge.port, { headers: { ...NAV } });
    return {
      status: response.status,
      rawHeaders: response.rawHeaders,
      body: response.body,
      exchangeRequests: upstream.requests.filter(captured => captured.path.startsWith('/?token=')).length,
      totalRequests: upstream.requests.length,
    };
  } finally {
    await bridge.close();
    await upstream.close();
  }
}

function assertResumedOriginal401(result: { status: number; rawHeaders: readonly string[]; body: Buffer }): void {
  assert.equal(result.status, 401, 'original 401 resumed, not a 502/504/bootstrap');
  assert.equal(result.body.toString('utf8'), UNAUTHORIZED, 'original 401 body bytes preserved');
  assert.equal(headerValue(result.rawHeaders, 'cache-control'), 'no-store');
  assert.equal(headerValue(result.rawHeaders, 'x-native-marker'), 'native-401');
  assert.equal(headerValues(result.rawHeaders, 'set-cookie').length, 0, 'no exchange cookie forwarded on failure');
}

const head = (status: number, fields: Record<string, string>) => (response: ServerResponse): void => {
  response.writeHead(status, fields);
  response.end();
};

describe('T-H3 exchange failure matrix resumes the original 401', () => {
  test('factory throwing fails closed without any exchange request', async () => {
    // Given a URL factory that throws
    const result = await runFailure({
      factory: () => {
        throw new Error('synthetic factory failure');
      },
    });
    // Then the original 401 is resumed and the upstream saw only the navigation
    assertResumedOriginal401(result);
    assert.equal(result.exchangeRequests, 0);
    assert.equal(result.totalRequests, 1);
  });

  test('factory URL without a token fails closed without any exchange request', async () => {
    // Given a factory returning an URL with no token query
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(401, { 'cache-control': 'no-store' });
      response.end(UNAUTHORIZED);
    });
    const runtime = makeRuntime(upstream.port, {
      endpoint: { port: upstream.port, authenticatedUrl: () => `http://127.0.0.1:${upstream.port}/` },
    });
    const bridge = await startBridge(runtime);
    try {
      const response = await callBridge(bridge.port, { headers: { ...NAV } });
      assert.equal(response.status, 401);
      assert.equal(response.body.toString('utf8'), UNAUTHORIZED);
      assert.equal(upstream.requests.length, 1);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  for (const [name, exchange] of [
    ['non-303 status', head(200, { 'set-cookie': VALID_COOKIE })],
    ['Location other than ./', head(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': VALID_COOKIE })],
    ['missing cache-control', head(303, { location: './', 'referrer-policy': 'no-referrer', 'set-cookie': VALID_COOKIE })],
    ['missing referrer-policy', head(303, { location: './', 'cache-control': 'no-store', 'set-cookie': VALID_COOKIE })],
    ['missing Set-Cookie', head(303, { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })],
    ['drifted SameSite attribute', head(303, { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': VALID_COOKIE.replace('SameSite=Strict', 'SameSite=Lax') })],
    ['Domain attribute present', head(303, { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': VALID_COOKIE + '; Domain=dsh.example.com' })],
    ['cookie name without dsh-auth- prefix', head(303, { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': VALID_COOKIE.replace('dsh-auth-stub', 'other-stub') })],
  ] as const) {
    test(`exchange contract violation (${name}) resumes the original 401 and forwards no cookie`, async () => {
      // Given an exchange endpoint violating the §6 response contract
      const result = await runFailure({ exchange });
      // Then the bridge fails closed onto the paused 401
      assertResumedOriginal401(result);
      assert.equal(result.exchangeRequests, 1);
    });
  }

  test('two Set-Cookie fields on the exchange path fail closed', async () => {
    // Given an exchange response with more than one Set-Cookie field
    const result = await runFailure({
      exchange: (response) => {
        response.writeHead(303, [
          'location', './', 'cache-control', 'no-store', 'referrer-policy', 'no-referrer',
          'set-cookie', VALID_COOKIE, 'set-cookie', VALID_COOKIE,
        ]);
        response.end();
      },
    });
    // Then
    assertResumedOriginal401(result);
    assert.equal(result.exchangeRequests, 1);
  });

  test('exchange transport failure (dropped socket) resumes the original 401', async () => {
    // Given an exchange connection that dies before any response
    const result = await runFailure({
      exchange: (response) => response.socket?.destroy(),
    });
    // Then
    assertResumedOriginal401(result);
    assert.equal(result.exchangeRequests, 1);
  });

  test('exchange exceeding the hard total timeout resumes the original 401', async () => {
    // Given an exchange endpoint that answers only after the (test-overridden) deadline
    const result = await runFailure({
      exchange: head(303, { location: './', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': VALID_COOKIE }),
      exchangeDelay: 500,
      exchangeTimeout: 100,
    });
    // Then the deadline wins and the original 401 is resumed
    assertResumedOriginal401(result);
  });

  test('a large paused 401 body survives a slow failed exchange byte-identical', async () => {
    // Given a 401 with a 128 KiB body and an exchange that fails after a short delay
    const large = Buffer.alloc(128 * 1024, 0x61);
    const upstream = await startUpstream((request, response) => {
      if ((request.url ?? '').startsWith('/?token=')) {
        setTimeout(() => {
          response.writeHead(200, { 'content-type': 'text/plain' });
          response.end();
        }, 80);
        return;
      }
      response.writeHead(401, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(large);
    });
    const runtime = makeRuntime(upstream.port, {
      endpoint: { port: upstream.port, authenticatedUrl: () => `http://127.0.0.1:${upstream.port}/?token=stub-token` },
    });
    const bridge = await startBridge(runtime);
    try {
      // When the failed exchange resumes the paused response
      const response = await callBridge(bridge.port, { headers: { ...NAV } });
      // Then every original body byte survived the pause
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, large);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
