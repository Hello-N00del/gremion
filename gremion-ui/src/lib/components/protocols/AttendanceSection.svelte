<script lang="ts">
  import AttendanceChips from './AttendanceChips.svelte'

  interface AttendanceEntry {
    id?: string
    user_id: string
    status: 'present' | 'absent' | 'excused'
    displayName?: string
  }

  // The roster arrives from the page load; the chips own the saved status and
  // hand it back through the bindings, so the quorum line below is derived from
  // what the server has persisted (a failed save never reaches the list).
  let { attendance, advisoryAttendance, isAdmin, protocolId }: {
    attendance: AttendanceEntry[]
    advisoryAttendance: AttendanceEntry[]
    isAdmin: boolean
    protocolId: string
  } = $props()

  // `attendance` / `advisoryAttendance` seed the local lists; later load data
  // (a reload) remounts the page, so the initial value is the right capture.
  // svelte-ignore state_referenced_locally
  let voting = $state<AttendanceEntry[]>(attendance)
  // svelte-ignore state_referenced_locally
  let advisory = $state<AttendanceEntry[]>(advisoryAttendance)

  // INV-5 quorum (preset rule): a strict majority of eligible VOTING members
  // must be present. Mirrors getQuorumContext's `present*2 > eligible`; advisory
  // (non-voting) members never count. The server re-checks on publish.
  const eligible = $derived(voting.length)
  const present = $derived(voting.filter((e) => e.status === 'present').length)
  const quorate = $derived(eligible > 0 && present * 2 > eligible)
</script>

<section id="anwesenheit" class="space-y-2">
  <div class="flex flex-wrap items-center gap-2">
    <h3 class="font-medium">Anwesenheit</h3>
    <!-- (2) quorum pill — strict majority of eligible voting members present. -->
    <span
      class="rounded-full px-2 py-0.5 text-xs font-medium {quorate
        ? 'bg-green-100 text-green-800'
        : 'bg-red-100 text-red-800'}"
    >
      {quorate ? `Beschlussfähig ${present}/${eligible}` : 'Nicht beschlussfähig'}
    </span>
  </div>
  <AttendanceChips bind:entries={voting} {isAdmin} {protocolId} />
  {#if advisory.length > 0}
    <div class="text-xs text-ink-muted pt-1">beratend (nicht stimmberechtigt)</div>
    <AttendanceChips bind:entries={advisory} {isAdmin} {protocolId} />
  {/if}
</section>
