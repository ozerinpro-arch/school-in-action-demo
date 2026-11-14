/** Separate staff artifact; never overwrites the existing owner build. */
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const base=process.env.SHKOLA_STAFF_BUILD_BASE||'/client/school/';
if(base.length>121||!/^\/[A-Za-z0-9][A-Za-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_-]*)*\/$/.test(base))throw Error('Invalid canonical staff build base');
const result=spawnSync(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'build','--outDir','dist-staff'],{cwd:root,env:{...process.env,VITE_APP_BASE:base,VITE_PORTAL_MODE:'true',VITE_STAFF_MODE:'true'},stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
const html=await readFile(path.join(root,'dist-staff/index.html'),'utf8');
const entry=[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(m=>m[1]);
if(entry.length!==1||!entry[0].startsWith(`${base}assets/`))throw Error('Invalid staff entrypoint');
const js=await readFile(path.join(root,'dist-staff',entry[0].slice(base.length)),'utf8');
for(const marker of ['portal-session','X-CSRF-Token','/api/staff/me','/api/staff/logout'])if(!js.includes(marker))throw Error(`Missing staff protocol: ${marker}`);
console.log('Staff artifact boundary: PASS (separate output, sessions + CSRF).');
