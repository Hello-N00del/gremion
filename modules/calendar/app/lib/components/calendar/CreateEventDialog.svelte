<script lang="ts">
  import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import DateTimeFieldDe from './DateTimeFieldDe.svelte'
  import { switchLocalKind } from './german-datetime'
  import { loadEvents, visibleRange } from '$lib/stores/calendar'
  import { toast } from 'svelte-sonner'
  import { onMount, untrack } from 'svelte'
  import { get } from 'svelte/store'

  interface EventType {
    id: string
    name: string
    color: string
  }
  interface Committee {
    id: string
    name: string
  }

  type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly'

  interface Props {
    open: boolean
    prefillDate?: Date
    onClose?: () => void
  }

  let { open, prefillDate, onClose }: Props = $props()

  function toLocalInput(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const now = $derived(prefillDate ?? new Date())
  const oneHourLater = $derived(new Date(now.getTime() + 3600000))

  let title = $state('')
  let description = $state('')
  let location = $state('')
  let startAt = $state(untrack(() => toLocalInput(now)))
  let endAt = $state(untrack(() => toLocalInput(oneHourLater)))
  let allDay = $state(false)
  let eventTypeId = $state<string>('')
  let committeeIds = $state<string[]>([])
  let recurrenceFreq = $state<'' | Frequency>('')
  let recurrenceInterval = $state(1)
  let recurrenceEndMode = $state<'never' | 'count' | 'until'>('never')
  let recurrenceCount = $state(10)
  let recurrenceUntil = $state('')
  let recurrenceByday = $state<string[]>([])
  let saving = $state(false)
  let isPublic = $state(false)

  let eventTypes = $state<EventType[]>([])
  let committees = $state<Committee[]>([])

  onMount(async () => {
    try {
      const [typesRes, committeesRes] = await Promise.all([
        fetch('/api/calendar/event-types'),
        fetch('/api/governance/committees'),
      ])
      const typesJson = await typesRes.json()
      if (typesJson.success) eventTypes = typesJson.data
      const commJson = await committeesRes.json()
      if (commJson.success) {
        committees = (commJson.data as Array<{ id: string; name: string }>).map(
          (c) => ({ id: c.id, name: c.name }),
        )
      }
    } catch {
      // non-fatal — render without selectors
    }
  })

  // An all-day event holds dates only: carry the typed values over to the
  // other kind, so flipping the switch never blanks the fields.
  function setAllDay(next: boolean) {
    allDay = next
    startAt = switchLocalKind(startAt, next)
    endAt = switchLocalKind(endAt, next)
  }

  function toggleCommittee(id: string) {
    committeeIds = committeeIds.includes(id)
      ? committeeIds.filter((c) => c !== id)
      : [...committeeIds, id]
  }

  function toggleByday(day: string) {
    recurrenceByday = recurrenceByday.includes(day)
      ? recurrenceByday.filter((d) => d !== day)
      : [...recurrenceByday, day]
  }

  function buildRecurrencePayload() {
    if (!recurrenceFreq) return null
    return {
      frequency: recurrenceFreq,
      interval: Math.max(1, recurrenceInterval),
      until:
        recurrenceEndMode === 'until' && recurrenceUntil
          ? new Date(recurrenceUntil).toISOString()
          : null,
      count: recurrenceEndMode === 'count' ? recurrenceCount : null,
      byday:
        recurrenceFreq === 'weekly' && recurrenceByday.length > 0
          ? recurrenceByday
          : null,
      exceptions: null,
    }
  }

  // startAt/endAt are '' while a field holds text that is not a real German date.
  const datesValid = $derived(startAt !== '' && endAt !== '')
  // With 'Am' chosen the end date must be a real date: an empty value (text the
  // reader refused, or nothing typed) would otherwise save an endless series.
  const recurrenceValid = $derived(
    !recurrenceFreq || recurrenceEndMode !== 'until' || recurrenceUntil !== '',
  )

  async function save() {
    if (!title || !datesValid || !recurrenceValid) return
    saving = true
    try {
      const res = await fetch('/api/calendar/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: description || null,
          location: location || null,
          startAt: new Date(startAt).toISOString(),
          endAt: new Date(endAt).toISOString(),
          allDay,
          eventTypeId: eventTypeId || null,
          isPublic,
          committeeIds,
          recurrence: buildRecurrencePayload(),
        }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error ?? 'Fehler')
      toast.success('Termin erstellt')
      const { from, to } = get(visibleRange)
      await loadEvents(from, to)
      onClose?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Fehler beim Speichern')
    } finally {
      saving = false
    }
  }

  const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
</script>

<!--
  The dialog never grows past the window: its height is capped to the viewport
  and the form body is the only part that scrolls, so the title and the
  buttons stay in view (E2E finding 14).
