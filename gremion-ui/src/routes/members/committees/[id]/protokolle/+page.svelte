<script lang="ts">
  import type { PageData } from './$types'
  import { Button } from '$lib/components/ui/button'
  import Pill from '$lib/components/pills/Pill.svelte'
  import { hasRole, Role } from '$lib/auth'
  import { page } from '$app/stores'

  let { data }: { data: PageData } = $props()

  const user = $derived($page.data.user)
  const isAdmin = $derived(user && hasRole(user.roles, Role.CouncilAdmin))

  const STATUS_LABELS: Record<string, string> = {
    draft: 'Entwurf',
    submitted: 'Eingereicht',
    published: 'Veröffentlicht',
  }
  // Status → Pill tone (pill-icon contract): submitted/published carry the
  // mandated state glyph automatically; draft is neutral with an explicit one.
  const STATUS_TONES: Record<string, 'neutral' | 'warn' | 'success'> = {
    draft: 'neutral',
    submitted: 'warn',
    published: 'success',
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold">Protokolle</h2>
    {#if isAdmin}
      <Button href="protokolle/new">+ Neues Protokoll</Button>
    {/if}
  </div>

  {#if data.protocols.length === 0}
    <p class="text-ink-muted text-sm">Noch keine Protokolle vorhanden.</p>
  {:else}
    <div class="divide-y rounded-md border">
      {#each data.protocols as protocol}
        <a href="protokolle/{protocol.id}" class="flex items-center justify-between px-4 py-3 hover:bg-surface-2 transition-colors">
          <div>
            <div class="font-medium">{protocol.title}</div>
            <div class="text-ink-muted text-sm">
              {new Date(protocol.meeting_date).toLocaleDateString('de-DE')}
              {#if protocol.location} · {protocol.location}{/if}
            </div>
          </div>
          <Pill
            tone={STATUS_TONES[protocol.status]}
            icon={protocol.status === 'draft' ? 'edit' : undefined}
          >
            {STATUS_LABELS[protocol.status]}
          </Pill>
        </a>
      {/each}
    </div>
  {/if}
</div>
