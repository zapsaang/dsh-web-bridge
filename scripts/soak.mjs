#!/usr/bin/env node
// T-H15 soak harness (§14.2): real bridge instances under sustained mixed load
// with periodic dispose/reload, JSONL observability, and request-proven
// readiness (never process-alive). This harness plus a short --duration-minutes
// run is a SMOKE TEST ONLY; it is not T-H15 24h boundedness evidence.
//
// Usage:
//   node scripts/soak.mjs [--duration-minutes 10] [--log soak-<ts>.jsonl]
//                         [--sample-interval-sec 5] [--reload-interval-sec 60]
//                         [--dsh-reload-interval-sec 180]
// Requires compiled outputs in .test-dist-soak (see `pnpm run soak`).

import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, readFile, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';
import {
  startStubUpstream, udsRequest, udsSlowRead, udsAbortMidUpload, WsClient, sleep, jitter,
  inflight, trackInflight,
} from './soak-load.mjs';

const dist = fileURLToPath(new URL('../.test-dist-soak/', import.meta.url));
const { acquire } = await import(join(dist, 'src/lib/socket.js'));
const { handleRequest, handleCheckContinue, handleUpgrade } = await import(join(dist, 'src/lib/bridge.js'));
const bridge = await import(join(dist, 'src/dsh/index.js'));
const { isolated, authority } = await import(join(dist, 'test/dsh/harness.js'));

const STUB_AUTHORITY = 'stub.example.test';
const NAV = { host: authority, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

function parseArgs(argv) {
  const options = {
    durationMinutes: 10,
    log: `soak-${new Date().toISOString().replaceAll(':', '-')}.jsonl`,
    sampleIntervalSec: 5,
    reloadIntervalSec: 60,
    dshReloadIntervalSec: 180,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    if (key === '--duration-minutes') options.durationMinutes = Number(value);
    else if (key === '--log') options.log = value;
    else if (key === '--sample-interval-sec') options.sampleIntervalSec = Number(value);
    else if (key === '--reload-interval-sec') options.reloadIntervalSec = Number(value);
    else if (key === '--dsh-reload-interval-sec') options.dshReloadIntervalSec = Number(value);
    else if (key === '--only') options.only = value.split(',');
    else throw new Error(`unknown option ${key}`);
  }
  if (!(options.durationMinutes > 0)) throw new Error('--duration-minutes must be positive');
  return options;
}

// Stub-backed bridge on its own UDS lease; mirrors src/dsh/index.ts wiring.
async function startStubBridge(socketPath, upstreamPort) {
  const controller = new AbortController();
  const runtime = {
    endpoint: {
      port: upstreamPort,
      authenticatedUrl: () => {
        throw new Error('stub upstream never triggers exchange');
      },
    },
    authorities: [STUB_AUTHORITY],
    signal: controller.signal,
  };
  const server = createServer();
  server.on('request', (req, res) => {
    void handleRequest(req, res, runtime).catch(() => { req.destroy(); res.destroy(); });
  });
  server.on('checkContinue', (req, res) => {
    void handleCheckContinue(req, res, runtime).catch(() => { req.destroy(); res.destroy(); });
  });
  server.on('checkExpectation', (req, res) => {
    void handleRequest(req, res, runtime).catch(() => { req.destroy(); res.destroy(); });
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head, runtime);
    } catch {
      socket.destroy();
    }
  });
  const lease = await acquire(socketPath, server, controller.signal);
  return {
    async close() {
      controller.abort();
      await lease.dispose();
    },
  };
}

async function fdCount() {
  try {
    const entries = await readdir('/proc/self/fd');
    const kinds = { socket: 0, pipe: 0, file: 0, other: 0 };
    await Promise.all(entries.map(async (fd) => {
      try {
        const target = await readlink(`/proc/self/fd/${fd}`);
        if (target.startsWith('socket:')) kinds.socket++;
        else if (target.startsWith('pipe:')) kinds.pipe++;
        else if (target.startsWith('/')) kinds.file++;
        else kinds.other++;
      } catch {
        // fd closed between readdir and readlink; transient by definition.
      }
    }));
    return { total: entries.length, kinds };
  } catch {
    return { total: -1, kinds: { socket: -1, pipe: -1, file: -1, other: -1 } };
  }
}

