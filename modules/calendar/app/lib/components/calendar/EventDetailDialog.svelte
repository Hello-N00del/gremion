<script lang="ts">
  import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import type { CalendarViewEvent } from '$lib/stores/calendar'

  interface Props {
    event: CalendarViewEvent | null
    readonly: boolean
    onClose?: () => void
    onDeleted?: () => void
  }

  let { event, readonly, onClose, onDeleted }: Props = $props()

  const open = $derived(event !== null)

  function formatDt(d: Date, allDay: boolean): string {
    if (allDay) {
      return new Intl.DateTimeFormat('de-DE', { dateStyle: 'full' }).format(d)
    }
    return new Intl.DateTimeFormat('de-DE', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Europe/Berlin',
    }).format(d)
  }

  async function handleDelete() {
    if (!event) return
    const res = await fetch(`/api/calendar/events/${event.id}`, { method: 'DELETE' })
    if (!res.ok) return
    onDeleted?.()
    onClose?.()
  }

  const mayEdit = $derived(!readonly && event !== null && !event.readOnly)
</script>

<Dialog {open} onClose={onClose}>
  {#if event}
    <DialogHeader>
      <DialogTitle>
        <span class="inline-flex items-center gap-2">
          <span
            class="h-3 w-3 rounded-sm"
            style="background: linear-gradient(90deg, {event.colour.primary} 50%, {event.colour.secondary} 50%)"
            aria-hidden="true"
          ></span>
          {event.title}
        </span>
      </DialogTitle>
    </DialogHeader>
    <div class="py-4 space-y-2 text-sm">
      <div><span class="font-medium">Beginn:</span> {formatDt(event.dtstart, event.allDay)}</div>
      <div><span class="font-medium">Ende:</span> {formatDt(event.dtend, event.allDay)}</div>
      {#if event.location}
        <div><span class="font-medium">Ort:</span> {event.location}</div>
      {/if}
      {#if event.eventTypeName}
        <div><span class="font-medium">Typ:</span> {event.eventTypeName}</div>
      {/if}
      {#if event.description}
        <div class="whitespace-pre-wrap"><span class="font-medium">Beschreibung:</span> {event.description}</div>
      {/if}
      {#if event.readOnly}
        <div class="rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-muted">
          Automatisch erstellter Termin ({event.source}). Nur lesbar.
        </div>
      {/if}
    </div>
    <DialogFooter>
      <a
        href={`/calendar/invite/${event.id}`}
        class="text-sm text-accent underline"
      >
        Einladung generieren
      </a>
      {#if mayEdit}
        <Button variant="destructive" size="sm" onclick={handleDelete}>Löschen</Button>
      {/if}
      <Button variant="outline" size="sm" onclick={onClose}>Schließen</Button>
    </DialogFooter>
  {/if}
</Dialog>
