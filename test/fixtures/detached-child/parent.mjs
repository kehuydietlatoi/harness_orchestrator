import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { setInterval, clearInterval } from 'node:timers';

const [record, mode = 'exit'] = process.argv.slice(2);
const child = spawn(process.execPath, [fileURLToPath(new URL('./spawner.mjs', import.meta.url)), record], {
  detached: true, stdio: 'ignore',
});
child.unref();
const ready = setInterval(() => {
  try { JSON.parse(readFileSync(record, 'utf8')); } catch { return; }
  clearInterval(ready);
  // Also exercise inherited pipes: completion must follow root exit, not pipe close.
  console.log('READY');
  if (mode === 'evidence') {
    writeFileSync(join(process.argv[5], 'run.json'), JSON.stringify({
      sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), ok: true,
    }));
    process.exit(0);
  }
  if (mode === 'exit') process.exit(0);
  setInterval(() => {}, 1000);
}, 10);
