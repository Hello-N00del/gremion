<script lang="ts">
  import type { PageData } from './$types'
  import type { ProtocolActionItem } from '$lib/server/protocols/protocol-db'

  interface ResolutionLike {
    id?: string
    sequence_nr: number
    global_nr?: string | null
    text: string
    votes_yes: number
    votes_no: number
    votes_abstain: number
    result: 'passed' | 'rejected' | 'withdrawn'
    required_majority: 'simple' | 'two_thirds' | 'absolute'
  }
  import { hasRole, Role } from '$lib/auth'
  import { page } from '$app/stores'
  import { Button } from '$lib/components/ui/button'
  import Pill from '$lib/components/pills/Pill.svelte'
  import AttendanceChips from '$lib/components/protocols/AttendanceChips.svelte'
  import ResolutionRow from '$lib/components/protocols/ResolutionRow.svelte'
  import ActionItemRow from '$lib/components/protocols/ActionItemRow.svelte'
  import ProtokollgenehmigungPanel from '$lib/components/protocols/ProtokollgenehmigungPanel.svelte'

  let { data }: { data: PageData } = $props()

  const user = $derived($page.data.user)
  const isAdmin = $derived(user && hasRole(user.roles, Role.CouncilAdmin))
  const isEditable = $derived(data.protocol.status === 'draft')

  const STATUS_LABELS: Record<string, string> = {
    draft: 'Entwurf', submitted: 'Eingereicht', published: 'Veröffentlicht',
  }
  // Status → Pill tone (pill-icon contract): submitted/published carry the
  // mandated state glyph automatically; draft is neutral with an explicit one.
  const STATUS_TONES: Record<string, 'neutral' | 'warn' | 'success'> = {
    draft: 'neutral', submitted: 'warn', published: 'success',
  }

  let resolutions = $state<ResolutionLike[]>(data.resolutions)
  let actionItems = $state<ProtocolActionItem[]>(data.actionItems)
  // (4) the real 422 body from a blocked publish, surfaced inline (not alert()).
  let publishError = $state<string | null>(null)

  async function addResolution() {
    // INV-5: pick the decision rule up front (default simple) and let the SERVER
    // compute the result — the client never sends a free-hand `result`.
    const res = await fetch(`/api/protocols/${data.protocol.id}/resolutions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '', votesYes: 0, votesNo: 0, votesAbstain: 0, requiredMajority: 'simple' }),
    })
    if (res.ok) {
      resolutions = [...resolutions, (await res.json()).resolution]
    } else {
      alert('Beschluss konnte nicht hinzugefügt werden.')
    }
  }

  async function saveResolution(r: ResolutionLike) {
    const res = await fetch(`/api/protocols/${data.protocol.id}/resolutions/${r.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(r),
    })
    if (res.ok) {
      // (5) reflect the SERVER's authoritative row back into the list so a
      // 'withdrawn' save immediately shows 'Zurückgezogen' (and the recomputed
      // result replaces any stale display value) without a full reload.
      const saved = (await res.json()).resolution as ResolutionLike
      resolutions = resolutions.map((x) => (x.id === saved.id ? saved : x))
    } else {
      alert('Beschluss konnte nicht gespeichert werden.')
    }
  }

  async function deleteResolution(id: string) {
    const res = await fetch(`/api/protocols/${data.protocol.id}/resolutions/${id}`, { method: 'DELETE' })
    if (res.ok) {
      resolutions = resolutions.filter((r) => r.id !== id)
    } else {
      alert('Beschluss konnte nicht gelöscht werden.')
    }
  }

  async function addActionItem() {
    const res = await fetch(`/api/protocols/${data.protocol.id}/action-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    })
    if (res.ok) {
      actionItems = [...actionItems, (await res.json()).actionItem]
    } else {
      alert('Aufgabe konnte nicht hinzugefügt werden.')
    }
  }

  async function submitForVote() {
    const res = await fetch(`/api/protocols/${data.protocol.id}/submit`, { method: 'POST' })
    if (res.ok) {
      location.reload()
    } else {
      alert('Einreichung zur Abstimmung fehlgeschlagen: ' + (await res.text()))
    }
  }

  async function publish() {
    publishError = null
    const res = await fetch(`/api/protocols/${data.protocol.id}/publish`, { method: 'POST' })
    if (res.ok) {
      location.reload()
      return
    }
    // (4) surface the REAL server body inline (e.g. the 422 "Nicht beschlussfähig:
    // X/Y …" quorum message) as an actionable banner, not a modal alert(). The
    // SvelteKit error helper serialises the message as JSON { message }; fall back
    // to the raw text for any non-JSON error body.
    const raw = await res.text()
    let message = raw
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.message === 'string') message = parsed.message
    } catch {
      // non-JSON body — keep the raw text
    }
    publishError = message || 'Veröffentlichung fehlgeschlagen.'
  }

  function scrollToAttendance() {
    document.getElementById('anwesenheit')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
</script>

<div class="space-y-6 max-w-4xl">
  <div class="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 bg-surface-2/30">
    <div>
      <div class="font-semibold">{data.protocol.title}</div>
      <div class="text-sm text-ink-muted">
        {new Date(data.protocol.meeting_date).toLocaleDateString('de-DE')}
        {#if data.protocol.location} · {data.protocol.location}{/if}
      </div>
    </div>
    <!-- Pill has no class passthrough: the ml-auto flex-item role moves to a wrapper span. -->
    <span class="ml-auto"><Pill
      tone={STATUS_TONES[data.protocol.status]}
      icon={data.protocol.status === 'draft' ? 'edit' : undefined}
    >{STATUS_LABELS[data.protocol.status]}</Pill></span>
    {#if isAdmin && isEditable}
      <label class="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={data.protocol.guest_edit_enabled}
          onchange={async (e) => {
            const target = e.target as HTMLInputElement
            const res = await fetch(`/api/protocols/${data.protocol.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ guestEditEnabled: target.checked }),
            })
            if (!res.ok) {
              alert('Gastbearbeitung konnte nicht geändert werden.')
              target.checked = !target.checked
            }
          }}
        />
        Gastbearbeitung erlaubt
      </label>
    {/if}
  </div>

  <section id="anwesenheit" class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <h3 class="font-medium">Anwesenheit</h3>
      <!-- (2) quorum pill — strict majority of eligible voting members present. -->
      <span
        class="rounded-full px-2 py-0.5 text-xs font-medium {data.quorum.quorate
          ? 'bg-green-100 text-green-800'
          : 'bg-red-100 text-red-800'}"
      >
        {data.quorum.quorate
          ? `Beschlussfähig ${data.quorum.presentVotingCount}/${data.quorum.eligibleVotingCount}`
          : 'Nicht beschlussfähig'}
      </span>
    </div>
    <AttendanceChips entries={data.attendance} isAdmin={(isAdmin && isEditable) ?? false} protocolId={data.protocol.id} />
    {#if data.advisoryAttendance.length > 0}
      <div class="text-xs text-ink-muted pt-1">beratend (nicht stimmberechtigt)</div>
      <AttendanceChips
        entries={data.advisoryAttendance}
        isAdmin={(isAdmin && isEditable) ?? false}
        protocolId={data.protocol.id}
      />
    {/if}
  </section>

  <section class="space-y-2">
    <h3 class="font-medium">Protokollinhalt</h3>
    {#if isEditable && data.wopiToken}
      <iframe
        src="{data.wopiToken.editorUrl}&lang=de&closebutton=1"
        title="Protokoll bearbeiten"
        class="w-full h-[500px] rounded-md border"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation"
      ></iframe>
    {:else}
      <div class="rounded-md border p-4 prose prose-sm max-w-none">
        {@html data.protocol.body_html ?? '<em>Noch kein Inhalt.</em>'}
      </div>
    {/if}
  </section>

  <section class="space-y-2">
    <h3 class="font-medium">Beschlüsse</h3>
    <div class="space-y-2">
      {#each resolutions as resolution (resolution.id)}
        <ResolutionRow
          {resolution}
          isAdmin={isAdmin && isEditable}
          protocolId={data.protocol.id}
          eligibleVotingCount={data.quorum.eligibleVotingCount}
          onSave={saveResolution}
          onDelete={deleteResolution}
        />
      {/each}
    </div>
    {#if isAdmin && isEditable}
      <Button variant="outline" size="sm" onclick={addResolution}>+ Beschluss hinzufügen</Button>
    {/if}
  </section>

  <section class="space-y-2">
    <h3 class="font-medium">Aufgaben</h3>
    <div class="space-y-2">
      {#each actionItems as item (item.id)}
        <ActionItemRow
          {item}
          isAdmin={isAdmin && isEditable}
          onSave={async (i) => {
            const res = await fetch(`/api/protocols/${data.protocol.id}/action-items/${i.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(i),
            })
            if (!res.ok) alert('Aufgabe konnte nicht gespeichert werden.')
          }}
          onToggle={async (id, completed) => {
            const res = await fetch(`/api/protocols/${data.protocol.id}/action-items/${id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ completed }),
            })
            if (res.ok) {
              // Reflect the persisted state locally so the checkbox + line-through
              // track the server (ActionItemRow renders from the `completed` prop).
              actionItems = actionItems.map((x) => (x.id === id ? { ...x, completed } : x))
            } else {
              alert('Status konnte nicht geändert werden.')
            }
          }}
        />
      {/each}
    </div>
    {#if isAdmin && isEditable}
      <Button variant="outline" size="sm" onclick={addActionItem}>+ Aufgabe hinzufügen</Button>
    {/if}
  </section>

  {#if data.pendingApprovals.length > 0}
    <section class="space-y-2">
      <h3 class="font-medium">Protokollgenehmigung</h3>
      {#each data.pendingApprovals as pending}
        <ProtokollgenehmigungPanel protocol={pending} />
      {/each}
    </section>
  {/if}

  {#if isAdmin}
    {#if publishError}
      <!-- (4) inline, actionable 422 banner — the real server quorum body, with a
           scroll affordance to where the admin fixes it, instead of an alert(). -->
      <div class="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">
        <div class="font-medium">Veröffentlichung blockiert</div>
        <p class="mt-1">{publishError}</p>
        <div class="mt-2">
          <Button size="sm" variant="outline" onclick={scrollToAttendance}>Anwesenheit erfassen</Button>
        </div>
      </div>
    {/if}
    <div class="flex gap-2 pt-2 border-t">
      {#if data.protocol.status === 'draft'}
        <Button onclick={submitForVote}>Zur Abstimmung einreichen</Button>
      {/if}
      {#if data.protocol.status === 'submitted'}
        <Button onclick={publish}>Veröffentlichen</Button>
      {/if}
    </div>
  {/if}
</div>
