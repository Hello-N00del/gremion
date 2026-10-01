<script lang="ts">
  import type { PageData } from './$types'
  import Pill from '$lib/components/pills/Pill.svelte'

  let { data }: { data: PageData } = $props()

  // F1-FIX-10-K / K2#5: the "CSV Export" button is gone. It requested
  // ?format=csv, which the API ignores (it answers JSON), so it saved JSON under
  // a .csv name and hid every failure. It returns together with a real text/csv
  // branch (escaping + formula-injection guard) in the API.

  const TYPE_LABELS: Record<string, string> = {
    beschluss: 'Beschluss',
    poll: 'Umfrage',
    election: 'Wahl',
  }
</script>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h2 class="text-xl font-semibold">Beschlussregister</h2>
  </div>

  {#if data.entries.length === 0}
    <p class="text-ink-muted text-sm">Noch keine Beschlüsse vorhanden.</p>
  {:else}
    <div class="rounded-md border overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-surface-2/50">
          <tr>
            <th class="px-3 py-2 text-left font-medium">Nr.</th>
            <th class="px-3 py-2 text-left font-medium">Typ</th>
            <th class="px-3 py-2 text-left font-medium">Beschluss</th>
            <th class="px-3 py-2 text-left font-medium">Datum</th>
            <th class="px-3 py-2 text-left font-medium">Ergebnis</th>
            <th class="px-3 py-2 text-left font-medium">Link</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          {#each data.entries as entry}
            <tr class="hover:bg-surface-2/30">
              <td class="px-3 py-2 font-mono text-xs">{entry.global_nr ?? '—'}</td>
              <td class="px-3 py-2">
                <Pill>{TYPE_LABELS[entry.type] ?? entry.type}</Pill>
              </td>
              <td class="px-3 py-2 max-w-sm truncate">{entry.text}</td>
              <td class="px-3 py-2 whitespace-nowrap">
                {entry.meeting_date ? new Date(entry.meeting_date).toLocaleDateString('de-DE') : '—'}
              </td>
              <td class="px-3 py-2">
                {#if entry.result === 'passed'}
                  <span class="text-green-700 font-medium">✓ Angenommen</span>
                {:else if entry.result === 'rejected'}
                  <span class="text-red-700">✗ Abgelehnt</span>
                {:else}
                  <span class="text-ink-muted">{entry.result}</span>
                {/if}
              </td>
              <td class="px-3 py-2">
                {#if entry.protocol_id}
                  <a href="/members/committees/{data.committeeId}/protokolle/{entry.protocol_id}"
                    class="text-accent hover:underline text-xs">Protokoll →</a>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
