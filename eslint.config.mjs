import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

export default defineConfig(
  // .claude/worktrees holds full nested checkouts Harnu creates for parallel agent
  // sessions — without this, ESLint re-lints every source file in every worktree
  // on top of the real tree, inflating the file count enough to OOM the process.
  {
    // Generated report trees carry bundled/minified JS. Linting them is
    // meaningless AND actively harmful: enough messages to overflow V8's max
    // string length inside eslint's stylish formatter, which surfaces as a bare
    // `RangeError: Invalid string length` and takes the husky pre-push hook down
    // with it — so anyone who has run `test:coverage` or playwright locally
    // finds `git push` blocked by an error that names nothing.
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '.claude/**',
      // The engine writes these next to a loaded mod (companion mod, T389); never hand-edited.
      '**/.claude-plugin/types/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ],
      // Honor the repo's `_`-prefix convention for intentionally-unused bindings
      // (e.g. `registerHaikuHandlers(_getWindow)`, `(_e, payload) => …`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // Tests, one-off probe scripts, standalone runtime resources (e.g. the
    // orchestrator guard hook script, which runs as plain Node with zero build
    // step — real TS-style return-type annotations there would break execution)
    // don't need explicit return-type annotations.
    files: ['tests/**', 'scripts/**', 'resources/**'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
