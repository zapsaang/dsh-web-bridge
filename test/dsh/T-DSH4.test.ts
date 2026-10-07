import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context, Service } from '@deepseek-ai/cordis';
import { isolated } from './harness.js';

declare module '@deepseek-ai/cordis' {
  interface Context { nativeProbe: { readonly ready: boolean }; }
}

// §2.8: reflect.ts 237-241 and fiber.ts 646-700 own activation.
// Raw-fiber path only: awaiting ctx.plugin() yields the raw Fiber; lifecycle
// calls must target it (see T-DSH4b for the wrapper-object pitfall).
test('T-DSH4 waits for async Service.init and reloads/disposes required consumers exactly once', async () => {
  // Given
  await using app = await isolated();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const events: string[] = [];
  class DelayedService extends Service {
    ready = false;
    constructor(ctx: Context) { super(ctx, 'nativeProbe'); }
    async [Service.init](): Promise<void> {
      events.push('init');
      entered.resolve();
      await gate.promise;
      this.ready = true;
      this.ctx.effect(() => () => { events.push('service-dispose'); });
      events.push('ready');
    }
  }
  const consumer = app.ctx.plugin({
    inject: ['nativeProbe', 'connection', 'webServer', 'webRuntime'],
    apply(ctx: Context) {
      assert.ok(ctx.nativeProbe.ready, `consumer activation events: ${events.join(',')}`);
      events.push('consumer');
      ctx.effect(() => () => { events.push('consumer-dispose'); });
    },
  });
  const wrapper = app.ctx.plugin(DelayedService);
  await entered.promise;
  assert.equal(app.ctx.get('nativeProbe'), undefined);
  assert.deepEqual(events, ['init']);
  // When: release async initialization, then exercise Cordis's own restart.
  gate.resolve();
  // Awaiting the wrapper yields the raw Fiber once init settles.
  const provider = await wrapper;
  await consumer;
  assert.deepEqual(events, ['init', 'ready', 'consumer']);
  await provider.restart();
  await consumer.await();
  await provider.dispose();
  await consumer.await();
  // Then: no consumer manually invokes init; one init per activation.
  assert.equal(events.filter(event => event === 'init').length, 2);
  assert.equal(events.filter(event => event === 'consumer').length, 2);
  assert.equal(events.filter(event => event === 'consumer-dispose').length, 2);
  assert.equal(events.filter(event => event === 'service-dispose').length, 2);
  assert.equal(app.ctx.get('nativeProbe'), undefined);
});
