<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'
  import DateFieldDe from './DateFieldDe.svelte'
  import type { CardView, MemberOption } from './types'

  // Detail editor for one card: title, description, assignee (a member of the board's own
  // committee) and due date. It sends only what the member changed, through the existing PATCH on
  // the cards route; the server applies the same gate as a move and re-checks the assignee.
  let {
    boardId,
    card,
    members,
    onclose,
    onsaved,
  }: {
    boardId: string
    card: CardView
    members: readonly MemberOption[]
    onclose: () => void
    onsaved: () => void
  } = $props()

  const KEEP = '__keep__'

  // The page mounts one editor per card (keyed), so seeding from the props once is right.
  /* svelte-ignore state_referenced_locally */
  const initial = {
    title: card.title,
    description: card.description ?? '',
    // Someone who left the committee is still the assignee, but is no picker entry: this value
    // stands for "unchanged" so a save of another field does not unassign them.
    assignee: card.assignee_id ?? (card.assignee_name ? KEEP : ''),
    dueDate: card.due_date ?? '',
  }
  let title = $state(initial.title)
  let description = $state(initial.description)
  let assignee = $state(initial.assignee)
  let dueDate = $state(initial.dueDate)
  // The date field holds text that is no date: '' in dueDate then means "unreadable", not "none".
  let dueInvalid = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)

  async function save() {
    error = null
    const cleanTitle = title.trim()
    if (!cleanTitle) {
      error = 'Der Titel darf nicht leer sein.'
      return
    }
    if (dueInvalid) {
      error = 'Das Fälligkeitsdatum ist kein gültiges Datum. Bitte gib es im Format TT.MM.JJJJ ein oder leere das Feld.'
      return
    }
    const body: Record<string, string | null> = { cardId: card.id }
    if (cleanTitle !== initial.title) body.title = cleanTitle
    if (description.trim() !== initial.description.trim()) body.description = description
    if (assignee !== initial.assignee) body.assigneeKeycloakId = assignee === '' ? null : assignee
    // the date field shows German order and binds the ISO day (YYYY-MM-DD), '' for an empty field
    if (dueDate !== initial.dueDate) body.dueDate = dueDate === '' ? null : dueDate
    if (Object.keys(body).length === 1) {
      onclose()
      return
    }
    busy = true
    try {
      const res = await fetch(`/api/board/${boardId}/cards`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        onsaved()
        return
      }
      const reason = res.status === 400 ? ((await res.json().catch(() => null)) as { message?: string } | null)?.message : null
      error =
        reason ??
        (res.status === 403 || res.status === 404
          ? 'Die Karte kann nicht mehr bearbeitet werden. Bitte lade die Seite neu.'
          : 'Die Karte konnte nicht gespeichert werden. Bitte versuche es noch einmal.')
    } catch {
      error = 'Die Karte konnte nicht gespeichert werden. Bitte prüfe die Verbindung und versuche es noch einmal.'
    } finally {
      busy = false
    }
  }

  // Focus goes into the dialog on open and back to the control that opened it on close.
  function focusFirst(node: HTMLElement) {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    node.focus()
    return { destroy: () => opener?.isConnected && opener.focus() }
  }

  // aria-modal: Tab must not leave the dialog for the board behind it.
  const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href]'
  function keepFocusInside(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose()
      return
    }
    if (e.key !== 'Tab') return
    const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    const at = document.activeElement
    if (e.shiftKey && (at === first || at === e.currentTarget)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && at === last) {
      e.preventDefault()
      first.focus()
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="dialog-backdrop" onclick={(e) => e.target === e.currentTarget && onclose()}>
  <div
    class="dialog"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-labelledby="card-editor-title"
    onkeydown={keepFocusInside}
  >
    <div class="dialog-head">
      <div>
        <div class="eyebrow">Aufgabe</div>
        <h3 id="card-editor-title">Karte bearbeiten</h3>
      </div>
      <button type="button" class="dlg-close" onclick={onclose} aria-label="Schließen"><Icon name="x" size={16} /></button>
    </div>

    <form
      class="dialog-body"
      onsubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <label class="field">
        <span class="lbl">Titel</span>
        <input type="text" maxlength="200" bind:value={title} use:focusFirst />
      </label>
      <label class="field">
        <span class="lbl">Beschreibung</span>
        <textarea rows="4" maxlength="2000" bind:value={description}></textarea>
      </label>
      <div class="row">
        <label class="field">
          <span class="lbl">Zuständig</span>
          <select bind:value={assignee}>
            <option value="">Niemand</option>
            {#if initial.assignee === KEEP}
              <option value={KEEP}>{card.assignee_name} (nicht mehr im Gremium)</option>
            {/if}
            {#each members as m (m.id)}
              <option value={m.id}>{m.name}</option>
            {/each}
          </select>
        </label>
        <!-- Not a wrapping label: the date field holds a text input, a button and the native picker. -->
        <div class="field">
          <label class="lbl" for="card-editor-due">Fällig am</label>
          <DateFieldDe id="card-editor-due" label="Fälligkeit" bind:value={dueDate} bind:invalid={dueInvalid} />
        </div>
      </div>
      {#if error}<p class="err" role="alert">{error}</p>{/if}
      <div class="actions">
        <button type="submit" class="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Speichern …' : 'Speichern'}</button>
        <button type="button" class="btn btn-ghost btn-sm" onclick={onclose}>Abbrechen</button>
      </div>
    </form>
  </div>
</div>

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    backdrop-filter: blur(2px);
    z-index: 200;
    display: grid;
    place-items: center;
    padding: 20px;
  }
  .dialog {
    background: var(--surface);
    color: var(--ink);
    border-radius: var(--r-md);
    border: 1px solid var(--border);
    box-shadow: var(--sh-3);
    width: 100%;
    max-width: 540px;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .dialog-head {
    padding: 18px 22px 14px;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 1px solid var(--border);
  }
  .dialog-head h3 {
    font-size: 18px;
    margin-top: 4px;
    font-weight: 600;
  }
  .dialog-body {
    padding: 16px 22px 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: auto;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    flex: 1;
    min-width: 0;
  }
  .lbl {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink-muted);
  }
  .field input,
  .field select,
  .field textarea {
    font: inherit;
    font-size: 14px;
    padding: 8px 10px;
    background: var(--surface);
    color: var(--ink);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    min-width: 0;
  }
  .field textarea {
    resize: vertical;
  }
  .row {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .row .field {
    min-width: 160px;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .err {
    color: var(--rust);
    font-size: 13px;
    margin: 0;
  }
  .dlg-close {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--ink-muted);
    display: grid;
    place-items: center;
    padding: 4px;
    border-radius: var(--r-sm);
  }
  .dlg-close:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
</style>
