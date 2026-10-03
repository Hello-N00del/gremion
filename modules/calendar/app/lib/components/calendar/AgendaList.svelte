<script lang="ts">
  import { calendarEvents, type CalendarViewEvent } from '$lib/stores/calendar'

  interface Props {
    onEventClick?: (event: CalendarViewEvent) => void
  }

  let { onEventClick }: Props = $props()

  function groupByDate(events: CalendarViewEvent[]): Map<string, CalendarViewEvent[]> {
    const sorted = [...events].sort((a, b) => a.dtstart.getTime() - b.dtstart.getTime())
    const groups = new Map<string, CalendarViewEvent[]>()
    for (const ev of sorted) {
      const key = ev.dtstart.toDateString()
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(ev)
    }
    return groups
  }

  function formatTime(d: Date, allDay: boolean): string {
    if (allDay) return 'Ganztägig'
    return new Intl.DateTimeFormat('de-DE', {
      timeStyle: 'short',
      timeZone: 'Europe/Berlin',
    }).format(d)
  }

  function formatDateHeading(d: Date): string {
    return new Intl.DateTimeFormat('de-DE', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d)
  }
</script>

<div class="space-y-4">
  {#each [...groupByDate($calendarEvents).entries()] as [dateStr, dayEvents] (dateStr)}
    <div>
      <h3 class="text-sm font-semibold text-ink-muted mb-2">
        {formatDateHeading(dayEvents[0].dtstart)}
      </h3>
      <div class="space-y-1">
        {#each dayEvents as ev (ev.id)}
          <button
            class="w-full text-left rounded-md border px-3 py-2 hover:bg-surface-2 space-y-0.5 flex items-center gap-3"
            onclick={() => onEventClick?.(ev)}
          >
            <span
              class="h-8 w-1.5 shrink-0 rounded-sm"
              style="background: linear-gradient(180deg, {ev.colour.primary} 0%, {ev.colour.primary} 50%, {ev.colour.secondary} 50%, {ev.colour.secondary} 100%)"
              aria-hidden="true"
            ></span>
            <div class="flex-1 space-y-0.5">
              <div class="font-medium text-sm">{ev.title}</div>
              <div class="text-xs text-ink-muted">
                {formatTime(ev.dtstart, ev.allDay)}
                {#if ev.eventTypeName} · {ev.eventTypeName}{/if}
                {#if ev.readOnly}
                  · <span class="italic">nur lesbar</span>
                {/if}
              </div>
            </div>
          </button>
        {/each}
      </div>
    </div>
  {:else}
    <p class="text-sm text-ink-muted">Keine Termine in diesem Zeitraum.</p>
  {/each}
</div>
