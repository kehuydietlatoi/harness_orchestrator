import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
const server = createServer();
server.listen(0, '127.0.0.1', () => {
  writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, port: server.address().port }));
});
