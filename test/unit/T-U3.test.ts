import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNavigationEligible } from '../../src/lib/bridge.js';
import type { RequestHead } from '../../src/lib/bridge.js';

const metadata = ['Sec-Fetch-Mode', 'navigate', 'Sec-Fetch-Dest', 'document'];
const cases: readonly (readonly [string, readonly string[], boolean])[] = [
  ['mode/dest only', metadata, true],
  ...['cross-site', 'same-site', 'same-origin', 'none'].map(site =>
    [site, [...metadata, 'Sec-Fetch-Site', site, 'Sec-Fetch-User', '?1'], true] as const),
  ['missing dest', ['Sec-Fetch-Mode', 'navigate'], false],
  ['missing mode', ['Sec-Fetch-Dest', 'document'], false],
  ['site only', ['Sec-Fetch-Site', 'none', 'Accept', 'text/html'], false],
  ['user only', ['Sec-Fetch-User', '?1'], false],
  ['extension only', ['Sec-Fetch-Extra', 'x', 'Accept', 'text/html'], false],
  ['bad mode', ['Sec-Fetch-Mode', 'cors', 'Sec-Fetch-Dest', 'document'], false],
  ['bad dest', ['Sec-Fetch-Mode', 'navigate', 'Sec-Fetch-Dest', 'empty'], false],
  ['bad site', [...metadata, 'Sec-Fetch-Site', 'invalid'], false],
  ['bad user', [...metadata, 'Sec-Fetch-User', '?0'], false],
  ['no accept', [], false], ['duplicate accept', ['Accept', 'text/html', 'accept', 'text/html'], false],
  ...['text/html', 'text/html;q=1', 'text/html;q=0.001', 'application/json, text/html; charset=utf-8',
    'TEXT/HTML;Q=1.000', 'text/html;q=0.5', 'text/html;q=1.', 'text/html;level="1"'].map(value =>
    [value, ['Accept', value], true] as const),
  ...['*/*', 'text/*', 'text/htmlx', 'text/html;q=0', 'text/html;q=0.000',
    'text/html;q=1.001', 'text/html;q=+1', 'text/html;q=.5', 'text/html;q=0.0001',
    'text/html;q=1;q=0.5', 'text/html, text/html;level=1', 'text/html, nonsense',
    'text/html;bad', 'text/html;foo=', 'text/html,', 'text/html;q="1"',
    'text/html;foo="unterminated', 'text/html;foo=a b'].map(value =>
    [value, ['Accept', value], false] as const),
  ...['Mode', 'Dest', 'Site', 'User'].map(name =>
    [`duplicate ${name}`, [...metadata, 'Sec-Fetch-Site', 'none', 'Sec-Fetch-User', '?1',
      `sec-fetch-${name.toLowerCase()}`, 'invalid'], false] as const),
];
for (const [label, rawHeaders, expected] of cases) {
  test(`T-U3 navigation eligibility when ${label}`, () => {
    // Given
    const request = { method: 'GET', target: '/?x=%2f&x=+', rawHeaders };
    const before = structuredClone(request);
    // When
    const result = isNavigationEligible(request, 401);
    // Then
    assert.equal(result, expected);
    assert.deepEqual(request, before);
  });
}
const exclusions: readonly RequestHead[] = [
  ...['/index.html', '/api', '/asset.js', '/%2f', '/./'].map(target => ({ method: 'GET', target, rawHeaders: metadata })),
  ...['POST', 'HEAD', 'OPTIONS', 'get'].map(method => ({ method, target: '/', rawHeaders: metadata })),
  ...[['Upgrade', 'websocket'], ['Upgrade', ''], ['Transfer-Encoding', 'chunked'],
    ['Content-Length', '1'], ['Content-Length', 'garbage'], ['Content-Length', '0', 'content-length', '0']]
    .map(extra => ({ method: 'GET', target: '/', rawHeaders: [...metadata, ...extra] })),
];
for (const request of exclusions) {
  test(`T-U3 excludes non-navigation ${JSON.stringify(request)}`, () => {
    // Given / When / Then
    assert.equal(isNavigationEligible(request, 401), false);
  });
}
test('T-U3 permits zero body when Content-Length is zero', () => {
  // Given / When / Then
  assert.equal(isNavigationEligible({ method: 'GET', target: '/', rawHeaders: [...metadata, 'Content-Length', '0'] }, 401), true);
});
for (const status of [200, 303, 403, 500]) {
  test(`T-U3 excludes upstream ${status}`, () => {
    // Given / When / Then
    assert.equal(isNavigationEligible({ method: 'GET', target: '/', rawHeaders: metadata }, status), false);
  });
}