-->
<Dialog {open} onClose={onClose} class="ce-dialog">
  <DialogHeader>
    <DialogTitle>Termin erstellen</DialogTitle>
  </DialogHeader>
  <div data-dialog-body class="ce-body space-y-4">
    <div class="space-y-1">
      <Label for="ce-title">Titel *</Label>
      <Input id="ce-title" bind:value={title} placeholder="Termin-Titel" />
    </div>

    <div class="space-y-1">
      <Label for="ce-location">Ort</Label>
      <Input id="ce-location" bind:value={location} placeholder="Ort (optional)" />
    </div>

    <div class="flex items-center gap-2">
      <input
        type="checkbox"
        id="ce-allday"
        checked={allDay}
        onchange={(e) => setAllDay(e.currentTarget.checked)}
      />
      <Label for="ce-allday">Ganztägig</Label>
    </div>

    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div class="space-y-1">
        <Label for="ce-start">Beginn</Label>
        <DateTimeFieldDe id="ce-start" label="Beginn" dateOnly={allDay} bind:value={startAt} />
      </div>
      <div class="space-y-1">
        <Label for="ce-end">Ende</Label>
        <DateTimeFieldDe id="ce-end" label="Ende" dateOnly={allDay} bind:value={endAt} />
      </div>
    </div>

    <div class="space-y-1">
      <Label for="ce-type">Termin-Typ</Label>
      <select
        id="ce-type"
        bind:value={eventTypeId}
        class="flex h-10 w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm"
      >
        <option value="">– Typ wählen –</option>
        {#each eventTypes as t (t.id)}
          <option value={t.id}>{t.name}</option>
        {/each}
      </select>
    </div>

    {#if committees.length > 0}
      <div class="space-y-1">
        <Label>Gremien</Label>
        <div class="flex flex-wrap gap-2 rounded-md border p-2">
          {#each committees as c (c.id)}
            <label class="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={committeeIds.includes(c.id)}
                onchange={() => toggleCommittee(c.id)}
              />
              {c.name}
            </label>
          {/each}
        </div>
        {#if committeeIds.length > 1}
          <p class="text-xs text-ink-muted">
            Mehrere Gremien — geteilter Termin-Farbton wird verwendet.
          </p>
        {/if}
      </div>
    {/if}

    <div class="space-y-1">
      <Label for="ce-recur">Wiederholung</Label>
      <select
        id="ce-recur"
        bind:value={recurrenceFreq}
        class="flex h-10 w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm"
      >
        <option value="">Keine</option>
        <option value="daily">Täglich</option>
        <option value="weekly">Wöchentlich</option>
        <option value="monthly">Monatlich</option>
        <option value="yearly">Jährlich</option>
      </select>
    </div>

    {#if recurrenceFreq}
      <div class="space-y-2 rounded-md border p-3 text-sm">
        <div class="flex items-center gap-2">
          <Label for="ce-interval" class="shrink-0">Alle</Label>
          <Input
            id="ce-interval"
            type="number"
            min={1}
            max={99}
            bind:value={recurrenceInterval}
            class="w-20"
          />
          <span>
            {recurrenceFreq === 'daily' ? 'Tage'
              : recurrenceFreq === 'weekly' ? 'Wochen'
              : recurrenceFreq === 'monthly' ? 'Monate' : 'Jahre'}
          </span>
        </div>

        {#if recurrenceFreq === 'weekly'}
          <div class="flex flex-wrap gap-1">
            {#each WEEKDAYS as d (d)}
              <button
                type="button"
                class="rounded border px-2 py-1 text-xs {recurrenceByday.includes(d) ? 'bg-accent text-paper' : ''}"
                onclick={() => toggleByday(d)}
              >
                {d}
              </button>
            {/each}
          </div>
        {/if}

        <div class="space-y-1">
          <Label>Ende</Label>
          <div class="flex flex-wrap items-center gap-2">
            <label class="flex items-center gap-1">
              <input
                type="radio"
                bind:group={recurrenceEndMode}
                value="never"
              />
              Nie
            </label>
            <label class="flex items-center gap-1">
              <input
                type="radio"
                bind:group={recurrenceEndMode}
                value="count"
              />
              Nach
              <Input
                type="number"
                min={1}
                max={999}
                bind:value={recurrenceCount}
                class="w-20"
              />
              Wiederholungen
            </label>
            <div class="flex items-start gap-1">
              <label class="flex h-10 items-center gap-1">
                <input
                  type="radio"
                  bind:group={recurrenceEndMode}
                  value="until"
                />
                Am
              </label>
              <DateTimeFieldDe
                id="ce-until"
                label="Wiederholung endet am"
                inputLabel="Wiederholung endet am"
                dateOnly
                bind:value={recurrenceUntil}
                class="ce-until"
              />
            </div>
          </div>
        </div>
      </div>
    {/if}

    <div class="space-y-1">
      <Label for="ce-desc">Beschreibung</Label>
      <textarea
        id="ce-desc"
        bind:value={description}
        class="flex min-h-[80px] w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm"
        placeholder="Beschreibung (optional)"
      ></textarea>
    </div>
  </div>
  <DialogFooter>
    <Button variant="outline" onclick={onClose}>Abbrechen</Button>
    <Button onclick={save} disabled={!title || !datesValid || !recurrenceValid || saving}>
      {saving ? 'Speichern...' : 'Speichern'}
    </Button>
  </DialogFooter>
</Dialog>

<style>
  /* The classes below are plain CSS on purpose: the layout fix must not depend
     on a utility class that the stylesheet build might not generate for this
     module. */
  :global(.ce-dialog) {
    max-height: calc(100dvh - 2rem);
    grid-template-rows: auto minmax(0, 1fr) auto;
  }
  :global(.ce-until) {
    width: 16rem;
    max-width: 100%;
  }
  .ce-body {
    min-height: 0;
    overflow-y: auto;
    padding: 0.5rem 0.25rem 0.5rem 0;
  }
</style>
