import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function runtimeRoot(): string {
  const dir = process.env['XDG_RUNTIME_DIR'];
  assert.ok(dir, 'lifecycle probes require XDG_RUNTIME_DIR (trusted ancestor chain)');
  return dir;
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(runtimeRoot(), 'dsh-bridge-lease-'));
}

export async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function responder(): Server {
  return createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
}

export function requestOverSocket(socketPath: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, agent: false }, (res) => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

export function connectRaw(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = import('node:net').then(({ connect }) => {
      const client = connect({ path }, () => {
        client.destroy();
        resolve();
      });
      client.on('error', (error) => {
        client.destroy();
        reject(error);
      });
    });
    socket.catch(reject);
  });
}

export interface ChildHandle {
  readonly pid: number;
  waitReady(): Promise<Record<string, number>>;
  kill(signal: NodeJS.Signals): void;
  exited(): Promise<number | null>;
}

export function spawnFixture(name: string, args: string[]): ChildHandle {
  const fixture = fileURLToPath(new URL(`../../../test/lifecycle/fixtures/${name}`, import.meta.url));
  const socketJs = fileURLToPath(new URL('../../src/lib/socket.js', import.meta.url));
  const child = spawn(process.execPath, [fixture, socketJs, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  let exitPromise: Promise<number | null> | undefined;
  return {
    pid: child.pid ?? 0,
    waitReady: () => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`fixture ${name} not ready; stdout: ${stdout}`)), 10000);
      child.stdout.on('data', () => {
        const line = stdout.split('\n').find((entry) => entry.startsWith('{'));
        if (line) {
          clearTimeout(deadline);
          resolve(JSON.parse(line) as Record<string, number>);
        }
      });
    }),
    kill: (signal) => { child.kill(signal); },
    exited: () => {
      exitPromise ??= new Promise((resolve) => child.once('exit', (code) => resolve(code)));
      return exitPromise;
    },
  };
}

export async function poll(predicate: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('poll predicate not satisfied within timeout');
}
