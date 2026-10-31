<script lang="ts">
  import { t } from '$lib/i18n'
  import { fillText } from '$lib/modules/fill-text'
  import type { SwitchStateName } from '$lib/modules/switch-preview'

  // The post-switch notice of one module request. It states what the server recorded and nothing more:
  // a request that has not been applied never reads as "switched", and phase 1 never claims that a mail
  // went out (mailLine is for phase 2 and is shown only when a caller supplies it).
  let {
    moduleLabel,
    action,
    state,
    outcome = null,
    mailLine = null,
  }: {
    moduleLabel: string
    action: 'enable' | 'disable'
    state: SwitchStateName
    outcome?: string | null
    mailLine?: string | null
  } = $props()

  const running = $derived(state === 'queued' || state === 'succeeded' || state === 'applying')
  const failed = $derived(state === 'failed' || state === 'refused' || state === 'expired' || state === 'dead')
</script>

{#if failed}
  <div role="alert" class="rounded-md border border-rust/50 bg-rust-soft px-3 py-2 text-sm text-rust-ink">
    <p class="font-medium">{fillText($t('settings.modules.notice.failed'), { module: moduleLabel })}</p>
    <p class="mt-1">{outcome ?? $t('settings.modules.notice.failedNoReason')}</p>
  </div>
{:else if running}
  <p role="status" class="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink-muted">
    {$t('settings.modules.notice.running')}
  </p>
{:else}
  <div role="status" class="rounded-md border border-green-500/40 bg-green-50 px-3 py-2 text-sm text-green-800">
    <p>{fillText($t(action === 'enable' ? 'settings.modules.notice.on' : 'settings.modules.notice.off'), { module: moduleLabel })}</p>
    {#if mailLine}<p class="mt-1">{mailLine}</p>{/if}
  </div>
{/if}
