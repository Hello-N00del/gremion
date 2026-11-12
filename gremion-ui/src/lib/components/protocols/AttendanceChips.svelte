<script lang="ts">
  import Pill from '$lib/components/pills/Pill.svelte'

  interface AttendanceEntry {
    // Optional: the roster-merged list (org_unit_members ⟕ protocol_attendance)
    // carries no attendance-row id for members whose status has not been recorded
    // yet. Attendance identity is the member's user_id (the upsert key), not this.
    id?: string
    user_id: string
    status: 'present' | 'absent' | 'excused'
    displayName?: string
  }

  // `entries` is bindable: the quorum line next to the chips is derived from the
  // same list, so a saved click must reach the parent. A parent that does not
  // bind still gets correct chips (the assignment is then local to this
  // component).
  let { entries = $bindable(), isAdmin, protocolId }: {
    entries: AttendanceEntry[]
    isAdmin: boolean
    protocolId: string
  } = $props()

  // Status → Pill tone (pill-icon contract): present/absent carry the mandated
  // state glyph automatically; excused is neutral with an explicit one.
  // #343 R1: the Pill's contract icon is the sole state carrier — chip text is
  // the display name only (a `✓ Emma` doubled it, `✗ Emma` read like deletion).
  const TONE: Record<string, 'success' | 'danger' | 'neutral'> = {
    present: 'success',
    absent: 'danger',
    excused: 'neutral',
  }
  // German status words for the accessible name (screen readers and the
  // browser's accessibility tree read this, not the glyph).
  const STATUS_LABEL: Record<AttendanceEntry['status'], string> = {
    present: 'anwesend',
    absent: 'abwesend',
    excused: 'entschuldigt',
  }

  const SAVE_ERROR = 'Anwesenheit konnte nicht gespeichert werden — erneut versuchen.'
  let saveError = $state<string | null>(null)
  // user_ids with a save in flight: a second click before the answer would
  // compute its "next" status from the old one and cycle blind.
  let pending = $state<Record<string, true>>({})

  async function cycle(entry: AttendanceEntry) {
    if (!isAdmin || pending[entry.user_id]) return
    const order: AttendanceEntry['status'][] = ['present', 'absent', 'excused']
    const next = order[(order.indexOf(entry.status) + 1) % order.length]
    pending[entry.user_id] = true
    try {
      const res = await fetch(`/api/protocols/${protocolId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attendanceUpdate: { userId: entry.user_id, status: next } }),
      })
      if (!res.ok) {
        // Server kept the old value (e.g. protocol left draft, validation) —
        // do NOT flip the chip so the UI tracks the persisted state.
        saveError = SAVE_ERROR
        return
      }
      // Replace, not mutate: `entries` may be plain load data that is not
      // reactive, and a replaced list is what a bound parent observes.
      entries = entries.map((e) => (e.user_id === entry.user_id ? { ...e, status: next } : e))
      saveError = null
    } catch {
      saveError = SAVE_ERROR
    } finally {
      delete pending[entry.user_id]
    }
  }
</script>

<div class="flex flex-wrap gap-2">
  {#each entries as entry (entry.user_id)}
    <button
      type="button"
      onclick={() => cycle(entry)}
      class="cursor-default"
      class:cursor-pointer={isAdmin}
      aria-label="{entry.displayName ?? entry.user_id}: {STATUS_LABEL[entry.status]}"
    >
      <Pill tone={TONE[entry.status]} icon={entry.status === 'excused' ? 'info' : undefined}>
        {entry.displayName ?? entry.user_id}
      </Pill>
    </button>
  {/each}
</div>
{#if saveError}
  <p class="mt-1.5 text-xs text-rust-ink" role="alert">{saveError}</p>
{/if}
