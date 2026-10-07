/**
 * The only import path main uses for the Harnu mod protocol. The canonical file lives under
 * `resources/` because the mod imports it by a relative path inside the plugin dir; the host
 * compiles the same file into the main bundle (types and constants only, zero imports).
 */
export * from '../../../resources/companion/hooks/contract'
