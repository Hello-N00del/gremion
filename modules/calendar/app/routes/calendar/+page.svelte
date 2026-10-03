<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import type { PageData } from './$types'
  import { onMount } from 'svelte'
  import { page } from '$app/state'
  import { Role } from '$lib/auth'
  import { termFor } from '$lib/terms'
  import {
    calendarView,
    visibleRange,
    calendarDate,
    calendarFilter,
    loadEvents,
    type CalendarViewEvent,
  } from '$lib/stores/calendar'
  import CalendarToolbar from '$lib/components/calendar/CalendarToolbar.svelte'
  import MonthGrid from '$lib/components/calendar/MonthGrid.svelte'
  import WeekGrid from '$lib/components/calendar/WeekGrid.svelte'
  import AgendaList from '$lib/components/calendar/AgendaList.svelte'
  import EventDetailDialog from '$lib/components/calendar/EventDetailDialog.svelte'
  import CreateEventDialog from '$lib/components/calendar/CreateEventDialog.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'

  let { data }: { data: PageData } = $props()

  const readonly = $derived(
    data.user?.roles?.length === 1 && data.user.roles[0] === Role.Guest,
  )

  let selectedEvent = $state<CalendarViewEvent | null>(null)
  let showCreateDialog = $state(false)
  let createPrefillDate = $state<Date | undefined>(undefined)
  let loading = $state(true)
  let onlyMine = $state(false)

  const committees = $derived(data.committees)

  // #289 (HANDOVER-v8 Part F): re-term the committee nouns from the active
  // tenant's term-map (page.data.terms). StuRa tenant #1 → literal fallbacks.
  const terms = $derived(
    (page.data as { terms?: Record<string, string> | null }).terms ?? undefined,
  )
  const gremienPlural = $derived(termFor(terms, 'gremien', 'Gremien'))
  // Singular falls back to the tenant's plural term (consistent vocab), then the
  // literal; tenant #1 (no terms) stays "Gremium".
  const gremiumSingular = $derived(termFor(terms, 'gremienSingular', termFor(terms, 'gremien', 'Gremium')))

  // v4 page-head: eyebrow tracks the calendar's anchor month so it stays in
  // sync as the user navigates (prototype hardcodes "April 2026").
  const monthLabel = $derived(
    $calendarDate.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }),
  )

  // Meeting-type legend is driven by data.eventTypes (server-loaded from the
  // event_types table) so each swatch is the exact colour the calendar paints
  // an event of that type — no separate hand-maintained colour map to drift.
  const eventTypes = $derived(data.eventTypes ?? [])

  // Committee filter is single-select and drives the shared calendarFilter
  // store directly (committeeId | null) — the same field loadEvents() reads and
  // the onMount subscription mirrors to the URL. Clicking the active chip (or
  // "Alle") clears it. No parallel local state to drift out of sync.
  function setCommittee(id: string | null) {
    calendarFilter.update((f) => ({ ...f, committeeId: id }))
  }

  let unsubRange: (() => void) | null = null
  let unsubFilter: (() => void) | null = null
  onMount(() => {
    const url = new URL(window.location.href)
    calendarFilter.set({
      committeeId: url.searchParams.get('committeeId'),
      eventTypeId: url.searchParams.get('eventTypeId'),
    })

    unsubRange = visibleRange.subscribe(async ({ from, to }) => {
      loading = true
      await loadEvents(from, to)
      loading = false
    })
    unsubFilter = calendarFilter.subscribe(async (f) => {
      const u = new URL(window.location.href)
      if (f.committeeId) u.searchParams.set('committeeId', f.committeeId)
      else u.searchParams.delete('committeeId')
      if (f.eventTypeId) u.searchParams.set('eventTypeId', f.eventTypeId)
      else u.searchParams.delete('eventTypeId')
      window.history.replaceState({}, '', u.toString())
      const { from, to } = $visibleRange
      await loadEvents(from, to)
    })

    return () => {
      unsubRange?.()
      unsubFilter?.()
    }
  })

  function handleDayClick(date: Date) {
    if (readonly) return
    createPrefillDate = date
    showCreateDialog = true
  }
</script>

<PageTitle title="Kalender" />

