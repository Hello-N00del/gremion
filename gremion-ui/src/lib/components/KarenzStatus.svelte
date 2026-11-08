<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { lang, t } from '$lib/i18n'
  import { formatDate } from '$lib/i18n/format'
  import { fillText } from '$lib/modules/fill-text'
  import type { KarenzView } from '$lib/modules/switch-preview'

  // The 30 days of a module that is switched off: how many are left, the restore button, what went wrong,
  // the sealed copies as downloads and the way to the backup. Everything comes from the server's KarenzView;
  // the view carries counts, step names and ids, never the person who switched the module off, so none of
  // that can show up here. Problems are listed in role="alert": a failure is never a quiet grey line.
  let {
    karenz,
    busy,
    error = null,
    onrestore,
  }: {
    karenz: KarenzView
    busy: boolean
    error?: string | null
    onrestore: () => void
  } = $props()

  const finalDate = $derived(formatDate(karenz.finalAt, $lang))
  const clock = $derived(
    karenz.daysLeft === 0
      ? fillText($t('settings.modules.karenz.today'), { date: finalDate })
      : karenz.daysLeft === 1
        ? fillText($t('settings.modules.karenz.daysLeft.one'), { date: finalDate })
        : fillText($t('settings.modules.karenz.daysLeft'), { days: karenz.daysLeft, date: finalDate }),
  )
  const skipped = $derived(karenz.mail?.skippedHolders ?? 0)
</script>

<div class="space-y-3 rounded-md border border-border bg-surface-2 p-3 text-sm" data-testid="karenz-status">
  {#if karenz.state === 'finalizing'}
    <p role="status" class="font-medium">{$t('settings.modules.karenz.finalizing')}</p>
  {:else if karenz.state === 'restoring'}
    <p role="status" class="font-medium">{$t('settings.modules.karenz.restoring')}</p>
  {:else}
    <p class="font-medium">{clock}</p>
  {/if}

  {#if karenz.canRestore}
    <div class="flex flex-wrap items-center gap-3">
      <Button disabled={busy} onclick={onrestore}>{$t('settings.modules.karenz.restore')}</Button>
      <span class="text-xs text-ink-muted">{$t('settings.modules.karenz.restore.hint')}</span>
    </div>
  {/if}

  {#if skipped > 0}
    <p class="text-xs text-ink-muted">{skipped === 1 ? $t('settings.modules.karenz.mail.skipped.one') : fillText($t('settings.modules.karenz.mail.skipped'), { count: skipped })}</p>
  {/if}

  {#if karenz.problems.length > 0 || error}
    <div role="alert" class="space-y-1 rounded-md border border-rust/50 bg-rust-soft px-3 py-2 text-rust-ink">
      {#if karenz.problems.length > 0}
        <p class="font-medium">{$t('settings.modules.karenz.problems')}</p>
        <ul class="list-disc space-y-0.5 pl-5">
          {#each karenz.problems as problem (problem)}
            <li>{problem}</li>
          {/each}
        </ul>
      {/if}
      {#if error}
        <p class="font-medium">{error}</p>
      {/if}
    </div>
  {/if}

  {#if karenz.retained.length > 0}
    <div class="space-y-1">
      <p class="font-medium">{$t('settings.modules.karenz.retained')}</p>
      <ul class="space-y-0.5">
        {#each karenz.retained as copy (copy.id)}
          <li>
            <a class="underline underline-offset-2" href={copy.href} download>
              {copy.label} ({fillText($t('settings.modules.karenz.retained.lines'), { count: copy.lineCount })})
            </a>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <p class="text-xs text-ink-muted">
    <a class="underline underline-offset-2" href={karenz.backupHref}>{$t('settings.modules.karenz.backup')}</a>
    · {$t('settings.modules.karenz.backup.hint')}
  </p>
</div>
