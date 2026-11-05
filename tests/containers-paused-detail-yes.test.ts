// @vitest-environment jsdom
// U3.7 AC-5 (tech debt from U3.4): "Rebuilds on restore" reads "Yes", as design.md says.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import ContainersPausedDetail from '../src/renderer/src/components/ContainersPausedDetail.vue'
import { i18n } from '../src/renderer/src/i18n'
import type { PausedStack } from '../src/main/containers/containers-wire'

const paused: PausedStack = {
  stack: 'proj-34',
  name: 'proj-34',
  actor: 'autopilot',
  project: 'proj-34',
  workingDir: '/w/proj-34',
  configFiles: [],
  profiles: [],
  envFile: null,
  hasBuild: true,
  ports: [],
  restoreCommand: 'docker compose -p proj-34 up -d --build',
  pausedAt: Date.now() - 3_600_000
}

describe('ContainersPausedDetail', () => {
  it('Rebuilds on restore reads "Yes" with a capital', () => {
    const w = mount(ContainersPausedDetail, {
      props: { paused },
      global: { plugins: [createPinia(), i18n] }
    })
    const grid = w.get('.grid')
    expect(grid.text()).toContain('Rebuilds on restore')
    expect(grid.text()).toMatch(/Rebuilds on restore\s*Yes/)
    expect(grid.text()).not.toMatch(/Rebuilds on restore\s*yes/)
  })
})