<div class="cal-page">
  <!-- v4 page-head -->
  <header class="cal-page-head">
    <div class="eyebrow">Kalender · {monthLabel}</div>
    <h1 class="display cal-title">Was läuft in deinen {gremienPlural}</h1>
  </header>

  <!-- Committee filter strip -->
  <div class="card cal-filter-strip">
    <div class="eyebrow cal-filter-label">{gremienPlural}</div>

    <div class="cal-chips" role="group" aria-label={gremienPlural}>
      <button
        type="button"
        onclick={() => setCommittee(null)}
        class="com-chip"
        class:active={$calendarFilter.committeeId === null}
        aria-pressed={$calendarFilter.committeeId === null}
      >
        Alle
      </button>
      {#each committees as c}
        {@const active = $calendarFilter.committeeId === c.key}
        {@const hidden = onlyMine && !c.mine}
        {#if !hidden}
          <button
            type="button"
            onclick={() => setCommittee(active ? null : c.key)}
            class="com-chip"
            class:active
            style="--c-hue: {c.hue};"
            aria-pressed={active}
            title={c.label}
          >
            <span class="com-chip-tile" aria-hidden="true"></span>
            <span class="com-chip-name">{c.label}</span>
            {#if c.mine}<span class="com-chip-mine" title="Dein {gremiumSingular}"></span>{/if}
          </button>
        {/if}
      {/each}
    </div>

    <!-- Nur meine toggle -->
    <div class="cal-filter-divider"></div>
    <button
      type="button"
      onclick={() => (onlyMine = !onlyMine)}
      class="com-chip cal-mine-toggle"
      class:active={onlyMine}
      aria-pressed={onlyMine}
    >
      <Icon name="check" size={11} />
      <span>Nur meine</span>
    </button>
  </div>

  <!-- Meeting-type legend — swatch fill === the event body fill the calendar
       paints for that type (event_types.color). The committee shows separately
       as the event's left gutter bar (legended by the Gremien chips above). -->
  {#if eventTypes.length}
    <div class="cal-legend">
      <span class="eyebrow">Termin-Art</span>
      {#each eventTypes as t (t.id)}
        <div class="cal-legend-item">
          <span class="cal-legend-swatch" style="background: {t.color};"></span>
          <span class="cal-legend-label">{t.name}</span>
        </div>
      {/each}
      <span class="cal-legend-key">Balken = {gremiumSingular}</span>
    </div>
  {/if}

  <!-- Calendar toolbar (view switcher + nav + create button) -->
  <CalendarToolbar
    {readonly}
    onCreateEvent={() => {
      createPrefillDate = undefined
      showCreateDialog = true
    }}
  />

  {#if loading}
    <div class="cal-loading">
      <Icon name="refresh" size={15} class="animate-spin" />
      Lade Kalender…
    </div>
  {:else if $calendarView === 'month'}
    <MonthGrid
      {readonly}
      onEventClick={(ev) => (selectedEvent = ev)}
      onDayClick={handleDayClick}
    />
  {:else if $calendarView === 'week'}
    <WeekGrid onEventClick={(ev) => (selectedEvent = ev)} />
  {:else}
    <AgendaList onEventClick={(ev) => (selectedEvent = ev)} />
  {/if}
</div>

<EventDetailDialog
  event={selectedEvent}
  {readonly}
  onClose={() => (selectedEvent = null)}
  onDeleted={async () => {
    const { from, to } = $visibleRange
    await loadEvents(from, to)
  }}
/>

<CreateEventDialog
  open={showCreateDialog}
  prefillDate={createPrefillDate}
  onClose={() => (showCreateDialog = false)}
/>

<style>
  /* Calendar chrome rethemed against shared tokens. The MonthGrid/WeekGrid/
     AgendaList views and the entire data layer (calendar stores, loadEvents)
     are untouched. The committee filter chips previously referenced an
     undefined `.committee-chip` class (unstyled) — they now use the bundle's
     `com-chip` monogram-gutter aesthetic. All values resolve to design tokens
     so .dark auto-switches. */

  .cal-page {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .cal-page-head {
    margin-bottom: 2px;
  }
  .cal-title {
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-top: 4px;
  }

  .cal-filter-strip {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 10px 12px;
  }
  .cal-filter-label {
    flex-shrink: 0;
    margin-right: 2px;
  }
  .cal-chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    flex: 1 1 auto;
    min-width: 0;
  }
  .cal-filter-divider {
    width: 1px;
    height: 20px;
    background: var(--border);
    flex-shrink: 0;
  }

  /* Committee filter chip — readable name + org-hue tile (OrgTree --c formula:
     hsl(hue 55% 45%) / --on-c #fff), single-select. */
  .com-chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 28px;
    padding: 3px 11px 3px 9px;
    border-radius: 100px;
    background: var(--surface);
    border: 1px solid var(--border);
    font-size: 11.5px;
    color: var(--ink-2);
    cursor: pointer;
    transition: all var(--d-fast);
    user-select: none;
    --c: hsl(var(--c-hue, 252) 55% 45%);
    --on-c: #fff;
  }
  .com-chip:hover {
    background: var(--surface-2);
    border-color: var(--border-strong);
  }
  .com-chip-tile {
    width: 12px;
    height: 12px;
    border-radius: 4px;
    background: var(--c);
    flex-shrink: 0;
  }
  .com-chip-name {
    white-space: nowrap;
  }
  .com-chip-mine {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--ink);
    flex-shrink: 0;
  }
  .cal-mine-toggle {
    padding: 3px 12px 3px 9px;
  }
  .com-chip.active {
    border-color: var(--ink);
    background: var(--ink);
    color: var(--paper);
  }
  .com-chip.active .com-chip-tile {
    box-shadow: 0 0 0 1.5px var(--paper);
  }
  :global(.dark) .com-chip.active {
    color: #0e0f10;
  }
  :global(.dark) .com-chip.active .com-chip-tile {
    box-shadow: 0 0 0 1.5px #0e0f10;
  }

  .cal-legend {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .cal-legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .cal-legend-swatch {
    width: 12px;
    height: 12px;
    border-radius: 3px;
  }
  .cal-legend-label {
    font-size: 11.5px;
    color: var(--ink-muted);
  }
  /* Committee-gutter key, set off from the type swatches by a leading divider. */
  .cal-legend-key {
    font-size: 11px;
    color: var(--ink-faint);
    padding-left: 14px;
    border-left: 1px solid var(--border);
  }

  .cal-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 32px 0;
    font-size: 13px;
    color: var(--ink-muted);
  }
</style>
