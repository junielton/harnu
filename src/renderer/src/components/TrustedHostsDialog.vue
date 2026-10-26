<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X, Plus } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useFocusTrap } from '../composables/useFocusTrap'
import { basename } from './folder-alias'
import {
  BUILT_IN_TRUSTED_HOSTS,
  addTrustedHost,
  removeTrustedHost
} from '../../../shared/browser-trusted-hosts'

/**
 * "Trusted dev hosts" dialog (T571 U4, spec §7.2). The folder's list of hosts that are the operator's own dev
 * servers (`app.test`, `*.test`, a docker service name): a page on one counts as `local`, so agents drive it
 * without asking. Each add or remove saves at once (like the folder menu's toggles). The rules for what an entry
 * may be live in `browser/trusted-hosts.ts` (pure, shared with main, which validates again). Only the operator
 * edits this list; no agent verb does. See design.md "Trusted dev hosts dialog".
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const { t } = useI18n()

const isOpen = computed(() => ui.dialog === 'trustedHosts')
const targetPath = computed(() => ui.folderActionPath ?? '')
const base = computed(() => basename(targetPath.value))
const hosts = computed<string[]>(() => sessions.browserTrustedHosts.get(targetPath.value) ?? [])

const draft = ref('')
const errorKey = ref<string | null>(null)
const saving = ref(false)

async function save(next: string[]): Promise<void> {
  saving.value = true
  try {
    await sessions.setFolderBrowserTrustedHosts(targetPath.value, next)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ui.pushToast({ kind: 'danger', title: t('trustedHosts.failed'), description: message })
  } finally {
    saving.value = false
  }
}

async function add(): Promise<void> {
  if (saving.value) return
  const res = addTrustedHost(hosts.value, draft.value)
  if (!res.ok) {
    errorKey.value = res.error
    return
  }
  errorKey.value = null
  draft.value = ''
  await save(res.hosts)
}

async function remove(host: string): Promise<void> {
  if (saving.value) return
  errorKey.value = null
  await save(removeTrustedHost(hosts.value, host))
}

function close(): void {
  ui.closeDialog()
}

const inputRef = ref<HTMLInputElement | null>(null)
const dialogRef = ref<HTMLElement | null>(null)

useFocusTrap({ active: isOpen, containerRef: dialogRef, initialFocusRef: inputRef })

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}

function onKeydown(e: KeyboardEvent): void {
  if (!isOpen.value) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

watch(isOpen, (open) => {
  if (open) {
    draft.value = ''
    errorKey.value = null
    saving.value = false
    window.addEventListener('keydown', onKeydown, true)
    void nextTick(() => inputRef.value?.focus())
  } else {
    window.removeEventListener('keydown', onKeydown, true)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(480px, 90vw);
          max-height: 80vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="trusted-hosts-dialog-title"
        data-testid="trusted-hosts-dialog"
        @mousedown.stop
      >
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <div class="flex items-baseline" style="gap: 8px; min-width: 0">
            <h2
              id="trusted-hosts-dialog-title"
              class="text-text"
              style="font-size: 13.5px; line-height: 20px; font-weight: 600"
            >
              {{ $t('trustedHosts.title') }}
            </h2>
            <span class="truncate font-mono text-text-4" style="font-size: 11.5px">{{ base }}</span>
          </div>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="$t('trustedHosts.close')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <div class="flex-1 overflow-y-auto" style="padding: 14px 18px">
          <div
            class="text-text-3"
            style="
              font-size: 11px;
              font-weight: 500;
              letter-spacing: 0.06em;
              text-transform: uppercase;
              margin-bottom: 6px;
            "
          >
            {{ $t('trustedHosts.builtInLabel') }}
          </div>
          <ul class="font-mono text-text-3" style="font-size: 11.5px; margin-bottom: 14px">
            <li v-for="h in BUILT_IN_TRUSTED_HOSTS" :key="h" style="padding: 2px 0">{{ h }}</li>
          </ul>

          <div
            class="text-text-3"
            style="
              font-size: 11px;
              font-weight: 500;
              letter-spacing: 0.06em;
              text-transform: uppercase;
              margin-bottom: 6px;
            "
          >
            {{ $t('trustedHosts.addedLabel') }}
          </div>
          <ul v-if="hosts.length > 0" data-testid="trusted-hosts-list" style="margin-bottom: 10px">
            <li
              v-for="h in hosts"
              :key="h"
              class="flex items-center justify-between font-mono text-text-2"
              style="font-size: 11.5px; padding: 2px 0"
            >
              <span class="truncate">{{ h }}</span>
              <button
                class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
                style="width: 18px; height: 18px"
                :aria-label="$t('trustedHosts.remove', { host: h })"
                @click="remove(h)"
              >
                <X :size="12" :stroke-width="1.5" />
              </button>
            </li>
          </ul>
          <p v-else class="text-text-4" style="font-size: 11.5px; margin-bottom: 10px">
            {{ $t('trustedHosts.none') }}
          </p>

          <div class="flex items-center" style="gap: 6px">
            <input
              ref="inputRef"
              v-model="draft"
              class="w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line"
              style="
                border-radius: 5px;
                padding: 8px 10px;
                font-size: 12px;
                outline: none;
                height: 32px;
              "
              type="text"
              autocomplete="off"
              spellcheck="false"
              :placeholder="$t('trustedHosts.placeholder')"
              data-testid="trusted-hosts-input"
              @keydown.enter.prevent="add()"
            />
            <button
              class="flex shrink-0 items-center border border-border bg-transparent text-text-2 transition hover:text-text"
              style="
                padding: 7px 12px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                height: 32px;
                gap: 6px;
              "
              :disabled="saving"
              data-testid="trusted-hosts-add"
              @click="add()"
            >
              <Plus :size="12" :stroke-width="1.7" />
              {{ $t('trustedHosts.add') }}
            </button>
          </div>
          <p
            v-if="errorKey"
            class="text-red"
            style="font-size: 11px; margin-top: 6px"
            role="alert"
            data-testid="trusted-hosts-error"
          >
            {{ $t(`trustedHosts.errors.${errorKey}`) }}
          </p>
          <p class="text-text-3" style="font-size: 11px; margin-top: 10px">
            {{ $t('trustedHosts.hint') }}
          </p>
        </div>

        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <button
            class="border border-border bg-transparent text-text-2 transition hover:text-text"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              height: 28px;
            "
            @click="close()"
          >
            {{ $t('trustedHosts.close') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
