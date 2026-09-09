<script lang="ts">
  import { themeMode, colorblind, type ColorblindType } from '$lib/stores/theme'
  import { t } from '$lib/i18n'
  import Icon from '$lib/components/ui/Icon.svelte'
</script>

<!-- Light / Dark toggle -->
<button
  type="button"
  onclick={() => themeMode.set($themeMode === 'dark' ? 'light' : 'dark')}
  aria-label={$themeMode === 'dark' ? $t('theme.light') : $t('theme.dark')}
  aria-pressed={$themeMode === 'dark'}
  title={$themeMode === 'dark' ? $t('theme.light') : $t('theme.dark')}
  class="flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
>
  <Icon name={$themeMode === 'dark' ? 'sun' : 'moon'} size={20} />
</button>

<!-- Colorblind mode selector -->
<label class="sr-only" for="colorblind-select">{$t('theme.colorblind')}</label>
<select
  id="colorblind-select"
  value={$colorblind}
  onchange={(e) => colorblind.set((e.currentTarget as HTMLSelectElement).value as ColorblindType)}
  class="h-9 rounded-lg border border-border bg-paper px-2 text-xs text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-hidden focus:ring-2 focus:ring-accent"
  title={$t('theme.cb.select')}
>
  <option value="none">{$t('theme.cb.none')}</option>
  <option value="rg">{$t('theme.cb.rg')}</option>
  <option value="by">{$t('theme.cb.by')}</option>
</select>
