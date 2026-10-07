// Focused runner (browser tests stay out of the default runner, like test/dsh):
//   corepack pnpm exec tsc -p tsconfig.test.json --outDir .test-dist-browser && node --test .test-dist-browser/test/browser/*.test.js
import { once } from 'node:events';
import { createServer, request as relay, type OutgoingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { makeRuntime, startBridge, startUpstream, headerValue, type Bridge, type Upstream } from '../http/helpers.js';

export const AUTHORITY = 'dsh.example.test';
export const OTHER_AUTHORITY = 'other.example.test';
export const UNAUTHORIZED = 'dsh web authentication required; reopen the URL printed by dsh web.\n';
export const NATIVE_COOKIE =
  'dsh-auth-stub=opaque-payload; Max-Age=2592000; Path=/; Expires=Thu, 07 Oct 2027 00:00:00 GMT; HttpOnly; SameSite=Strict';
export const GUI_HTML =
  '<html><head><title>DSH GUI</title></head><body><h1>DSH GUI loaded</h1><script src="/gui.js"></script></body></html>';

export interface DshStub extends Upstream {
  readonly browserRequests: () => number;
  readonly exchangeRequests: () => number;
  readonly cookieArrived: (path: string) => boolean;
}

/** Minimal native-DSH semantics: 401 root without cookie, §6 exchange, 200 GUI with cookie (§2.6, T-DSH layer pins the real thing). */
export async function startDshStub(options?: { readonly always401?: boolean }): Promise<DshStub> {
  const upstream = await startUpstream((request, response) => {
    const url = request.url ?? '';
    if (url.startsWith('/?token=')) {
      response.writeHead(303, [
        'location', './', 'cache-control', 'no-store', 'referrer-policy', 'no-referrer', 'set-cookie', NATIVE_COOKIE,
      ]);
      response.end();
      return;
    }
    if (url === '/gui.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end('window.guiAssetLoaded = true;');
      return;
    }
    const authed = (headerValue(request.rawHeaders, 'cookie') ?? '').includes('dsh-auth-stub=opaque-payload');
    if (!options?.always401 && authed && url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(GUI_HTML);
      return;
    }
    response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    response.end(UNAUTHORIZED);
  });
  return {
    ...upstream,
    browserRequests: () => upstream.requests.filter(captured => !captured.path.startsWith('/?token=')).length,
    exchangeRequests: () => upstream.requests.filter(captured => captured.path.startsWith('/?token=')).length,
    cookieArrived: (path) => upstream.requests.some(captured =>
      captured.path === path && headerValue(captured.rawHeaders, 'cookie') !== undefined),
  };
}

export interface AccessStub {
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * Local stand-in for cloudflared+Access (§14.5: not production evidence): forwards
 * to the bridge with the synthetic JWT header injected; serves the cross-site page.
 */
export async function startAccessStub(bridgePort: number): Promise<AccessStub> {
  const server = createServer((incoming, outgoing) => {
    if (incoming.headers.host === OTHER_AUTHORITY) {
      outgoing.writeHead(200, { 'content-type': 'text/html' });
      outgoing.end(`<html><body><a id="go" href="http://${AUTHORITY}/">continue to DSH</a></body></html>`);
      return;
    }
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers[name] = value;
    }
    headers['cf-access-jwt-assertion'] = 'synthetic-stub-jwt';
    const forward = relay({
      host: '127.0.0.1',
      port: bridgePort,
      method: incoming.method,
      path: incoming.url,
      headers,
      setHost: false,
    });
    forward.on('response', (bridgeResponse) => {
      outgoing.writeHead(bridgeResponse.statusCode ?? 502, bridgeResponse.rawHeaders as string[]);
      bridgeResponse.pipe(outgoing);
    });
    forward.on('error', () => {
      outgoing.destroy();
    });
    incoming.pipe(forward);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: async () => {
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
}

// Full chromium honors --unsafely-treat-insecure-origin-as-secure (headless shell
// ignores it); first-match-wins: both example hosts map to the Access stub with a
// port-less Host header, every other name resolves NOTFOUND (offline guarantee).
export async function launchBrowser(accessPort: number): Promise<Browser> {
  return chromium.launch({
    channel: 'chromium',
    args: [
      `--host-resolver-rules=MAP ${AUTHORITY} 127.0.0.1:${accessPort}, ` +
      `MAP ${OTHER_AUTHORITY} 127.0.0.1:${accessPort}, MAP * ~NOTFOUND`,
      `--unsafely-treat-insecure-origin-as-secure=http://${AUTHORITY},http://${OTHER_AUTHORITY}`,
    ],
  });
}

export interface BrowserFixture {
  readonly upstream: DshStub;
  readonly bridge: Bridge;
  readonly access: AccessStub;
  readonly browser: Browser;
  readonly newPage: () => Promise<{ page: Page; context: BrowserContext }>;
  readonly close: () => Promise<void>;
}

export async function startFixture(options?: { readonly always401?: boolean }): Promise<BrowserFixture> {
  const upstream = await startDshStub(options);
  const bridge = await startBridge(makeRuntime(upstream.port, {
    authorities: [AUTHORITY],
    endpoint: { port: upstream.port, authenticatedUrl: () => `http://127.0.0.1:${upstream.port}/?token=stub-token` },
  }));
  const access = await startAccessStub(bridge.port);
  const browser = await launchBrowser(access.port);
  return {
    upstream,
    bridge,
    access,
    browser,
    newPage: async () => {
      const context = await browser.newContext();
      return { page: await context.newPage(), context };
    },
    close: async () => {
      await browser.close();
      await access.close();
      await bridge.close();
      await upstream.close();
    },
  };
}