async function childCount() {
  try {
    const raw = await readFile(`/proc/self/task/${process.pid}/children`, 'utf8');
    return raw.trim().split(/\s+/).filter(Boolean).length;
  } catch {
    return -1;
  }
}

function headerAll(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const durationMs = options.durationMinutes * 60_000;
  const runtimeBase = process.env.XDG_RUNTIME_DIR ?? tmpdir();
  const root = await mkdtemp(join(runtimeBase, 'dsh-soak-'));
  const stubSocket = join(root, 'stub.sock');
  const dshSocket = join(root, 'dsh.sock');
  const log = createWriteStream(options.log, { flags: 'w' });
  const emit = (record) => {
    log.write(`${JSON.stringify({ t: Date.now(), ...record })}\n`);
  };
  emit({ type: 'start', options: { ...options, durationMs }, pid: process.pid });

  const counters = {
    httpStub: 0, httpDshNav: 0, httpDshApi: 0, sseSessions: 0, sseEvents: 0,
    wsSessions: 0, wsMessages: 0, slowReaders: 0, aborts: 0,
    reloads: 0, dshReloads: 0, loadErrors: 0, readinessFailures: 0,
  };
  const gauges = { sseOpen: 0, wsOpen: 0, slowOpen: 0 };
  const errorKinds = new Map();
  const noteError = (error) => {
    const key = String(error?.code ?? error?.message ?? error).slice(0, 60);
    errorKinds.set(key, (errorKinds.get(key) ?? 0) + 1);
  };
  const samples = [];

  const upstream = await startStubUpstream();
  let stubBridge = await startStubBridge(stubSocket, upstream.port);
  const app = await isolated();
  const dshBridgeFiber = await app.ctx.plugin(bridge, { socketPath: dshSocket, authorities: [authority] });

  // Readiness is request-proven: a full real round-trip through each bridge.
  async function readinessStub() {
    const result = await udsRequest(stubSocket, { path: '/echo', headers: { host: STUB_AUTHORITY } });
    if (result.status !== 200) throw new Error(`stub readiness status ${result.status}`);
  }
  async function readinessDsh() {
    const bootstrap = await udsRequest(dshSocket, { path: '/', headers: NAV });
    if (bootstrap.status !== 200) throw new Error(`dsh bootstrap status ${bootstrap.status}`);
    const cookie = headerAll(bootstrap.headers, 'set-cookie')[0]?.split(';', 1)[0];
    if (!cookie) throw new Error('dsh bootstrap issued no cookie');
    const retry = await udsRequest(dshSocket, {
      path: '/?__dsh_bridge_retry=1', headers: { ...NAV, cookie },
    });
    if (retry.status !== 303) throw new Error(`dsh marked retry status ${retry.status}`);
    const clean = await udsRequest(dshSocket, { path: '/', headers: { host: authority, cookie } });
    if (clean.status !== 200) throw new Error(`dsh clean root status ${clean.status}`);
  }
  async function readiness(name, probe, timeoutMs = 10000) {
    const started = performance.now();
    let lastError = 'no attempt';
    while (performance.now() - started < timeoutMs) {
      try {
        await probe();
        emit({ type: 'readiness', target: name, ok: true, ms: Math.round(performance.now() - started) });
        return;
      } catch (error) {
        lastError = String(error);
        await sleep(100);
      }
    }
    counters.readinessFailures++;
    emit({
      type: 'readiness', target: name, ok: false,
      ms: Math.round(performance.now() - started), error: lastError,
    });
  }
  await readiness('stub', readinessStub);
  await readiness('dsh', readinessDsh);
  if (counters.readinessFailures > 0) throw new Error('initial readiness failed; aborting soak');

  // -------------------------------------------------------------------------
  // Load loops. Errors against a bridge mid-reload are expected and counted,
  // never fatal; only post-reload readiness verdicts gate the run.
  // -------------------------------------------------------------------------
  const loadCtl = new AbortController();
  const { signal } = loadCtl;
  const guarded = (kind, fn) => async () => {
    while (!signal.aborted) {
      try {
        await fn();
      } catch (error) {
        if (!signal.aborted) {
          counters.loadErrors++;
          noteError(error);
        }
      }
    }
  };
  const loopFactories = {
    'http-stub': () => guarded('http-stub', async () => {
      const body = randomBody(2048 + Math.floor(Math.random() * 14336));
      const result = await udsRequest(stubSocket, {
        method: 'POST', path: '/echo', headers: { host: STUB_AUTHORITY }, body,
      });
      if (result.status === 200) counters.httpStub++;
      await sleep(jitter(30), signal);
    }),
    'http-dsh-nav': () => guarded('http-dsh-nav', async () => {
      const result = await udsRequest(dshSocket, { path: '/', headers: NAV });
      if (result.status === 200) counters.httpDshNav++;
      await sleep(jitter(60), signal);
    }),
    'http-dsh-api': () => guarded('http-dsh-api', async () => {
      await udsRequest(dshSocket, { path: '/api/soak-probe', headers: { host: authority } });
      counters.httpDshApi++;
      await sleep(jitter(80), signal);
    }),
    sse: () => guarded('sse', async () => {
      gauges.sseOpen++;
      counters.sseSessions++;
      try {
        await new Promise((resolve) => {
          const req = httpRequest(
            { socketPath: stubSocket, path: '/sse', headers: { host: STUB_AUTHORITY }, agent: false },
            (res) => {
              trackInflight(res);
              res.on('data', () => counters.sseEvents++);
              res.on('error', () => resolve());
              const hold = setTimeout(() => { req.destroy(); resolve(); }, 2000 + jitter(6000));
              hold.unref();
              res.on('close', () => { clearTimeout(hold); resolve(); });
            },
          );
          req.on('error', () => resolve());
          trackInflight(req);
          req.end();
        });
      } finally {
        gauges.sseOpen--;
      }
      await sleep(jitter(200), signal);
    }),
    ws: () => guarded('ws', async () => {
      gauges.wsOpen++;
      counters.wsSessions++;
      const client = new WsClient(stubSocket, { host: STUB_AUTHORITY });
      let sequence = 0;
      let resolveSession;
      const session = new Promise((resolve) => { resolveSession = resolve; });
      client.on('message', () => counters.wsMessages++);
      client.on('socket-error', () => resolveSession());
      client.on('close', () => resolveSession());
      try {
        await client.ready;
        const deadline = Date.now() + 3000 + jitter(5000);
        while (!signal.aborted && Date.now() < deadline) {
          client.send(`soak-${sequence++}`);
          await sleep(150, signal);
        }
      } catch {
        counters.loadErrors++;
      } finally {
        client.close();
        await session;
        gauges.wsOpen--;
      }
    }),
    'slow-reader': () => guarded('slow-reader', async () => {
      gauges.slowOpen++;
      counters.slowReaders++;
      try {
        await udsSlowRead(stubSocket, {
          path: '/stream-big', headers: { host: STUB_AUTHORITY }, holdMs: 3000 + jitter(4000),
        });
      } finally {
        gauges.slowOpen--;
      }
      await sleep(jitter(300), signal);
    }),
    abort: () => guarded('abort', async () => {
      await udsAbortMidUpload(stubSocket, { headers: { host: STUB_AUTHORITY } });
      counters.aborts++;
      await sleep(jitter(120), signal);
    }),
  };
  const loopPlan = [
    ['http-stub', 4], ['http-dsh-nav', 2], ['http-dsh-api', 1],
    ['sse', 3], ['ws', 2], ['slow-reader', 2], ['abort', 2],
  ];
  const selected = options.only === undefined
    ? loopPlan
    : loopPlan.filter(([name]) => options.only.includes(name));
  const running = selected.flatMap(([name, count]) =>
    Array.from({ length: count }, () => loopFactories[name]()()));

  // Periodic dispose/reload of both bridges; readiness proven by real requests.
  const lifecycleCtl = new AbortController();
  const reloadLoop = (async () => {
    while (!lifecycleCtl.signal.aborted) {
      await sleep(options.reloadIntervalSec * 1000, lifecycleCtl.signal);
      if (lifecycleCtl.signal.aborted) break;
      const started = performance.now();
      await stubBridge.close();
      stubBridge = await startStubBridge(stubSocket, upstream.port);
      await readiness('stub', readinessStub);
      await dshBridgeFiber.restart();
      await readiness('dsh', readinessDsh);
      counters.reloads++;
      emit({ type: 'reload', cycle: counters.reloads, ms: Math.round(performance.now() - started) });
    }
  })();
  const dshReloadLoop = (async () => {
    while (!lifecycleCtl.signal.aborted) {
      await sleep(options.dshReloadIntervalSec * 1000, lifecycleCtl.signal);
      if (lifecycleCtl.signal.aborted) break;
      await app.reload();
      await readiness('dsh-after-native-reload', readinessDsh);
      counters.dshReloads++;
      emit({ type: 'dsh-reload', cycle: counters.dshReloads });
    }
  })();

  const startedAt = Date.now();
  const sampler = setInterval(() => {
    void (async () => {
      const memory = process.memoryUsage();
      const fd = await fdCount();
      const sample = {
        type: 'sample',
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
        external: memory.external, arrayBuffers: memory.arrayBuffers,
        fds: fd.total, fdKinds: fd.kinds, children: await childCount(),
        gauges: { ...gauges }, counters: { ...counters },
      };
      samples.push(sample);
      emit(sample);
    })();
  }, options.sampleIntervalSec * 1000);

  const stepTimeout = (ms) => new Promise((resolve) => {
    setTimeout(() => resolve('timeout'), ms).unref();
  });
  const shutdown = async (reason) => {
    clearInterval(sampler);
    lifecycleCtl.abort();
    loadCtl.abort();
    // Forced-destroy in-flight client handles: a pending request promise must
    // never pin teardown (observed: pre-fix runs hung in allSettled forever).
    for (const handle of [...inflight]) handle.destroy();
    try {
      await Promise.race([Promise.allSettled(running), stepTimeout(15000)]);
      await Promise.race([Promise.allSettled([reloadLoop, dshReloadLoop]), stepTimeout(15000)]);
      await Promise.race([
        (async () => {
          await readiness('stub-final', readinessStub);
          await readiness('dsh-final', readinessDsh);
        })(),
        stepTimeout(20000),
      ]);
    } finally {
      emit({ type: 'stopping', reason });
      await Promise.race([
        Promise.allSettled([stubBridge?.close(), app[Symbol.asyncDispose](), upstream.close()]),
        stepTimeout(15000),
      ]);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      const summary = summarize(samples, counters, options, errorKinds);
      emit({ type: 'summary', ...summary });
      await new Promise((resolve) => log.end(resolve));
      console.log(JSON.stringify(summary, null, 2));
      process.exitCode = counters.readinessFailures > 0 ? 1 : 0;
      setTimeout(() => process.exit(process.exitCode ?? 0), 10000).unref();
    }
  };
  process.once('SIGINT', () => void shutdown('sigint'));
  process.once('SIGTERM', () => void shutdown('sigterm'));
  setTimeout(() => void shutdown('duration-complete'), durationMs).unref();
  emit({ type: 'running', durationMs });
}

