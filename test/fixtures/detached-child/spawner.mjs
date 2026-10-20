import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
// Exit before the server announces readiness: tree walks from the root can no
// longer find this detached grandchild through its already-dead parent.
const server = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), process.argv[2]], {
  detached: true, stdio: 'ignore',
});
server.unref();
