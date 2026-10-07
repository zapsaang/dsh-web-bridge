import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import { isolated } from './harness.js';

declare module '@deepseek-ai/cordis' {
  interface Context { nativeProbeB: { readonly ready: boolean }; }
}

// Permanent negative record of a confirmed upstream pitfall in
// @deepseek-ai/cordis 4.0.5-alpha.1: ctx.plugin() returns a PromiseLike
// wrapper (registry.ts: wrapped = Object.create(fiber)). Calling restart()
// on the wrapper writes lifecycle state onto the wrapper while services stay
// registered on the raw fiber, whose state wrongly remains ACTIVE; required
// consumers then reactivate before the second async Service.init completes.
// This test pins the defect behavior so a future upstream fix flips it red.
test('T-DSH4b wrapper restart reactivates required consumer before async init completes (known upstream pitfall)', async () => {
  // Given
  await using app = await isolated();
  const gate = Promise.withResolvers<void>();
  let secondInit = false;
  let observedReady: boolean | undefined;
  class DelayedService extends Service {
    ready = false;
    constructor(ctx: Context) { super(ctx, 'nativeProbeB'); }
    async [Service.init](): Promise<void> {
      if (secondInit) await gate.promise;
      this.ready = true;
    }
  }
  app.ctx.plugin({
    inject: ['nativeProbeB', 'connection', 'webServer', 'webRuntime'],
    apply(ctx: Context) { if (secondInit) observedReady = ctx.nativeProbeB.ready; },
  });
  const wrapper = app.ctx.plugin(DelayedService);
  await wrapper;
  // When: restart through the unresolved PromiseLike wrapper.
  secondInit = true;
  const restarted = wrapper.restart();
  await new Promise(resolve => setImmediate(resolve));
  gate.resolve();
  await restarted;
  // Then: the consumer observed the not-ready service (defect behavior).
  assert.equal(observedReady, false);
});
