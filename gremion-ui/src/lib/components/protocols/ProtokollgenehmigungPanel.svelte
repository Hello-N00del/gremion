<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import Pill from '$lib/components/pills/Pill.svelte'

  interface PendingProtocol {
    id: string
    title: string
    meeting_date: string
    committee_id: string
    approval_poll_id: string | null
    status: string
  }

  let { protocol }: { protocol: PendingProtocol } = $props()

  const pollEmbedUrl = $derived(
    protocol.approval_poll_id
      ? `/polls/${protocol.approval_poll_id}`
      : null
  )
</script>

<div class="rounded-lg border border-amber-200 bg-amber-50/30 p-4 space-y-3">
  <div class="flex items-center justify-between">
    <h4 class="font-medium text-base">
      Genehmigung: {protocol.title}
    </h4>
    <Pill tone="warn">Eingereicht</Pill>
  </div>
  <p class="text-sm text-ink-muted">
    Sitzung vom {new Date(protocol.meeting_date).toLocaleDateString('de-DE')}
  </p>
  <div class="flex gap-2">
    <Button variant="outline" size="sm" href="/members/committees/{protocol.committee_id}/protokolle/{protocol.id}">
      Protokoll ansehen →
    </Button>
  </div>
  {#if pollEmbedUrl}
    <div class="rounded-md border bg-white overflow-hidden">
      <iframe
        src={pollEmbedUrl}
        title="Abstimmung: {protocol.title}"
        class="w-full h-48 border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
      ></iframe>
    </div>
    <p class="text-xs text-ink-muted">
      Mehrheit Ja (Nein-Stimmen &lt; Ja-Stimmen) → Protokoll kann veröffentlicht werden.
      Enthaltungen werden nicht gezählt.
    </p>
  {:else}
    <p class="text-sm text-ink-muted">Kein Abstimmungslink verknüpft.</p>
  {/if}
</div>
