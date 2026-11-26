<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'

  interface ActionItem {
    id?: string
    text: string
    assignee_keycloak_id?: string | null
    // A stored date comes back as an ISO timestamp, the date input speaks YYYY-MM-DD.
    due_date?: string | null
    completed: boolean
  }

  interface Member {
    user_id: string
    displayName: string
  }

  let { item, isAdmin, members = [], startEditing = false, error = null, onSave, onToggle, onCancel }: {
    item: ActionItem
    isAdmin: boolean
    // The members of the body, offered as the person responsible.
    members?: Member[]
    // An unsaved draft (no id) opens as the entry form; Abbrechen then discards it
    // through `onCancel` instead of just closing the editor.
    startEditing?: boolean
    // A refusal from the server for the last save, shown inside the form.
    error?: string | null
    // May resolve to `false` when the save was refused: the form then stays open
    // so the typed text is not lost.
    onSave: (i: ActionItem) => void | boolean | Promise<void | boolean>
    onToggle: (id: string, completed: boolean) => void
    onCancel?: () => void
  } = $props()

  const uid = $props.id()

  const dateOnly = (v: string | null | undefined) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : '')
  const showDate = (v: string) =>
    new Date(`${v}T00:00:00Z`).toLocaleDateString('de-DE', { timeZone: 'UTC' })

  // svelte-ignore state_referenced_locally
  let editing = $state(startEditing)
  // svelte-ignore state_referenced_locally
  let draft = $state({ ...item, due_date: dateOnly(item.due_date), assignee_keycloak_id: item.assignee_keycloak_id ?? '' })
  let titleMissing = $state(false)
  // True while onSave is pending: the save cannot be repeated or cancelled.
  let saving = $state(false)

  const assigneeName = $derived(members.find((m) => m.user_id === item.assignee_keycloak_id)?.displayName ?? null)
  const itemDate = $derived(dateOnly(item.due_date))

  function open() {
    draft = { ...item, due_date: dateOnly(item.due_date), assignee_keycloak_id: item.assignee_keycloak_id ?? '' }
    titleMissing = false
    editing = true
  }

  async function save() {
    if (saving) return
    // A task is stored only with its title (the server refuses it too).
    if (typeof draft.text !== 'string' || draft.text.trim() === '') {
      titleMissing = true
      return
    }
    titleMissing = false
    saving = true
    try {
      const ok = await onSave({ ...draft, text: draft.text.trim() })
      if (ok !== false) editing = false
    } finally {
      saving = false
    }
  }

  function cancel() {
    if (saving) return
    titleMissing = false
    editing = false
    onCancel?.()
  }
</script>

{#if editing && isAdmin}
  <div class="rounded-md border p-3 space-y-2">
    <Input bind:value={draft.text} placeholder="Aufgabe" aria-label="Aufgabe" aria-invalid={titleMissing || undefined} />
    {#if titleMissing || error}
      <p role="alert" class="text-sm text-red-700">{titleMissing ? 'Bitte einen Titel für die Aufgabe eingeben.' : error}</p>
    {/if}
    <div class="flex flex-wrap items-end gap-3">
      <div class="flex flex-col gap-0.5">
        <label for="{uid}-due" class="text-xs text-ink-muted">Fällig bis</label>
        <Input id="{uid}-due" bind:value={draft.due_date as string} type="date" class="w-40" />
      </div>
      <div class="flex flex-col gap-0.5">
        <label for="{uid}-assignee" class="text-xs text-ink-muted">Zuständig</label>
        <select
          id="{uid}-assignee"
          bind:value={draft.assignee_keycloak_id}
          class="flex h-10 rounded-md border border-border-strong bg-paper px-3 py-2 text-sm"
        >
          <option value="">Niemand</option>
          {#each members as m (m.user_id)}
            <option value={m.user_id}>{m.displayName}</option>
          {/each}
          {#if item.assignee_keycloak_id && !assigneeName}
            <!-- The stored person is no longer in the body: kept until another choice is made. -->
            <option value={item.assignee_keycloak_id}>Bisher Zuständige (nicht mehr im Gremium)</option>
          {/if}
        </select>
      </div>
    </div>
    <div class="flex gap-2">
      <Button size="sm" onclick={save}>Speichern</Button>
      <Button size="sm" variant="ghost" onclick={cancel}>Abbrechen</Button>
    </div>
  </div>
{:else}
  <div class="flex items-center gap-3 rounded-md border px-3 py-2">
    <input
      type="checkbox"
      aria-label={`Erledigt: ${item.text}`}
      checked={item.completed}
      onchange={() => item.id && onToggle(item.id, !item.completed)}
      class="h-4 w-4"
    />
    <span class:line-through={item.completed} class:text-ink-muted={item.completed}>
      {item.text}
    </span>
    {#if assigneeName}
      <span class="text-xs text-ink-muted">{assigneeName}</span>
    {/if}
    {#if itemDate}
      <span class="text-xs text-ink-muted ml-auto">bis {showDate(itemDate)}</span>
    {/if}
    {#if isAdmin}
      <Button size="sm" variant="ghost" aria-label={`Aufgabe bearbeiten: ${item.text}`} onclick={open}>✎</Button>
    {/if}
  </div>
{/if}
