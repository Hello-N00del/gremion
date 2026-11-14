<script lang="ts">
  import { t } from '$lib/i18n'
  import type { OperatorModuleItem } from '$lib/modules/switch-preview'

  // The modules the customer has that the council cannot switch (content, files, messaging, publishing, the
  // board). They are the operator's: listed with their state and NO control, so there is no dead button and no
  // switch the server would refuse. The server lists only modules that are on, so the state reads "on".
  let { modules }: { modules: readonly OperatorModuleItem[] } = $props()
</script>

{#if modules.length > 0}
  <ul class="space-y-3" aria-label={$t('settings.modules.operator.list')}>
    {#each modules as m (m.moduleId)}
      <li class="space-y-1 rounded-lg border border-border p-4" data-module={m.moduleId} data-managed-by="operator">
        <h3 class="text-sm font-semibold">{m.label}</h3>
        <p class="text-xs text-ink-muted">
          <span>{$t('settings.modules.state.on')}</span>
          ·
          <span>{$t('settings.modules.operator.managed')}</span>
        </p>
        <p class="text-xs text-ink-muted">{$t('settings.modules.operator.hint')}</p>
      </li>
    {/each}
  </ul>
{/if}
