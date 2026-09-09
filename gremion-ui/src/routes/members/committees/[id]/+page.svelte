<script lang="ts">
  import type { PageData } from './$types'
  import { invalidateAll, goto } from '$app/navigation'
  import { t } from '$lib/i18n'

  let { data }: { data: PageData } = $props()

  // ── Add-member panel state ─────────────────────────────────────────────────
  let showAddMember = $state(false)
  let memberSearch = $state('')
  let memberResults = $state<Array<{ id: string; name: string; email: string }>>([])
  let memberSearchLoading = $state(false)
  let memberAddError = $state('')

  async function searchUsers() {
    if (!memberSearch.trim()) { memberResults = []; return }
    memberSearchLoading = true
    memberAddError = ''
    try {
      const res = await fetch(`/api/users?search=${encodeURIComponent(memberSearch.trim())}&slim=true&max=10`)
      if (!res.ok) { memberAddError = `Suche fehlgeschlagen (${res.status})`; return }
      const body = await res.json()
      const existingIds = new Set(data.members.map((m) => m.user_keycloak_id))
      memberResults = (body.data ?? [])
        .filter((u: { id: string }) => !existingIds.has(u.id))
        .map((u: { id: string; email?: string; firstName?: string; lastName?: string; username?: string }) => ({
          id: u.id,
          email: u.email ?? '',
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || u.email || u.id,
        }))
    } finally {
      memberSearchLoading = false
    }
  }

  async function addMemberById(userKeycloakId: string) {
    memberAddError = ''
    const res = await fetch(`/api/governance/committees/${data.committee.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userKeycloakId, membershipType: newMemberType, termStart: null, termEnd: null }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      memberAddError = body?.error ?? `Fehler ${res.status}`
      return
    }
    memberResults = memberResults.filter((u) => u.id !== userKeycloakId)
    memberSearch = ''
    await invalidateAll()
  }

  // ── Member type selector ──────────────────────────────────────────────────
  let newMemberType = $state<'elected' | 'unelected' | 'employee'>('unelected')

  // ── Provisioning retry ────────────────────────────────────────────────────
  let retrying = $state(false)
  async function retryProvision() {
    retrying = true
    try {
      const res = await fetch(`/api/governance/committees/${data.committee.id}/provision`, { method: 'POST' })
      if (res.ok) await invalidateAll()
    } finally {
      retrying = false
    }
  }
  const hasFailed = $derived(data.resources.some((r) => r.status === 'failed'))

  // ── Delete committee ──────────────────────────────────────────────────────
  let deleteError = $state('')
  let removeError = $state('')
  let deleting = $state(false)
  let removingId = $state<string | null>(null)

  async function removeMember(memberId: string) {
    if (removingId) return
    removingId = memberId
    removeError = ''
    try {
      const res = await fetch(`/api/governance/committees/${data.committee.id}/members/${memberId}`, { method: 'DELETE' })
      if (res.ok) {
        await invalidateAll()
      } else {
        const body = await res.json().catch(() => ({}))
        removeError = body?.error ?? `Mitglied konnte nicht entfernt werden (${res.status})`
      }
    } catch {
      removeError = 'Verbindungsfehler. Bitte erneut versuchen.'
    } finally {
      removingId = null
    }
  }

  async function deleteCommittee() {
    if (!confirm(`Gremium „${data.committee.name}" wirklich löschen? Dies entfernt auch die zugehörige Keycloak-Gruppe.`)) return
    deleteError = ''
    deleting = true
    try {
      const res = await fetch(`/api/governance/committees/${data.committee.id}`, { method: 'DELETE' })
      if (res.status === 207) {
        const body = await res.json().catch(() => ({}))
        deleteError = body?.error ?? `Teilfehler beim Löschen (207)`
        return
      }
      if (res.ok) {
        await goto('/members')
        return
      }
      const body = await res.json().catch(() => ({}))
      deleteError = body?.error ?? `Löschen fehlgeschlagen (${res.status})`
    } catch {
      deleteError = 'Verbindungsfehler. Bitte erneut versuchen.'
    } finally {
      deleting = false
    }
  }

  // Build a combined roster: one row per role (with holder or vacant) + members without a role
  const rosterRows = $derived(() => {
    const assignedIds = new Set(
      data.roles
        .map((r) => r.currentAssignment?.user_keycloak_id)
        .filter((id): id is string => !!id)
    )

    const roleRows = data.roles.map((r) => ({
      type: 'role' as const,
      role: r.name,
      electionMethod: r.election_method,
      memberId: r.currentAssignment?.user_keycloak_id ?? null,
      displayName: r.currentAssignment?.displayName ?? null,
      endDate: r.currentAssignment?.end_date ?? null,
      status: r.currentAssignment?.status ?? null,
      vacant: !r.currentAssignment,
    }))

    const memberOnlyRows = data.members
      .filter((m) => !assignedIds.has(m.user_keycloak_id))
      .map((m) => ({
        type: 'member' as const,
        role: null,
        electionMethod: null,
        memberId: m.user_keycloak_id,
        displayName: m.displayName,
        endDate: null,
        status: null,
        vacant: false,
      }))

    return [...roleRows, ...memberOnlyRows]
  })
</script>

<div class="w-full">
  <!-- Header -->
  <div class="mb-5 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-semibold">{data.committee.name}</h1>
      {#if data.committee.description}
        <p class="text-sm text-ink-muted mt-1">{data.committee.description}</p>
      {/if}
    </div>
    {#if data.isAdmin}
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onclick={deleteCommittee}
          disabled={deleting}
          class="rounded-md border border-rust/40 px-3 py-1.5 text-xs font-medium text-rust hover:bg-rust-soft disabled:opacity-50"
          title="Löscht dieses Gremium (nur möglich, wenn keine Mitglieder mehr zugeordnet sind)"
        >
          {deleting ? 'Löscht…' : 'Gremium löschen'}
        </button>
      </div>
    {/if}
  </div>

  {#if data.isAdmin && data.resources.length > 0}
    <div class="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
      <span class="text-xs font-semibold uppercase text-ink-muted">Provisionierung</span>
      {#each data.resources as r (r.subsystem)}
        <span class="rounded px-2 py-0.5 text-xs font-medium
          {r.status === 'ok' ? 'bg-green-500/15 text-green-600'
           : r.status === 'failed' ? 'bg-rust-soft text-rust-ink'
           : 'bg-amber-500/15 text-amber-600'}"
          title={r.last_error ?? ''}>
          {r.subsystem}: {r.status}
        </span>
      {/each}
      {#if hasFailed}
        <button type="button" onclick={retryProvision} disabled={retrying}
          class="ml-auto rounded-md border px-3 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-50">
          {retrying ? 'Läuft…' : $t('governance.provision.retry')}
        </button>
      {/if}
    </div>
  {/if}

  {#if deleteError}
    <p class="mb-4 text-sm text-rust">{deleteError}</p>
  {/if}
  {#if removeError}
    <p class="mb-4 text-sm text-rust">{removeError}</p>
  {/if}

  <!-- ── Roster header + add-member toggle ─────────────────────────────────── -->
  {#if data.isAdmin}
    <div class="mb-3 flex items-center justify-between gap-3">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-ink-muted">Mitglieder & Ämter</h2>
      <button
        type="button"
        onclick={() => { showAddMember = !showAddMember; if (!showAddMember) { memberSearch = ''; memberResults = [] } }}
        class="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
      >
        {showAddMember ? '× Schließen' : '+ Mitglied hinzufügen'}
      </button>
    </div>

    {#if showAddMember}
      <div class="mb-4 rounded-xl border border-border bg-surface-2/20 p-4 space-y-3">
        <div class="flex gap-2">
          <input
            type="text"
            bind:value={memberSearch}
            placeholder="Name oder E-Mail suchen…"
            class="flex-1 rounded-md border border-border-strong bg-paper px-3 py-2 text-sm"
            onkeydown={(e) => e.key === 'Enter' && searchUsers()}
          />
          <select bind:value={newMemberType} class="rounded-md border border-border-strong bg-paper px-2 py-2 text-sm">
            <option value="unelected">{$t('governance.member.type.unelected')}</option>
            <option value="elected">{$t('governance.member.type.elected')}</option>
            <option value="employee">{$t('governance.member.type.employee')}</option>
          </select>
          <button
            type="button"
            onclick={searchUsers}
            disabled={memberSearchLoading}
            class="rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
          >
            {memberSearchLoading ? '…' : 'Suchen'}
          </button>
        </div>

        {#if memberAddError}
          <p class="text-xs text-rust">{memberAddError}</p>
        {/if}

        {#if memberResults.length > 0}
          <ul class="divide-y divide-border rounded-md border border-border bg-paper">
            {#each memberResults as r (r.id)}
              <li class="flex items-center justify-between gap-3 px-3 py-2">
                <div class="min-w-0">
                  <div class="text-sm font-medium truncate">{r.name}</div>
                  <div class="text-xs text-ink-muted truncate">{r.email || r.id}</div>
                </div>
                <button
                  type="button"
                  onclick={() => addMemberById(r.id)}
                  class="rounded-md border border-accent/40 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/10"
                >
                  + Hinzufügen
                </button>
              </li>
            {/each}
          </ul>
        {:else if memberSearch && !memberSearchLoading}
          <p class="text-xs text-ink-muted">Keine passenden Nutzer gefunden.</p>
        {/if}
      </div>
    {/if}
  {/if}

  <!-- ── Roster table (members + roles merged) ─────────────────────────────── -->
  <div class="rounded-xl border border-border overflow-hidden mb-6">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-border bg-surface-2/40">
          <th class="px-4 py-2.5 text-left font-medium text-ink-muted">{$t('members.col.name')}</th>
          <th class="px-4 py-2.5 text-left font-medium text-ink-muted">{$t('members.col.role')}</th>
          <th class="px-4 py-2.5 text-left font-medium text-ink-muted hidden sm:table-cell">{$t('members.col.until')}</th>
          {#if data.isAdmin}
            <th class="px-4 py-2.5 text-right font-medium text-ink-muted">{$t('members.col.actions')}</th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#each rosterRows() as row, i (i)}
          <tr class="border-b border-border last:border-0 {row.vacant ? 'opacity-50' : ''}">
            <!-- Name -->
            <td class="px-4 py-3">
              {#if row.vacant}
                <span class="italic text-ink-muted">{$t('members.role.vacant')}</span>
              {:else}
                <span class="font-medium">{row.displayName}</span>
              {/if}
            </td>

            <!-- Role -->
            <td class="px-4 py-3 text-ink-muted">
              {#if row.role}
                <span class="inline-flex items-center gap-1.5">
                  {row.role}
                  {#if row.status === 'grace'}
                    <span class="text-amber-500 text-xs">{$t('members.role.grace')}</span>
                  {/if}
                </span>
              {:else}
                <span class="text-ink-muted/50">—</span>
              {/if}
            </td>

            <!-- Until -->
            <td class="px-4 py-3 text-ink-muted hidden sm:table-cell">
              {#if row.endDate}
                {new Date(row.endDate).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}
              {:else}
                <span class="text-ink-muted/50">—</span>
              {/if}
            </td>

            <!-- Actions -->
            {#if data.isAdmin}
              <td class="px-4 py-3 text-right">
                {#if !row.vacant && row.memberId}
                  <button
                    class="text-xs text-rust hover:underline disabled:opacity-50"
                    disabled={removingId === row.memberId}
                    onclick={() => removeMember(row.memberId!)}
                  >{removingId === row.memberId ? '…' : $t('members.action.remove')}</button>
                {/if}
              </td>
            {/if}
          </tr>
        {/each}

        {#if rosterRows().length === 0}
          <tr>
            <td colspan="4" class="px-4 py-6 text-center text-sm text-ink-muted">
              {$t('members.empty.members')}
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>

  <!-- ── Protocol + Resolution quick links ────────────────────────────────── -->
  <div class="flex gap-2 mb-6">
    <a
      href="/members/committees/{data.committee.id}/protokolle"
      class="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
    >
      📋 Protokolle
    </a>
    <a
      href="/members/committees/{data.committee.id}/beschluesse"
      class="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
    >
      📜 Beschlüsse
    </a>
  </div>

  <!-- ── History ────────────────────────────────────────────────────────────── -->
  {#if data.history.length > 0}
    <div class="space-y-2">
      <h2 class="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-2">{$t('members.tab.history')}</h2>
      {#each data.history as entry (entry.id)}
        <div class="p-3 border border-border rounded-md text-xs flex gap-4">
          <span class="text-ink-muted shrink-0">
            {new Date(entry.created_at).toLocaleDateString('de-DE')}
          </span>
          <span>{entry.user_keycloak_id}</span>
          {#if entry.ended_reason}
            <span class="text-ink-muted capitalize ml-auto">{entry.ended_reason}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
