/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars -- a standalone probe script run by Electron/Node directly */
// Companion of main-cost.cjs: a utilityProcess that runs execFile() on the main process behalf.
const cp = require('node:child_process')
process.parentPort.on('message', (e) => {
  const { file, args } = e.data
  cp.execFile(file, args, { encoding: 'utf8' }, (err, stdout, stderr) =>
    process.parentPort.postMessage({ code: err ? err.code : 0, stdout, stderr })
  )
})
process.parentPort.postMessage({ ready: true })
