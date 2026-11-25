import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'vite'

/**
 * The real scan worker, bundled to a temp dir and started as a real `worker_threads` Worker, so a test
 * runs the same code in the same kind of thread as the built app (electron-vite emits one CJS file per
 * main entry; this does the same for the one entry the test needs).
 */
export async function buildUsageScanWorker(): Promise<{
  factory: (workerData: unknown) => Worker
  cleanup: () => void
}> {
  const outDir = mkdtempSync(path.join(tmpdir(), 'harnu-usage-worker-'))
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      ssr: path.resolve(__dirname, '../../src/main/usage-scan-worker.ts'),
      outDir,
      emptyOutDir: false,
      minify: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'usage-scan-worker.cjs' } }
    }
  })
  const file = path.join(outDir, 'usage-scan-worker.cjs')
  return {
    factory: (workerData) => new Worker(file, { workerData }),
    cleanup: () => rmSync(outDir, { recursive: true, force: true })
  }
}
