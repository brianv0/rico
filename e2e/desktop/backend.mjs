// Fake GitHub + a Rico server pointed at it, for the desktop (real Chrome + OS input) run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFake } from '../../test/fake-github.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fake = await startFake();
const rico = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: '4318', GITHUB_TOKEN: 't', GITHUB_API_URL: `http://127.0.0.1:${fake.port}` } });
// never leave the Rico child holding the port when the launcher stops us
const stop = () => { rico.kill(); process.exit(0); };
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, stop);
process.on('exit', () => rico.kill());
setInterval(() => fs.writeFileSync('/tmp/fake-state.json', JSON.stringify({ posted: fake.posted, replies: fake.replies })), 150);
console.log('backend up');
