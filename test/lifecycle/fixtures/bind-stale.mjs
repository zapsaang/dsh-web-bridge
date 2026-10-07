import { createServer } from 'node:http';

const [, , , dir] = process.argv;
const server = createServer();
server.listen(`${dir}/bridge.sock`, () => process.exit(0));
