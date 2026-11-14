import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const configuredBase = process.env.VITE_APP_BASE || '/'
const base = configuredBase.endsWith('/') ? configuredBase : `${configuredBase}/`
if (!base.startsWith('/') || base.startsWith('//') || /[?#\\]/.test(base) || base.split('/').some(part => part === '.' || part === '..')) {
 throw new Error('VITE_APP_BASE должен быть абсолютным путём, например /client/school/.')
}
const apiPrefix = `${base}api`
const proxy = { [apiPrefix]: { target: 'http://127.0.0.1:8798', rewrite: (path: string) => `/api${path.slice(apiPrefix.length)}` } }

export default defineConfig({
 base,
 plugins: [react(), {
  name: 'school-portal-build-boundary',
  configResolved(config) {
   // Check the final Vite env, including mode files, rather than guessing the
   // compiled branch from process.env before Vite resolves its environment.
   if (config.command === 'build' && config.base.replace(/\/+$/, '') === '/client/school' && config.env.VITE_PORTAL_MODE !== 'true') {
    throw new Error('Сборка /client/school/ требует VITE_PORTAL_MODE=true. Используйте npm run build:portal.')
   }
  },
 }],
 server: { host: '127.0.0.1', port: 5188, strictPort: true, proxy },
 preview: { host: '127.0.0.1', port: 5188, strictPort: true, proxy },
})
