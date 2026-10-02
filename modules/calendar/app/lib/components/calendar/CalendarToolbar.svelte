<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { calendarView, calendarDate } from '$lib/stores/calendar'

  interface Props {
    readonly: boolean
    onCreateEvent?: () => void
  }

  let { readonly, onCreateEvent }: Props = $props()

  function prevPeriod() {
    calendarDate.update((d) => {
      const n = new Date(d)
      if ($calendarView === 'month') n.setMonth(n.getMonth() - 1)
      else if ($calendarView === 'week') n.setDate(n.getDate() - 7)
      else n.setDate(n.getDate() - 7)
      return n
    })
  }

  function nextPeriod() {
    calendarDate.update((d) => {
      const n = new Date(d)
      if ($calendarView === 'month') n.setMonth(n.getMonth() + 1)
      else if ($calendarView === 'week') n.setDate(n.getDate() + 7)
      else n.setDate(n.getDate() + 7)
      return n
    })
  }

  function goToday() {
    calendarDate.set(new Date())
  }

  const VIEWS: Array<{ key: 'month' | 'week' | 'agenda'; label: string }> = [
    { key: 'month', label: 'Monat' },
    { key: 'week', label: 'Woche' },
    { key: 'agenda', label: 'Agenda' }
  ]
</script>

<div class="flex items-center gap-2 flex-wrap">
  <div class="flex items-center gap-1">
    <Button variant="ghost" size="sm" onclick={prevPeriod} aria-label="Zurück">‹</Button>
    <Button variant="ghost" size="sm" onclick={nextPeriod} aria-label="Weiter">›</Button>
    <Button variant="outline" size="sm" onclick={goToday}>Heute</Button>
  </div>

  <div class="flex rounded-md border overflow-hidden">
    {#each VIEWS as v (v.key)}
      <button
        class="px-3 py-1 text-sm {$calendarView === v.key ? 'bg-accent text-paper' : 'bg-paper hover:bg-surface-2'}"
        onclick={() => calendarView.set(v.key)}
      >
        {v.label}
      </button>
    {/each}
  </div>

  {#if !readonly}
    <Button size="sm" onclick={() => onCreateEvent?.()}>+ Termin erstellen</Button>
  {/if}
</div>
