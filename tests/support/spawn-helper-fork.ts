import * as path from 'node:path'
import { fromForkedHelper, type HelperFactory } from '../../src/main/spawn-runner'

/**
 * The real helper script as a plain Node child (no Electron in tests): Node strips the types of the one
 * self-contained file, so the test runs exactly what electron-vite bundles for `utilityProcess`.
 */
export const forkedHelperFactory: HelperFactory = fromForkedHelper(
  path.resolve(__dirname, '../../src/main/spawn-helper.ts'),
  ['--experimental-strip-types', '--no-warnings']
)
