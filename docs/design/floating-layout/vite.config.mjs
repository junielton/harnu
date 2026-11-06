import { resolve } from 'path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
const repo = resolve(import.meta.dirname, '../../..')
export default defineConfig({
  root: resolve(repo, 'src/renderer'),
  resolve: { alias: { '@renderer': resolve(repo, 'src/renderer/src') } },
  worker: { format: 'es' },
  server: { port: 5199, host: '127.0.0.1', strictPort: true, fs: { allow: [repo] } },
  plugins: [
    vue(),
    tailwindcss(),
    {
      name: 'harnu-web-stub',
      transformIndexHtml(html) {
        return html
          .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
          .replace(
            '<script type="module"',
            '<script src="/@fs' +
              resolve(import.meta.dirname, 'stub.js') +
              '"></script>\n    <script type="module"'
          )
      }
    }
  ]
})
