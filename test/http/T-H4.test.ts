import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { connect } from 'node:net';
import { BOOTSTRAP_HTML } from '../../src/lib/bootstrap.js';
import { callBridge, headerValue, headerValues, makeRuntime, startBridge, startUpstream } from './helpers.js';

const NATIVE_COOKIE =
  'dsh-auth-stub=opaque-payload; Max-Age=2592000; Path=/; Expires=Thu, 07 Oct 2027 00:00:00 GMT; HttpOnly; SameSite=Strict';
const NAV = { host: 'dsh.example.com', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } as const;

function exchangeOk(port: number): { port: number; authenticatedUrl: () => string } {
  return { port, authenticatedUrl: () => `http://127.0.0.1:${port}/?token=stub-token` };
}

describe('T-H4 response ownership of paused 401 and marked verification 200', () => {
  test('exchange success destroys the paused 401 instead of draining or relaying it', { timeout: 10_000 }, async () => {
    // Given a 401 whose body never ends, so only a destroy lets the exchange win promptly
    let original401Closed = false;
    const upstream = await startUpstream((request, response) => {
      if ((request.url ?? '').startsWith('/?token=')) {
        response.writeHead(303, [
          'location', './', 'cache-control', 'no-store', 'referrer-policy', 'no-referrer', 'set-cookie', NATIVE_COOKIE,
        ]);
        response.end();
        return;
      }
      response.on('close', () => {
        original401Closed = true;
      });
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.write('partial-401-body');
      // intentionally never ends
    });
    const bridge = await startBridge(makeRuntime(upstream.port, { endpoint: exchangeOk(upstream.port) }));
    try {
      // When an eligible navigation triggers a successful exchange
      const response = await callBridge(bridge.port, { headers: { ...NAV } });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      // Then the browser gets the bootstrap and the paused 401 was destroyed, not drained
      assert.equal(response.status, 200);
      assert.equal(response.body.toString('utf8'), BOOTSTRAP_HTML);
      assert.equal(original401Closed, true, 'never-ending 401 was destroyed');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('client abort during the exchange destroys both the exchange and the paused 401', { timeout: 10_000 }, async () => {
    // Given a paused 401 and an exchange that would answer too late
    let original401Closed = false;
    let exchangeClosed = false;
    let exchangeFinished = false;
    const upstream = await startUpstream((request, response) => {
      if ((request.url ?? '').startsWith('/?token=')) {
        response.on('error', () => undefined);
        response.on('close', () => {
          exchangeClosed = true;
        });
        response.on('finish', () => {
          exchangeFinished = true;
        });
        setTimeout(() => {
          response.writeHead(303, [
            'location', './', 'cache-control', 'no-store', 'referrer-policy', 'no-referrer', 'set-cookie', NATIVE_COOKIE,
          ]);
          response.end();
        }, 300);
        return;
      }
      response.on('close', () => {
        original401Closed = true;
      });
      response.writeHead(401, { 'cache-control': 'no-store' });
      response.write('partial-401-body');
      // intentionally never ends
    });
    const bridge = await startBridge(makeRuntime(upstream.port, { endpoint: exchangeOk(upstream.port) }));
    try {
      // When the client aborts while the exchange is still in flight
      const socket = connect({ host: '127.0.0.1', port: bridge.port });
      await new Promise<void>((resolve) => {
        socket.on('connect', () => {
          socket.write(
            'GET / HTTP/1.1\r\nHost: dsh.example.com\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n\r\n',
            () => resolve(),
          );
        });
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      socket.destroy();
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      // Then the exchange was cancelled before its delayed answer could complete
      assert.equal(exchangeFinished, false, 'exchange response never completed on the wire');
      assert.equal(exchangeClosed, true, 'exchange connection destroyed');
      assert.equal(original401Closed, true, 'paused 401 destroyed on cancel');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('bootstrap response inherits neither Content-Length/Content-Encoding nor any native 401 header', async () => {
    // Given a 401 dressed up with encoding, length, a native marker and a foreign cookie
    const upstream = await startUpstream((request, response) => {
      if ((request.url ?? '').startsWith('/?token=')) {
        response.writeHead(303, [
          'location', './', 'cache-control', 'no-store', 'referrer-policy', 'no-referrer', 'set-cookie', NATIVE_COOKIE,
        ]);
        response.end();
        return;
      }
      response.writeHead(401, [
        'content-type', 'text/plain; charset=utf-8',
        'content-encoding', 'gzip',
        'cache-control', 'no-store',
        'x-native-401', 'native',
        'set-cookie', 'foreign=untouched',
      ]);
      response.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
    });
    const bridge = await startBridge(makeRuntime(upstream.port, { endpoint: exchangeOk(upstream.port) }));
    try {
      // When the exchange succeeds
      const response = await callBridge(bridge.port, { headers: { ...NAV } });
      // Then the bootstrap carries only its own fixed headers plus the exchange cookie
      assert.equal(response.status, 200);
      assert.equal(headerValue(response.rawHeaders, 'content-encoding'), undefined);
      assert.equal(headerValue(response.rawHeaders, 'x-native-401'), undefined);
      assert.deepEqual(headerValues(response.rawHeaders, 'set-cookie'), [NATIVE_COOKIE + '; Secure']);
      assert.equal(response.body.toString('utf8'), BOOTSTRAP_HTML);
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });

  test('marked root document 200 is destroyed not drained; bridge answers fixed 303 / no-store', { timeout: 10_000 }, async () => {
    // Given a verification 200 with a never-ending gzip-encoded body and native cookies
    let verificationClosed = false;
    const upstream = await startUpstream((request, response) => {
      if ((request.url ?? '').startsWith('/?token=')) {
        response.writeHead(500);
        response.end();
        return;
      }
      response.on('close', () => {
        verificationClosed = true;
      });
      response.writeHead(200, [
        'content-type', 'text/html; charset=utf-8',
        'content-encoding', 'gzip',
        'set-cookie', 'dsh-auth-native=opaque; Path=/; HttpOnly',
      ]);
      response.write('partial-index-body');
      // intentionally never ends
    });
    const bridge = await startBridge(makeRuntime(upstream.port, { endpoint: exchangeOk(upstream.port) }));
    try {
      // When a marked root document navigation is accepted by the upstream
      const response = await callBridge(bridge.port, {
        path: '/?__dsh_bridge_retry=1',
        headers: { ...NAV, cookie: 'dsh-auth-native=opaque' },
      });
      // Then the bridge emits only the fixed 303 and destroys the verification body
      assert.equal(response.status, 303);
      assert.equal(headerValue(response.rawHeaders, 'location'), '/');
      assert.equal(headerValue(response.rawHeaders, 'cache-control'), 'no-store');
      assert.equal(response.body.length, 0);
      assert.equal(headerValues(response.rawHeaders, 'set-cookie').length, 0, 'native verification cookie not inherited');
      assert.equal(headerValue(response.rawHeaders, 'content-encoding'), undefined);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      assert.equal(verificationClosed, true, 'never-ending verification body destroyed, not drained');
    } finally {
      await bridge.close();
      await upstream.close();
    }
  });
});
