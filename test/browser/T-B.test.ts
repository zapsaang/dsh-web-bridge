import assert from 'node:assert/strict';
import { get } from 'node:http';
import { test } from 'node:test';
import {
  AUTHORITY, GUI_HTML, OTHER_AUTHORITY, UNAUTHORIZED, startFixture, type BrowserFixture,
} from './helpers.js';

const TIMEOUT = 60_000;
const guiLoaded = () => Boolean((window as unknown as { guiAssetLoaded?: boolean }).guiAssetLoaded);

const documentRequests = (fixture: BrowserFixture): number =>
  fixture.upstream.requests.filter(captured => captured.path === '/').length;

async function withFixture(
  options: { readonly always401?: boolean } | undefined,
  run: (fixture: BrowserFixture) => Promise<void>,
): Promise<void> {
  const fixture = await startFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

test('T-B1: same-site navigation bootstraps, stores cookie, loads GUI', { timeout: TIMEOUT }, async () => {
  await withFixture(undefined, async (fixture) => {
    const { page, context } = await fixture.newPage();

    await page.goto(`http://${AUTHORITY}/`);
    await page.waitForFunction(guiLoaded, undefined, { timeout: 15_000 });

    assert.match(await page.textContent('body') ?? '', /DSH GUI loaded/);
    assert.equal(page.url(), `http://${AUTHORITY}/`);
    assert.equal(fixture.upstream.exchangeRequests(), 1);
    assert.equal(fixture.upstream.cookieArrived('/'), true);

    // URL-filtered cookies() drops Secure cookies for insecure-scheme filter URLs
    // even under --unsafely-treat-insecure-origin-as-secure; query the full jar.
    const cookies = await context.cookies();
    const session = cookies.find(cookie => cookie.name === 'dsh-auth-stub');
    assert.ok(session, 'exchange cookie must be stored by the browser');
    assert.equal(session.value, 'opaque-payload');
    assert.equal(session.secure, true);
    assert.equal(session.httpOnly, true);
    assert.equal(session.sameSite, 'Strict');
    assert.equal(session.path, '/');

    await context.close();
  });
});

test('T-B2: cross-site top-level navigation completes bootstrap via SameSite=Strict retry', { timeout: TIMEOUT }, async () => {
  await withFixture(undefined, async (fixture) => {
    const { page, context } = await fixture.newPage();

    await page.goto(`http://${OTHER_AUTHORITY}/`);
    await page.click('#go');
    await page.waitForFunction(guiLoaded, undefined, { timeout: 15_000 });

    assert.match(await page.textContent('body') ?? '', /DSH GUI loaded/);
    assert.equal(page.url(), `http://${AUTHORITY}/`);
    assert.equal(fixture.upstream.exchangeRequests(), 1);

    const first = fixture.upstream.requests.find(captured => captured.path === '/');
    assert.ok(first, 'initial document request must exist');
    assert.equal(first.rawHeaders.some((value, index) =>
      index % 2 === 0 && value.toLowerCase() === 'cookie'), false,
    'first cross-site arrival must carry no cookie');
    assert.equal(fixture.upstream.cookieArrived('/'), true,
      'Strict cookie must ride the same-site marker retry / clean retry');

    await context.close();
  });
});

test('T-B3a: cookie-rejected cycle bound is 2 document requests / 1 exchange', { timeout: TIMEOUT }, async () => {
  await withFixture({ always401: true }, async (fixture) => {
    const { page, context } = await fixture.newPage();
    let navigations = 0;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) navigations += 1;
    });

    await page.goto(`http://${AUTHORITY}/`);
    await page.waitForSelector('text=authentication required', { timeout: 15_000 });

    assert.equal(documentRequests(fixture), 2);
    assert.equal(fixture.upstream.exchangeRequests(), 1);
    assert.match(page.url(), /__dsh_bridge_retry=1/);

    const settledNavigations = navigations;
    const settledRequests = documentRequests(fixture);
    await page.waitForTimeout(800);
    assert.equal(navigations, settledNavigations, 'no redirect loop after terminal 401');
    assert.equal(documentRequests(fixture), settledRequests);

    await context.close();
  });
});

