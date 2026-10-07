// T-H15 soak load generators: controllable upstream stub (plain/SSE/WS echo/slow-stream),
// minimal RFC 6455 codec (no extensions, no subprotocols), and UDS HTTP helpers.
// All traffic is loopback/UDS only; no external network, no real credentials.

import { randomBytes, createHash } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// In-flight client handles registered for shutdown-time forced destroy; the
// soak runner drains this registry before awaiting loop settlement (a pending
// request promise must never be able to pin teardown).
export const inflight = new Set();
export function trackInflight(handle) {
  inflight.add(handle);
  handle.once('close', () => inflight.delete(handle));
}

export function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function onAbort() { clearTimeout(timer); done(); }
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function jitter(ms) {
  return Math.floor(ms * (0.5 + Math.random()));
}

// ---------------------------------------------------------------------------
// Minimal WebSocket frame codec. Both peers are harness-owned: no
// fragmentation, no extensions, payloads below 2^32.
// ---------------------------------------------------------------------------

export function encodeFrame(opcode, payload, masked) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = (masked ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!masked) return Buffer.concat([header, payload]);
  const mask = randomBytes(4);
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index++) body[index] ^= mask[index & 3];
  return Buffer.concat([header, mask, body]);
}

export class FrameParser {
  #buffer = Buffer.alloc(0);
  #onFrame;
  constructor(onFrame) { this.#onFrame = onFrame; }
  push(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      if (this.#buffer.length < 2) return;
      const opcode = this.#buffer[0] & 0x0f;
      let length = this.#buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.#buffer.length < 4) return;
        length = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.#buffer.length < 10) return;
        length = Number(this.#buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const isMasked = (this.#buffer[1] & 0x80) !== 0;
      const maskOffset = offset;
      if (isMasked) offset += 4;
      if (this.#buffer.length < offset + length) return;
      let payload = this.#buffer.subarray(offset, offset + length);
      if (isMasked) {
        const mask = this.#buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
      }
      this.#buffer = this.#buffer.subarray(offset + length);
      this.#onFrame(opcode, payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Controllable upstream stub: /echo (200 echo), /sse (event stream),
// /stream-big (endless chunks for slow-reader backpressure), /ws (echo).
// ---------------------------------------------------------------------------

export async function startStubUpstream() {
  const upgradeSockets = new Set();
  const timers = new Set();
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/echo') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(body.length === 0 ? 'ok' : body);
      });
      return;
    }
    if (url === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': soak\n\n');
      let flowing = true;
      const timer = setInterval(() => {
        if (!flowing) return;
        if (!res.write(`data: ${Date.now()}\n\n`)) {
          flowing = false;
          res.once('drain', () => { flowing = true; });
        }
      }, 50);
      timers.add(timer);
      req.on('close', () => { clearInterval(timer); timers.delete(timer); res.destroy(); });
      return;
    }
    if (url === '/stream-big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let flowing = true;
      const timer = setInterval(() => {
        if (!flowing) return;
        if (!res.write(chunk)) {
          flowing = false;
          res.once('drain', () => { flowing = true; });
        }
      }, 20);
      timers.add(timer);
      req.on('close', () => { clearInterval(timer); timers.delete(timer); res.destroy(); });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws')) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      'latin1',
    );
    upgradeSockets.add(socket);
    socket.on('close', () => upgradeSockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.on('end', () => socket.end());
    const parser = new FrameParser((opcode, payload) => {
      if (socket.destroyed) return;
      if (opcode === 0x8) {
        socket.write(encodeFrame(0x8, Buffer.alloc(0), false));
        socket.end();
      } else if (opcode === 0x1 || opcode === 0x2) {
        socket.write(encodeFrame(opcode, payload, false));
      } else if (opcode === 0x9) {
        socket.write(encodeFrame(0xA, payload, false));
      }
    });
    if (head.length > 0) parser.push(head);
    socket.on('data', (chunk) => parser.push(chunk));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    async close() {
      for (const timer of timers) clearInterval(timer);
      for (const socket of upgradeSockets) socket.destroy();
      server.close();
      await once(server, 'close').catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// UDS HTTP client helpers.
// ---------------------------------------------------------------------------

export function udsRequest(socketPath, { method = 'GET', path = '/', headers = {}, body, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, method, path, headers, agent: false }, (res) => {
      trackInflight(res);
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    trackInflight(req);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('uds request timed out')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Slow-reader: receives the response headers, then never reads the body.
// Holds until released, then destroys — exercises end-to-end backpressure.
export function udsSlowRead(socketPath, { path, headers = {}, holdMs }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, method: 'GET', path, headers, agent: false }, (res) => {
      trackInflight(res);
      // Intentionally no data handler / resume: the stream stays paused.
      setTimeout(() => {
        res.destroy();
        req.destroy();
        resolve({ status: res.statusCode ?? 0 });
      }, holdMs).unref();
      res.on('error', () => undefined);
    });
    req.on('error', (error) => {
      if (req.destroyed) resolve({ status: 0 });
      else reject(error);
    });
    trackInflight(req);
    req.end();
  });
}

// Abort-mid-upload: writes part of a large body then destroys the request.
export function udsAbortMidUpload(socketPath, { path = '/echo', headers = {}, bodyBytes = 131072, abortAfterMs = 15 }) {
  return new Promise((resolve) => {
    const req = httpRequest({ socketPath, method: 'POST', path, headers, agent: false }, (res) => {
      trackInflight(res);
      res.on('data', () => undefined);
      res.on('end', () => resolve('completed'));
      res.on('error', () => resolve('response-error'));
    });
    req.on('error', () => resolve('aborted'));
    trackInflight(req);
    const chunk = Buffer.alloc(16384, 0x62);
    let sent = 0;
    const pump = setInterval(() => {
      sent += chunk.length;
      if (sent >= bodyBytes || !req.write(chunk)) clearInterval(pump);
    }, 2);
    setTimeout(() => {
      clearInterval(pump);
      req.destroy();
      resolve('destroyed');
    }, abortAfterMs).unref();
  });
}

// ---------------------------------------------------------------------------
// WebSocket client over UDS through the bridge.
// ---------------------------------------------------------------------------

export class WsClient extends EventEmitter {
  #socket;
  #parser;
  #ready;
  constructor(socketPath, { host, path = '/ws' }) {
    super();
    const key = randomBytes(16).toString('base64');
    const socket = connect({ path: socketPath });
    trackInflight(socket);
    this.#socket = socket;
    let handshaken = false;
    let handshakeBuffer = Buffer.alloc(0);
    this.#parser = new FrameParser((opcode, payload) => {
      if (opcode === 0x1 || opcode === 0x2) this.emit('message', payload);
      if (opcode === 0x8) socket.end();
    });
    this.#ready = new Promise((resolve, reject) => {
      socket.on('connect', () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
          + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          'latin1',
        );
      });
      socket.on('data', (chunk) => {
        if (handshaken) {
          this.#parser.push(chunk);
          return;
        }
        handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
        const boundary = handshakeBuffer.indexOf('\r\n\r\n');
        if (boundary === -1) return;
        const head = handshakeBuffer.subarray(0, boundary).toString('latin1');
        if (!head.startsWith('HTTP/1.1 101')) {
          reject(new Error(`ws handshake rejected: ${head.split('\r\n')[0] ?? 'empty'}`));
          socket.destroy();
          return;
        }
        handshaken = true;
        resolve();
        const rest = handshakeBuffer.subarray(boundary + 4);
        if (rest.length > 0) this.#parser.push(rest);
      });
      socket.on('error', (error) => {
        if (!handshaken) reject(error);
        this.emit('socket-error', error);
      });
      socket.on('close', () => this.emit('close'));
    });
    this.#ready.catch(() => undefined);
  }
  get ready() { return this.#ready; }
  send(text) {
    if (!this.#socket.destroyed) this.#socket.write(encodeFrame(0x1, Buffer.from(text), true));
  }
  close() {
    if (this.#socket.destroyed) return;
    try {
      this.#socket.write(encodeFrame(0x8, Buffer.alloc(0), true));
    } catch {
      // Socket already torn down; destroy below is the cleanup of record.
    }
    this.#socket.destroy();
  }
}
