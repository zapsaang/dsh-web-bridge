import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRequest, createRejectionResponse, hasTokenQuery } from '../../src/lib/bridge.js';

for (const target of ['/?token', '/?token=', '/?%74oken=synthetic-secret',
  '/api?to%6ben=x', '/?token=a&token=b', '/?x=1&token=']) {
  for (const method of ['GET', 'POST']) {
    test(`T-U8 rejects token before forwarding ${method} ${target}`, () => {
      // Given: same boundary applies to HTTP and upgrade heads.
      const request = { method, target, rawHeaders: ['Host', 'example.com', 'Upgrade', 'websocket'] };
      let upstreamCalls = 0;
      // When
      const status = classifyRequest(request, ['example.com']);
      if (status === undefined) upstreamCalls++;
      // Then
      assert.equal(hasTokenQuery(target), true);
      assert.equal(status, 400);
      assert.equal(upstreamCalls, 0);
      const response = createRejectionResponse(400);
      assert.equal(response.statusCode, 400);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.body.includes(target), false);
      assert.equal(response.body.includes('synthetic-secret'), false);
    });
  }
}
for (const target of ['/?Token=x', '/?x=token', '/?tokenized=x', '/?%2574oken=x', '/??token=x']) {
  test(`T-U8 case-sensitive parsed key accepts ${target}`, () => {
    // Given / When / Then
    assert.equal(hasTokenQuery(target), false);
    assert.equal(classifyRequest({ method: 'GET', target, rawHeaders: ['Host', 'example.com'] }, ['example.com']), undefined);
  });
}
