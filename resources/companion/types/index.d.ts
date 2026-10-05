// The plugin's contract. Each wave declares its own `$.state` keys here, in its own change.
declare module 'claude-code' {
  interface PluginState {
    'harnu-companion': Record<string, never>
  }
}
