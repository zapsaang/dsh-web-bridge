import { createServer } from 'node:http';
import { lstatSync } from 'node:fs';

const [, , socketJs, dir] = process.argv;
const { acquire } = await import(socketJs);
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('held');
});
const lease = await acquire(`${dir}/bridge.sock`, server, new AbortController().signal);
const socket = lstatSync(lease.socketPath);
const lock = lstatSync(lease.lockPath);
process.stdout.write(`${JSON.stringify({
  socketIno: socket.ino, socketDev: socket.dev, lockIno: lock.ino, lockDev: lock.dev,
})}\n`);
setInterval(() => {}, 60_000);
