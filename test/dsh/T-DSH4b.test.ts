import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import { isolated } from './harness.js';

declare module '@deepseek-ai/cordis' {
  interface Context { nativeProbeB: { readonly ready: boolean }; }
}

// Compatibility canary for the ctx.plugin() PromiseLike wrapper. Cordis 4.0.5
// had a defect: restart() on the wrapper wrote lifecycle state onto the wrapper
// while services stayed on the raw fiber, so required consumers reactivated
// before the second async Service.init completed. Cordis 4.1.0 routes
// restart() through ctx.fiber and awaits the raw fiber, so the consumer now
// observes the service only after init settles. This test pins the fixed
// behavior; a regression flips it red.
test('T-DSH4b wrapper restart awaits async Service.init before reactivating required consumers', async () => {
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
    inject: ['nativeProbeB', 'connection', 'webServer'],
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
  // Then: the consumer observed the ready service (fixed in cordis 4.1.0).
  assert.equal(observedReady, true);
});
