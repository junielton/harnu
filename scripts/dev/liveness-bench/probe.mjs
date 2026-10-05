import { connect, pageTarget } from './cdp.mjs'
import { PAGE_PORT } from './procs.mjs'
const page = await connect((await pageTarget(PAGE_PORT)).webSocketDebuggerUrl)
const v = await page.evaluate(process.argv[2])
console.log(typeof v === 'string' ? v : JSON.stringify(v))
page.close()
process.exit(0)
