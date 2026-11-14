<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import type { ProtocolActionItem } from '$lib/server/protocols/protocol-db'
  import { resolutionPatchBody } from '$lib/governance/resolution-patch-body'
  import { isUntalliedResolution, UNTALLIED_RESOLUTION_CODE } from '$lib/governance/resolution-vote-state'

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
  import AttendanceSection from '$lib/components/protocols/AttendanceSection.svelte'
  import ResolutionRow from '$lib/components/protocols/ResolutionRow.svelte'
  import ActionItemRow from '$lib/components/protocols/ActionItemRow.svelte'
  import { protocolBodyMode } from '$lib/governance/protocol-body-mode'
  import ProtocolBodyEditor from '$lib/components/protocols/ProtocolBodyEditor.svelte'
  import ProtokollgenehmigungPanel from '$lib/components/protocols/ProtokollgenehmigungPanel.svelte'

  let { data }: { data: PageData } = $props()

  const user = $derived($page.data.user)
  const isAdmin = $derived(user && hasRole(user.roles, Role.CouncilAdmin))
  const isEditable = $derived(data.protocol.status === 'draft')
  const bodyMode = $derived(protocolBodyMode({
    isEditable,
    isAdmin: Boolean(isAdmin),
    hasWopiToken: Boolean(data.wopiToken),
    hasDraftDocument: Boolean(data.protocol.hasDraftDocument),
  }))

  const STATUS_LABELS: Record<string, string> = {
    draft: 'Entwurf', submitted: 'Eingereicht', published: 'Veröffentlicht',
  }
  // Status → Pill tone (pill-icon contract): submitted/published carry the
  // mandated state glyph automatically; draft is neutral with an explicit one.
  const STATUS_TONES: Record<string, 'neutral' | 'warn' | 'success'> = {
    draft: 'neutral', submitted: 'warn', published: 'success',
  }

  let resolutions = $state<ResolutionLike[]>(data.resolutions)
  // Resolutions are edited in the draft. One exception: a submitted protocol that
  // still holds a resolution nobody voted on cannot be published, so the admin
  // must be able to enter that count, withdraw the resolution or delete it. The
  // resolution API accepts the edit until the protocol is published.
  const canEditResolution = (r: ResolutionLike) =>
    Boolean(isAdmin) && (isEditable || (data.protocol.status === 'submitted' && isUntalliedResolution(r)))
  let actionItems = $state<ProtocolActionItem[]>(data.actionItems)
  // (4) the real 422 body from a blocked publish, surfaced inline (not alert()).
  let publishError = $state<string | null>(null)
  // The refusal's machine-readable reason, when the server names one: the
  // attendance shortcut only helps against a missing quorum.
  let publishErrorCode = $state<string | null>(null)
  // The server's refusal of a submit (e.g. a resolution without a vote), inline.
  let submitError = $state<string | null>(null)

  // The message (and reason code) of a refused request. The SvelteKit error
  // helper serialises { message, code? }, the submit route answers { error };
  // any other body is shown as it is.
  async function refusalOf(res: Response): Promise<{ message: string; code: string | null }> {
    const raw = await res.text()
    try {
      const parsed = JSON.parse(raw)
      const message =
        typeof parsed?.message === 'string' ? parsed.message : typeof parsed?.error === 'string' ? parsed.error : raw
      return { message, code: typeof parsed?.code === 'string' ? parsed.code : null }
    } catch {
      return { message: raw, code: null }
    }
  }

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
    // INV-5: never the whole row — the route refuses a free-hand result (400).
    const res = await fetch(`/api/protocols/${data.protocol.id}/resolutions/${r.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resolutionPatchBody(r)),
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
    submitError = null
    const res = await fetch(`/api/protocols/${data.protocol.id}/submit`, { method: 'POST' })
    if (res.ok) {
      location.reload()
      return
    }
    submitError = (await refusalOf(res)).message || 'Einreichung zur Abstimmung fehlgeschlagen.'
  }

  async function publish() {
    publishError = null
    publishErrorCode = null
    const res = await fetch(`/api/protocols/${data.protocol.id}/publish`, { method: 'POST' })
    if (res.ok) {
      location.reload()
      return
    }
    // (4) surface the REAL server body inline (e.g. the 422 "Nicht beschlussfähig:
    // X/Y …" quorum message) as an actionable banner, not a modal alert().
    const refusal = await refusalOf(res)
    publishError = refusal.message || 'Veröffentlichung fehlgeschlagen.'
    publishErrorCode = refusal.code
  }

  function scrollToAttendance() {
    document.getElementById('anwesenheit')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
</script>

<PageTitle title={`${data.protocol.title || 'Protokoll'} – ${data.committee.name}`} />

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
          aria-label="Gastbearbeitung erlaubt"
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

  <!-- Chips + quorum pill live in one component so a saved click moves both
       without a reload (finding 3). -->
  <AttendanceSection
    attendance={data.attendance}
    advisoryAttendance={data.advisoryAttendance}
    isAdmin={(isAdmin && isEditable) ?? false}
    protocolId={data.protocol.id}
  />

  <section class="space-y-2">
    <h3 class="font-medium">Protokollinhalt</h3>
    {#if bodyMode === 'collabora' && data.wopiToken}
      <iframe
        src="{data.wopiToken.editorUrl}&lang=de&closebutton=1"
        title="Protokoll bearbeiten"
        class="w-full h-[500px] rounded-md border"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation"
      ></iframe>
    {:else if bodyMode === 'unavailable'}
      <p role="alert" class="rounded-md border p-4 text-sm">
        Editor nicht erreichbar. Der Protokolltext liegt als Dokument vor und kann derzeit nicht bearbeitet werden. Bitte später erneut versuchen.
      </p>
    {:else if bodyMode === 'in-app'}
      <!-- R33b: no Collabora editor (files module off, or no ODT) -> in-app body editor. -->
      <ProtocolBodyEditor protocolId={data.protocol.id} bodyHtml={data.protocol.body_html} />
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
          isAdmin={canEditResolution(resolution)}
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
        {#if publishErrorCode !== UNTALLIED_RESOLUTION_CODE}
          <!-- Recording attendance does not help a resolution without a vote. -->
          <div class="mt-2">
            <Button size="sm" variant="outline" onclick={scrollToAttendance}>Anwesenheit erfassen</Button>
          </div>
        {/if}
      </div>
    {/if}
    {#if submitError}
      <div class="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800" role="alert">
        <div class="font-medium">Einreichung nicht möglich</div>
        <p class="mt-1">{submitError}</p>
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