function randomBody(size) {
  return Buffer.alloc(size, Math.floor(Math.random() * 256));
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(samples, counters, options, errorKinds) {
  const totalSec = samples.at(-1)?.elapsedSec ?? 0;
  const windowSec = Math.min(300, Math.max(1, Math.floor(totalSec / 2)));
  const first = samples.filter((sample) => sample.elapsedSec <= windowSec);
  const last = samples.filter((sample) => sample.elapsedSec >= totalSec - windowSec);
  const field = (selector) => {
    const a = mean(first.map(selector));
    const b = mean(last.map(selector));
    return {
      windowSec,
      firstMean: Math.round(a),
      lastMean: Math.round(b),
      growthRatio: a > 0 ? Number((b / a).toFixed(3)) : null,
    };
  };
  return {
    note: 'short-run smoke sanity only; NOT T-H15 24h boundedness evidence',
    durationSec: totalSec,
    samples: samples.length,
    counters,
    loadErrorKinds: Object.fromEntries([...errorKinds.entries()].sort((a, b) => b[1] - a[1])),
    rss: field((s) => s.rss),
    heapUsed: field((s) => s.heapUsed),
    fds: field((s) => Math.max(0, s.fds)),
    children: field((s) => Math.max(0, s.children)),
    logFile: options.log,
  };
}

await main().catch((error) => {
  console.error('soak harness fatal:', error);
  process.exitCode = 1;
});
