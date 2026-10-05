import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    // BUG-117: `speech-kokoro.ts` spawns `speech-kokoro-worker.ts` as
    // `new Worker(url, { type: 'module' })`. Vite's default worker bundle
    // format is `iife`; forcing `es` keeps the built chunk an ES module so it
    // matches the `type: 'module'` the constructor call declares.
    worker: { format: 'es' },
    plugins: [vue(), tailwindcss()]
  }
})
