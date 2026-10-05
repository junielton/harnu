<script setup lang="ts">
import { computed } from 'vue'
import changelogRaw from '../../../../CHANGELOG.md?raw'
import { parseChangelog } from './changelog-parse'

/**
 * Settings → Changelog tab. Renders the repo `CHANGELOG.md` (bundled at build via
 * `?raw`, parsed by the pure `changelog-parse.ts`) as dated releases. The file is
 * the source of truth required by the "Changelog is mandatory" contract in CLAUDE.md.
 */
const releases = computed(() => parseChangelog(changelogRaw))
</script>

<template>
  <div class="flex flex-col" style="gap: 18px">
    <section v-for="r in releases" :key="r.date">
      <div
        class="text-text-3"
        style="
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 8px;
        "
      >
        {{ r.date }}
      </div>
      <div v-for="g in r.groups" :key="g.category" style="margin-bottom: 8px">
        <div
          v-if="g.category"
          class="text-text-2"
          style="font-size: 12px; font-weight: 600; margin-bottom: 4px"
        >
          {{ g.category }}
        </div>
        <ul class="flex flex-col" style="gap: 4px">
          <li
            v-for="(item, i) in g.items"
            :key="i"
            class="text-text-3"
            style="font-size: 12px; line-height: 1.5; padding-left: 14px; position: relative"
          >
            <span class="text-text-4" aria-hidden="true" style="position: absolute; left: 2px"
              >·</span
            >
            {{ item }}
          </li>
        </ul>
      </div>
    </section>
    <div v-if="!releases.length" class="text-text-3" style="font-size: 12px">
      {{ $t('settings.changelog.empty') }}
    </div>
  </div>
</template>
