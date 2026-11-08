<script lang="ts">
  import { lang, t } from '$lib/i18n'
  import { formatDate } from '$lib/i18n/format'
  import { fillText } from '$lib/modules/fill-text'

  // The sealed retained copies of an earlier period of a module, shown READ-ONLY on the module's page after
  // a fresh start (Module Karenz phase 2, spec goal 10). A copy outlives the module's data: it is written
  // at switch-off and the final deletion never touches it. So this is a list and downloads, nothing else:
  // no edit control, no delete control, no form. Everything shown comes from the records themselves
  // (title, sealed date, line count); the download link is the role-gated, audited, redacted route.
  // The page loader only hands a list to readers who may see it, and an empty list renders nothing.
  let {
    records = [],
    moduleLabel,
  }: {
    // `labelKey` is the message key of the record's title (the list route also carries the German text as `label`).
    // The list defaults to empty: a page whose data has no `retainedRecords` key renders nothing instead of throwing.
    records?: { id: string; label: string; labelKey: string; createdAt: string; lineCount: number; href: string }[]
    moduleLabel: string
  } = $props()

  const uid = $props.id()
  const titleId = `${uid}-title`

  const titleOf = (record: { labelKey: string }) => $t(record.labelKey)
  const sealedOn = (iso: string) => formatDate(iso, $lang)
  const linesText = (n: number) => (n === 1 ? $t('settings.modules.karenz.retained.lines.one') : fillText($t('settings.modules.karenz.retained.lines.other'), { count: n }))
</script>

{#if records.length > 0}
  <section aria-labelledby={titleId} class="space-y-3 rounded-lg border border-border bg-surface-2 p-4">
    <div class="space-y-1">
      <h2 id={titleId} class="text-base font-semibold">{fillText($t('settings.modules.karenz.retained.title'), { module: moduleLabel })}</h2>
      <p class="text-sm text-ink-muted">{$t('settings.modules.karenz.retained.intro')}</p>
    </div>
    <ul class="divide-y divide-border text-sm">
      {#each records as record (record.id)}
        <li class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
          <div>
            <span class="font-medium">{titleOf(record)}</span>
            <span class="text-ink-muted"> · {fillText($t('settings.modules.karenz.retained.sealed'), { date: sealedOn(record.createdAt) })} · {linesText(record.lineCount)}</span>
          </div>
          <a
            href={record.href}
            class="underline underline-offset-2"
            aria-label={fillText($t('settings.modules.karenz.retained.downloadLabel'), { label: titleOf(record), date: sealedOn(record.createdAt) })}
          >{$t('settings.modules.karenz.retained.download')}</a>
        </li>
      {/each}
    </ul>
  </section>
{/if}
