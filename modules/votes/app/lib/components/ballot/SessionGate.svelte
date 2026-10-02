<script lang="ts">
  import type { SessionState } from '$lib/client/helios-voter-session.svelte'
  import { Button } from '$lib/components/ui/button'

  interface Props {
    state: SessionState
    oidcLoginUrl: string
    children: import('svelte').Snippet
  }
  let { state, oidcLoginUrl, children }: Props = $props()
</script>

{#if state === 'checking'}
  <div class="flex flex-col items-center gap-3 py-12 text-ink-muted" aria-busy="true">
    <div class="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" role="status"></div>
    <p class="text-sm">Sitzung wird überprüft…</p>
  </div>
{:else if state === 'needed'}
  <div class="rounded-lg border border-border bg-surface p-6 text-center space-y-4">
    <p class="text-sm text-ink-muted">
      Deine Keycloak-Sitzung ist abgelaufen. Melde dich erneut an, um abzustimmen.
    </p>
    <Button href={oidcLoginUrl}>Erneut anmelden</Button>
  </div>
{:else}
  {@render children()}
{/if}
