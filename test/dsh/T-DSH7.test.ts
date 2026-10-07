import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { send, temporaryHome } from './harness.js';

type ProcessReady = {
  readonly port: number;
  readonly cookie: string;
  readonly tokenFingerprint: string;
};
class ProcessProbeError extends Error {
  constructor(readonly phase: string) { super(`native process probe: ${phase}`); }
}

async function launch(home: string): Promise<ProcessReady & AsyncDisposable> {
  const child = fork(new URL('./process-worker.js', import.meta.url), [home], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
  try {
    const ready = await new Promise<ProcessReady>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProcessProbeError('readiness-timeout')), 5000);
      child.once('error', reject);
      child.once('exit', () => { clearTimeout(timer); reject(new ProcessProbeError('early-exit')); });
      child.once('message', (message: unknown) => {
        clearTimeout(timer);
        if (typeof message !== 'object' || message === null
          || !('port' in message) || typeof message.port !== 'number'
          || !('cookie' in message) || typeof message.cookie !== 'string'
          || !('tokenFingerprint' in message) || typeof message.tokenFingerprint !== 'string') {
          reject(new ProcessProbeError('invalid-ready-message'));
          return;
        }
        resolve({ port: message.port, cookie: message.cookie, tokenFingerprint: message.tokenFingerprint });
      });
    });
    return {
      ...ready,
      async [Symbol.asyncDispose]() {
        child.send('stop');
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        try { assert.equal(await exited, 0, 'native process exits after disposal'); }
        finally { clearTimeout(timer); }
      },
    };
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    throw error;
  }
}

// §2.3/2.4: new OS process, same temporary durable credential store.
test('T-DSH7 changes process token but accepts unexpired cookie when the process restarts', async () => {
  // Given
  const home = await temporaryHome();
  try {
    let previous: ProcessReady;
    {
      await using first = await launch(home);
      previous = first;
    }
    // When: the first OS process has exited before the second starts.
    await using second = await launch(home);
    const response = await send(second.port, { headers: { cookie: previous.cookie } });
    // Then
    assert.ok(previous.tokenFingerprint !== second.tokenFingerprint, 'restart changes token');
    assert.equal(response.status, 200);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
