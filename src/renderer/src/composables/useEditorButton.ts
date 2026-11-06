import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '../stores/settings'
import { editorDisplayName, effectiveEditorSetting } from '../../../main/editor-launch'

/**
 * What the "Open in {editor}" buttons (Topbar, Folder View) show for the editor
 * configured in Settings (T581): its id (picks the mark), its display name, and
 * the localized label used as tooltip and `aria-label`. A custom command has no
 * brand to name, so it reads the generic "editor".
 */
export interface EditorButton {
  editorId: ComputedRef<string>
  editorName: ComputedRef<string>
  label: ComputedRef<string>
}

export function useEditorButton(): EditorButton {
  const settings = useSettingsStore()
  const { t } = useI18n()
  const effective = computed(() => effectiveEditorSetting(settings.editor))
  const editorId = computed(() => effective.value.id)
  const editorName = computed(() => editorDisplayName(effective.value) ?? t('topbar.editorGeneric'))
  const label = computed(() => t('topbar.openInEditor', { editor: editorName.value }))
  return { editorId, editorName, label }
}