test('T-B3b: stable-cookie cycle bound is 3 document requests / 1 exchange', { timeout: TIMEOUT }, async () => {
  await withFixture(undefined, async (fixture) => {
    const { page, context } = await fixture.newPage();

    await page.goto(`http://${AUTHORITY}/`);
    await page.waitForFunction(guiLoaded, undefined, { timeout: 15_000 });

    assert.equal(documentRequests(fixture), 3);
    assert.equal(fixture.upstream.exchangeRequests(), 1);

    await context.close();
  });
});

test('T-B4: CSP-blocked inline script leaves secret-free manual fallback without loop', { timeout: TIMEOUT }, async () => {
  await withFixture(undefined, async (fixture) => {
    const { page, context } = await fixture.newPage();
    // route.fetch resolves names in the Node process (no resolver rules), so fetch
    // the Access stub by loopback address, forwarding the browser's own headers
    // (navigation eligibility needs Accept / Fetch Metadata to pass through).
    await page.route('**/*', async (route) => {
      if (route.request().method() !== 'GET') return route.abort();
      const url = new URL(route.request().url());
      const fetched = await new Promise<{ status: number; rawHeaders: string[]; body: Buffer }>(
        (resolve, reject) => {
          const request = get({
            host: '127.0.0.1', port: fixture.access.port, path: url.pathname + url.search,
            headers: { ...route.request().headers(), host: url.host },
          }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
              status: response.statusCode ?? 0,
              rawHeaders: response.rawHeaders,
              body: Buffer.concat(chunks),
            }));
          });
          request.on('error', reject);
        });
      const headers: Record<string, string> = {};
      for (let index = 0; index + 1 < fetched.rawHeaders.length; index += 2) {
        const name = fetched.rawHeaders[index];
        const value = fetched.rawHeaders[index + 1];
        if (name !== undefined && value !== undefined) headers[name.toLowerCase()] = value;
      }
      delete headers['transfer-encoding'];
      delete headers['content-length'];
      headers['content-security-policy'] = "script-src 'none'";
      await route.fulfill({ status: fetched.status, headers, body: fetched.body });
    });

    await page.goto(`http://${AUTHORITY}/`);
    await page.waitForSelector('text=Session restoration is in progress', { timeout: 15_000 });

    const manual = page.locator('a[href="/"]');
    assert.equal(await manual.textContent(), 'continue to DSH Web');
    assert.equal(await page.locator('meta[http-equiv="refresh" i]').count(), 0);
    assert.equal(page.url(), `http://${AUTHORITY}/`);
    assert.equal(await page.evaluate(guiLoaded), false, 'inline script must stay blocked');

    await page.waitForTimeout(1_000);
    assert.equal(page.url(), `http://${AUTHORITY}/`, 'no meta-refresh or script loop');
    assert.equal(documentRequests(fixture), 1);
    assert.equal(fixture.upstream.exchangeRequests(), 1);

    await context.close();
  });
});

test('T-B5: marker root with rejected cookie terminates at 401 without exchange or loop', { timeout: TIMEOUT }, async () => {
  await withFixture({ always401: true }, async (fixture) => {
    const { page, context } = await fixture.newPage();

    const response = await page.goto(`http://${AUTHORITY}/?__dsh_bridge_retry=1`);
    assert.equal(response?.status(), 401);
    assert.match(await page.textContent('body') ?? '', /authentication required/);

    assert.equal(fixture.upstream.exchangeRequests(), 0, 'marker must suppress exchange');
    assert.equal(documentRequests(fixture), 1);

    await page.waitForTimeout(800);
    assert.match(page.url(), /__dsh_bridge_retry=1/, 'terminal 401 must not auto-redirect');
    assert.equal(documentRequests(fixture), 1);

    await context.close();
  });
});

// R5 native direct channel asserted against the stub's native semantics; the T-DSH
// layer pins the same contract against a real DSH instance.
test('T-B6: native direct access bypasses bridge (cookie 200 / no cookie 401)', { timeout: TIMEOUT }, async () => {
  await withFixture(undefined, async (fixture) => {
    const direct = (cookie?: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const request = get({
          host: '127.0.0.1', port: fixture.upstream.port, path: '/',
          headers: cookie ? { cookie } : {},
        }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve({
            status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'),
          }));
        });
        request.on('error', reject);
      });

    const authed = await direct('dsh-auth-stub=opaque-payload');
    assert.equal(authed.status, 200);
    assert.equal(authed.body, GUI_HTML);

    const anonymous = await direct();
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body, UNAUTHORIZED);
  });
});
