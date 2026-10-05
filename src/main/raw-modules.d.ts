// Vite `?raw` suffix imports resolve a file's text content as a default string
// export. Vite (which electron-vite drives for the main bundle too) transforms
// these at build time — the string is inlined into the bundle, no runtime file
// read. `electron-vite/node` only types the `import.meta.glob` `as: 'raw'` form,
// not the `'*?raw'` module form, so we declare it here for the main/preload
// tsconfig (`tsconfig.node.json`, which globs the src/main tree). Used by
// `harnu-features.ts` to embed `docs/harnu-features.md` (T55).
declare module '*?raw' {
  const content: string
  export default content
}
