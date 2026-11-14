/** The production school entrypoint must always include the portal protocol. */
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], {
  cwd: root,
  env: { ...process.env, VITE_APP_BASE: '/client/school/', VITE_PORTAL_MODE: 'true', VITE_STAFF_MODE: 'false' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const index = await readFile(path.join(root, 'dist/index.html'), 'utf8');
const entry = [...index.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match => match[1]);
if (entry.length !== 1 || !entry[0].startsWith('/client/school/assets/')) {
  throw new Error('Portal build: неверный базовый путь entrypoint.');
}
const bundle = await readFile(path.join(root, 'dist', entry[0].slice('/client/school/'.length)), 'utf8');
for (const marker of ['portal-session', 'X-CSRF-Token', 'csrfToken', 'school-portal-session-expired']) {
  if (!bundle.includes(marker)) throw new Error(`Portal build: обязательный протокол отсутствует (${marker}).`);
}
console.log('Portal artifact boundary: PASS (/client/school/ + CSRF + session expiry).');
