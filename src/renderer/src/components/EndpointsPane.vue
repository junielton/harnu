<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Trash2, Server } from 'lucide-vue-next'
import { useClaudeBootStore } from '../stores/claudeBoot'
import type { EndpointProfile } from '../../../preload'

/**
 * Settings → Endpoints tab (local-provider-endpoints spec, D3). The GLOBAL
 * registry editor for custom Anthropic-compatible endpoints (e.g. a local model
 * in LM Studio). Definitions live here; the per-folder / per-session dialogs only
 * *reference* one via the provider picker. Editing writes through the claudeBoot
 * store (`saveEndpoint` / `deleteEndpoint` → IPC → `claude-boot.json#endpoints`).
 *
 * No "Test connection" yet (O-2 runtime unknowns) — the row's hint explains the
 * outage-fallback intent and that a local model is a resilience play, not Opus.
 */

const boot = useClaudeBootStore()
const { t } = useI18n()

const endpoints = computed(() => boot.endpoints)

// Draft for the "add endpoint" row. A blank baseUrl is rejected by the main
// process, so Add stays disabled until one is typed.
const draft = ref<Partial<EndpointProfile>>({})
const canAdd = computed(() => !!draft.value.baseUrl?.trim())

async function add(): Promise<void> {
  if (!canAdd.value) return
  await boot.saveEndpoint({ ...draft.value })
  draft.value = {}
}

// Inline edits debounce a write-through per endpoint id.
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
function patch(ep: EndpointProfile, key: keyof EndpointProfile, value: string): void {
  const next = { ...ep, [key]: value }
  const existing = saveTimers.get(ep.id)
  if (existing) clearTimeout(existing)
  saveTimers.set(
    ep.id,
    setTimeout(() => {
      saveTimers.delete(ep.id)
      void boot.saveEndpoint(next)
    }, 250)
  )
}

async function remove(id: string): Promise<void> {
  await boot.deleteEndpoint(id)
}
</script>

<template>
  <div>
    <p class="text-text-3" style="font-size: 11px; line-height: 1.5; margin-bottom: 14px">
      {{ t('endpoints.intro') }}
    </p>

    <!-- Existing endpoints -->
    <section v-if="endpoints.length" style="margin-bottom: 18px">
      <div
        class="text-text-3"
        style="
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 10px;
        "
      >
        {{ t('endpoints.savedEyebrow') }}
      </div>
      <div
        v-for="ep in endpoints"
        :key="ep.id"
        class="border border-border bg-bg"
        style="border-radius: 7px; padding: 12px; margin-bottom: 10px"
      >
        <div class="flex items-center justify-between" style="gap: 8px; margin-bottom: 10px">
          <div class="flex min-w-0 items-center text-text-2" style="gap: 6px; font-size: 12px">
            <Server :size="13" :stroke-width="1.7" class="shrink-0 text-text-3" />
            <span class="truncate">{{ ep.name || ep.baseUrl }}</span>
          </div>
          <button
            type="button"
            class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-red"
            style="width: 24px; height: 24px"
            :aria-label="t('endpoints.remove')"
            :title="t('endpoints.remove')"
            @click="remove(ep.id)"
          >
            <Trash2 :size="13" :stroke-width="1.6" />
          </button>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
          <label class="text-text-3" style="font-size: 11px">
            {{ t('endpoints.fields.name') }}
            <input
              :value="ep.name"
              type="text"
              spellcheck="false"
              class="mt-1 w-full border border-border bg-bg text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
              @input="patch(ep, 'name', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="text-text-3" style="font-size: 11px">
            {{ t('endpoints.fields.model') }}
            <input
              :value="ep.model ?? ''"
              type="text"
              spellcheck="false"
              :placeholder="t('endpoints.fields.modelPlaceholder')"
              class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
              @input="patch(ep, 'model', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="text-text-3" style="font-size: 11px; grid-column: 1 / -1">
            {{ t('endpoints.fields.baseUrl') }}
            <input
              :value="ep.baseUrl"
              type="text"
              spellcheck="false"
              class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
              @input="patch(ep, 'baseUrl', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="text-text-3" style="font-size: 11px; grid-column: 1 / -1">
            {{ t('endpoints.fields.authToken') }}
            <input
              :value="ep.authToken ?? ''"
              type="password"
              spellcheck="false"
              autocomplete="off"
              :placeholder="t('endpoints.fields.authTokenPlaceholder')"
              class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
              @input="patch(ep, 'authToken', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
      </div>
    </section>

    <!-- Add a new endpoint -->
    <section>
      <div
        class="text-text-3"
        style="
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 10px;
        "
      >
        {{ t('endpoints.addEyebrow') }}
      </div>
      <div class="border border-border bg-bg" style="border-radius: 7px; padding: 12px">
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
          <label class="text-text-3" style="font-size: 11px">
            {{ t('endpoints.fields.name') }}
            <input
              v-model.trim="draft.name"
              type="text"
              spellcheck="false"
              :placeholder="t('endpoints.fields.namePlaceholder')"
              class="mt-1 w-full border border-border bg-bg text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            />
          </label>
          <label class="text-text-3" style="font-size: 11px">
            {{ t('endpoints.fields.model') }}
            <input
              v-model.trim="draft.model"
              type="text"
              spellcheck="false"
              :placeholder="t('endpoints.fields.modelPlaceholder')"
              class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            />
          </label>
          <label class="text-text-3" style="font-size: 11px; grid-column: 1 / -1">
            {{ t('endpoints.fields.baseUrl') }}
            <input
              v-model.trim="draft.baseUrl"
              type="text"
              spellcheck="false"
              :placeholder="t('endpoints.fields.baseUrlPlaceholder')"
              class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            />
          </label>
          <label class="text-text-3" style="font-size: 11px; grid-column: 1 / -1">
            {{ t('endpoints.fields.authToken') }}
            <input
              v-model.trim="draft.authToken"
              type="password"
              spellcheck="false"
              autocomplete="off"
              :placeholder="t('endpoints.fields.authTokenPlaceholder')"
              class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            />
          </label>
        </div>
        <div class="flex justify-end" style="margin-top: 12px">
          <button
            type="button"
            class="flex items-center bg-accent text-accent-ink transition disabled:opacity-40"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              height: 28px;
              border: none;
              gap: 6px;
            "
            :disabled="!canAdd"
            @click="add()"
          >
            <Plus :size="13" :stroke-width="2" />
            {{ t('endpoints.add') }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
