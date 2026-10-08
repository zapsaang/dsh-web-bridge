import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import type { LeaseIo } from './socket-types.js';

/** Real filesystem/process primitives; lease behavior tests stub this seam. */
export const defaultIo: LeaseIo = {
  openLock: (path) => open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600),
  lstat,
  probe: (path) => new Promise<void>((resolve, reject) => {
    const client = connect({ path }, () => { client.destroy(); resolve(); });
    client.setTimeout(1000, () => {
      client.destroy();
      reject(Object.assign(new Error('socket probe timed out'), { code: 'ETIMEDOUT' }));
    });
    client.on('error', (error) => { client.destroy(); reject(error); });
  }),
  unlink,
  chmod,
  spawnFlock: (fd) => {
    const helper = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '75', '3'],
      { stdio: ['ignore', 'ignore', 'pipe', fd] });
    return {
      done: new Promise<number>((resolve, reject) => {
        helper.once('error', reject);
        helper.once('exit', (code, signal) => {
          if (signal !== null) reject(new Error(`flock helper killed by ${signal}`));
          else resolve(code ?? 1);
        });
      }),
      kill: () => { helper.kill('SIGKILL'); },
    };
  },
};
