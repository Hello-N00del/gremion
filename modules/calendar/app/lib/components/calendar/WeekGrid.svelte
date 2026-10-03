<script lang="ts">
  import {
    calendarEvents,
    calendarDate,
    type CalendarViewEvent,
  } from '$lib/stores/calendar'

  interface Props {
    onEventClick?: (event: CalendarViewEvent) => void
  }

  let { onEventClick }: Props = $props()

  const HOURS = Array.from({ length: 24 }, (_, i) => i)

  function getWeekDays(anchor: Date): Date[] {
    const day = anchor.getDay()
    const diff = day === 0 ? -6 : 1 - day
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(anchor)
      d.setDate(anchor.getDate() + diff + i)
      d.setHours(0, 0, 0, 0)
      return d
    })
  }

  function allDayEvents(): CalendarViewEvent[] {
    return $calendarEvents.filter((e) => e.allDay)
  }

  function eventsOnDay(day: Date): CalendarViewEvent[] {
    return $calendarEvents.filter((e) => {
      if (e.allDay) return false
      const d = new Date(e.dtstart)
      return (
        d.getFullYear() === day.getFullYear() &&
        d.getMonth() === day.getMonth() &&
        d.getDate() === day.getDate()
      )
    })
  }

  function topPct(ev: CalendarViewEvent): string {
    const h = ev.dtstart.getHours() + ev.dtstart.getMinutes() / 60
    return ((h / 24) * 100).toFixed(2) + '%'
  }

  function heightPct(ev: CalendarViewEvent): string {
    const diff = (ev.dtend.getTime() - ev.dtstart.getTime()) / 3600000
    return ((Math.max(diff, 0.25) / 24) * 100).toFixed(2) + '%'
  }

  function gradient(ev: CalendarViewEvent): string {
    return `linear-gradient(90deg, ${ev.colour.primary} 0%, ${ev.colour.primary} 50%, ${ev.colour.secondary} 50%, ${ev.colour.secondary} 100%)`
  }
</script>

<div class="w-full overflow-x-auto">
  {#if allDayEvents().length > 0}
    <div class="flex border-b">
      <div class="w-12 shrink-0"></div>
      <div class="flex-1 flex gap-1 p-1 flex-wrap">
        <!-- F1-FIX-08 (S1c#12): the API expands a recurring series into occurrences
             that share the series id; this row lists the whole fetched window, so
             the key includes the start (per-day lists below stay keyed by id). -->
        {#each allDayEvents() as ev (`${ev.id}@${ev.dtstart.getTime()}`)}
          <button
            class="rounded px-1 text-xs text-white truncate max-w-[160px]"
            style="background: {gradient(ev)}"
            onclick={() => onEventClick?.(ev)}
          >{ev.title}</button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="flex">
    <div class="w-12 shrink-0 relative" style="height: {HOURS.length * 48}px">
      {#each HOURS as h (h)}
        <div class="absolute right-1 text-[10px] text-ink-muted" style="top: {h * 48}px">
          {String(h).padStart(2, '0')}:00
        </div>
      {/each}
    </div>

    {#each getWeekDays($calendarDate) as day (day.toISOString())}
      <div class="flex-1 border-l relative" style="height: {HOURS.length * 48}px; min-width: 80px">
        <div class="text-[10px] text-center font-medium py-0.5 border-b sticky top-0 bg-paper">
          {new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric' }).format(day)}
        </div>
        {#each HOURS as _ (_)}
          <div class="border-b" style="height: 48px"></div>
        {/each}
        {#each eventsOnDay(day) as ev (ev.id)}
          <button
            class="absolute left-0 right-0 mx-0.5 rounded overflow-hidden px-1 text-[10px] text-white"
            style="top: calc(24px + {topPct(ev)}); height: max(24px, {heightPct(ev)}); background: {gradient(ev)}"
            onclick={() => onEventClick?.(ev)}
          >
            {ev.title}
          </button>
        {/each}
      </div>
    {/each}
  </div>
</div>
