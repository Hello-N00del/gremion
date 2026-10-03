<script lang="ts">
  import { calendarEvents, calendarDate, type CalendarViewEvent } from '$lib/stores/calendar'
  import { deriveHue } from '$lib/governance/committee-color'

  interface Props {
    readonly: boolean
    onEventClick?: (event: CalendarViewEvent) => void
    onDayClick?: (date: Date) => void
  }

  let { readonly, onEventClick, onDayClick }: Props = $props()

  // D5 (design v11): the legend promises "Balken = Gremium". An event tagged to
  // exactly ONE committee takes its gutter colour from the committee hue — the
  // SAME deriveHue + hsl(h 55% 45%) formula the filter chips and the org tree
  // use — so the bar visually matches its chip. Multi-committee events keep the
  // server's sharedEventColor and committee-less events the type colour
  // (primary === secondary): both stay ev.colour.primary.
  function gutterColour(ev: CalendarViewEvent): string {
    return ev.committeeIds.length === 1
      ? `hsl(${deriveHue(ev.committeeIds[0]!)} 55% 45%)`
      : ev.colour.primary
  }

  const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

  function getCells(anchor: Date): Date[] {
    const year = anchor.getFullYear()
    const month = anchor.getMonth()
    const firstDay = new Date(year, month, 1)
    const startDow = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1 // Monday start
    const cells: Date[] = []
    for (let i = -startDow; i < 42 - startDow; i++) {
      cells.push(new Date(year, month, 1 + i))
    }
    return cells
  }

  function eventsOnDay(day: Date): CalendarViewEvent[] {
    return $calendarEvents.filter((e) => {
      const d = new Date(e.dtstart)
      return (
        d.getFullYear() === day.getFullYear() &&
        d.getMonth() === day.getMonth() &&
        d.getDate() === day.getDate()
      )
    })
  }

  function isToday(d: Date): boolean {
    const t = new Date()
    return (
      d.getFullYear() === t.getFullYear() &&
      d.getMonth() === t.getMonth() &&
      d.getDate() === t.getDate()
    )
  }

  function isCurrentMonth(d: Date, anchor: Date): boolean {
    return d.getMonth() === anchor.getMonth()
  }
</script>

<div class="cal-grid">
  {#each WEEKDAYS as day (day)}
    <div class="cal-hd">{day}</div>
  {/each}
  {#each getCells($calendarDate) as cell (cell.toISOString())}
    {@const dayEvents = eventsOnDay(cell)}
    {@const holidays = dayEvents.filter((e) => e.source === 'holiday')}
    {@const others = dayEvents.filter((e) => e.source !== 'holiday')}
    {@const overflow = others.length > 3}
    <div class="cal-cell" class:other={!isCurrentMonth(cell, $calendarDate)} class:today={isToday(cell)}>
      {#if holidays.length > 0}
        <div
          class="cal-holiday"
          style="background: {holidays[0].colour.primary}20; color: {holidays[0].colour.primary}"
          title={holidays.map((h) => h.title).join(', ')}
        >
          {holidays[0].title}
        </div>
      {/if}
      <div class="cal-cell-head">
        <button class="cal-daynum" onclick={() => !readonly && onDayClick?.(cell)}>
          {cell.getDate()}
        </button>
      </div>
      <div class="cal-events">
        {#each others.slice(0, 3) as ev (ev.id)}
          <button class="cal-ev" onclick={() => onEventClick?.(ev)}>
            <span class="cal-ev-gutter" style="background: {gutterColour(ev)};"></span>
            <span class="cal-ev-title" style="background: {ev.colour.secondary}20;">{ev.title}</span>
          </button>
        {/each}
        {#if overflow}
          <div class="cal-more">+{others.length - 3} weitere</div>
        {/if}
      </div>
    </div>
  {/each}
</div>

<style>
  /* Month grid rethemed against shared design tokens (bundle web/tokens.css
     §cal-grid). The event body keeps ev.colour.secondary from the calendar
     store; the gutter bar prefers the committee org-hue (see gutterColour, D5)
     and falls back to ev.colour.primary. All values resolve to tokens so
     .dark auto-switches. */
  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    overflow: hidden;
  }
  .cal-hd {
    background: var(--surface-2);
    padding: 8px 12px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink-muted);
    font-weight: 500;
  }
  .cal-cell {
    background: var(--surface);
    padding: 8px 8px 6px;
    min-height: 104px;
    position: relative;
  }
  .cal-cell.other {
    background: var(--surface-2);
  }
  .cal-cell.other .cal-daynum {
    color: var(--ink-faint);
  }
  .cal-cell.today {
    background: var(--accent-faint);
  }
  .cal-cell-head {
    display: flex;
    justify-content: flex-end;
  }
  .cal-daynum {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
    border: none;
    background: transparent;
    border-radius: var(--r-xs);
    padding: 1px 6px;
    cursor: pointer;
    transition: background var(--d-fast);
  }
  .cal-daynum:hover {
    background: var(--surface-3);
  }
  .cal-cell.today .cal-daynum {
    background: var(--accent);
    /* #343 R5: `--on-accent` already resolves to dark ink in dark mode, so the
       hand-rolled `:global(.dark)` override this replaced is now dead. */
    color: var(--on-accent);
    font-weight: 500;
  }
  .cal-holiday {
    margin-bottom: 4px;
    border-radius: var(--r-xs);
    padding: 1px 5px;
    font-size: 10px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cal-events {
    margin-top: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .cal-ev {
    display: grid;
    grid-template-columns: 4px 1fr;
    align-items: stretch;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    border-radius: var(--r-xs);
    overflow: hidden;
    cursor: pointer;
    min-height: 18px;
  }
  .cal-ev-gutter {
    border-radius: var(--r-xs) 0 0 var(--r-xs);
  }
  .cal-ev-title {
    padding: 2px 6px;
    font-size: 11px;
    font-weight: 500;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cal-ev:hover .cal-ev-title {
    background: var(--surface-2) !important;
  }
  .cal-more {
    font-size: 11px;
    color: var(--ink-muted);
    padding-left: 4px;
  }
</style>
