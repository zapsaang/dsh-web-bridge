import { createHash } from 'node:crypto';
import { Harness, cookiePair } from './harness.js';

try {
  const home = process.argv[2];
  if (!home || !process.send) throw new TypeError('isolated home and IPC required');
  await using app = await Harness.start(home);
  const stopped = Promise.withResolvers<void>();
  process.on('message', message => { if (message === 'stop') stopped.resolve(); });
  process.on('disconnect', () => stopped.resolve());
  const cookie = cookiePair(await app.exchange());
  process.send({
    port: app.port, cookie,
    tokenFingerprint: createHash('sha256').update(app.token()).digest('hex'),
  });
  await stopped.promise;
} catch (error) {
  // This IPC boundary never forwards an error message/stack or credential.
  process.send?.({ failure: error instanceof Error ? error.name : 'UnknownFailure' });
  process.exitCode = 1;
} finally {
  if (process.connected) process.disconnect();
}
