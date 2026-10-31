<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { t } from '$lib/i18n'
  import { confirmationMatches } from '$lib/modules/catalogue-map'
  import { fillText } from '$lib/modules/fill-text'
  import type { ModuleDeletionPreview } from '$lib/modules/switch-preview'

  // The red warning before a module is switched OFF: what is deleted, what is kept, how long the grace
  // period is, and a typed-name confirmation. The confirm button is a convenience: the server compares the
  // phrase again (NFC-exact, case-sensitive, no trimming) and queues nothing on a mismatch.
  //
  // Phase 1 never reaches the destructive path: graceDays is null, and then this renders a neutral notice
  // and NO confirm button, never a sentence that promises removal.
  let {
    preview,
    busy,
    error,
    onconfirm,
    oncancel,
  }: {
    preview: ModuleDeletionPreview
    busy: boolean
    error: string | null
    onconfirm: (typed: string) => void
    oncancel: () => void
  } = $props()

  const uid = $props.id()
  const titleId = `${uid}-title`
  const inputId = `${uid}-confirm`

  let typed = $state('')
  const available = $derived(preview.graceDays !== null)
  const matches = $derived(confirmationMatches(typed, preview.confirmPhrase))
</script>

<div
  role="alertdialog"
  aria-labelledby={titleId}
  class="space-y-4 rounded-lg border border-rust/50 bg-rust-soft p-4 text-rust-ink"
>
  <h3 id={titleId} class="text-base font-semibold text-rust">
    {fillText($t('settings.modules.warn.title'), { module: preview.moduleLabel })}
  </h3>

  {#if !available}
    <p class="text-sm">{$t('settings.modules.warn.notYet')}</p>
    <div class="flex justify-end">
      <Button variant="outline" onclick={oncancel}>{$t('settings.modules.warn.close')}</Button>
    </div>
  {:else}
    <div class="space-y-1">
      <p class="text-sm font-medium">{$t('settings.modules.warn.deletes')}</p>
      <ul class="list-disc space-y-0.5 pl-5 text-sm">
        {#each preview.deletes as item (item.key)}
          <li>
            {item.label}:
            {item.count === null ? $t('settings.modules.warn.allData') : `${item.count} ${item.unit}`.trim()}
          </li>
        {/each}
      </ul>
    </div>

    <p class="text-sm">
      {fillText($t('settings.modules.warn.grace'), { days: preview.graceDays ?? 0 })}
      {#if preview.finalDeletionAt}
        {fillText($t('settings.modules.warn.final'), { date: preview.finalDeletionAt })}
      {/if}
      {#if preview.recoverable}
        {$t('settings.modules.warn.recoverable')}
      {/if}
    </p>

    {#if preview.retained.length > 0}
      <div class="space-y-1">
        <p class="text-sm font-medium">{$t('settings.modules.warn.retained')}</p>
        <ul class="list-disc space-y-0.5 pl-5 text-sm">
          {#each preview.retained as item (item.key)}
            <li>{item.label} ({item.basis})</li>
          {/each}
        </ul>
      </div>
    {/if}

    <div class="space-y-1">
      <Label for={inputId}>{fillText($t('settings.modules.warn.inputLabel'), { module: preview.confirmPhrase })}</Label>
      <Input id={inputId} bind:value={typed} autocomplete="off" spellcheck={false} />
    </div>

    {#if error}
      <p role="alert" class="text-sm font-medium text-rust">{error}</p>
    {/if}

    <div class="flex justify-end gap-2">
      <Button variant="outline" onclick={oncancel}>{$t('settings.modules.warn.cancel')}</Button>
      <Button variant="destructive" disabled={busy || !matches} onclick={() => onconfirm(typed)}>
        {$t('settings.modules.warn.confirm')}
      </Button>
    </div>
  {/if}
</div>
