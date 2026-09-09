<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'

  interface ActionItem {
    id?: string
    text: string
    assignee_user_id?: string | null
    due_date?: string | null
    completed: boolean
  }

  let { item, isAdmin, onSave, onToggle }: {
    item: ActionItem
    isAdmin: boolean
    onSave: (i: ActionItem) => void
    onToggle: (id: string, completed: boolean) => void
  } = $props()

  let editing = $state(false)
  let draft = $state({ ...item })
</script>

{#if editing && isAdmin}
  <div class="rounded-md border p-3 space-y-2">
    <Input bind:value={draft.text} placeholder="Aufgabe" />
    <div class="flex gap-2">
      <Input bind:value={draft.due_date as string} type="date" placeholder="Fällig" class="w-40" />
    </div>
    <div class="flex gap-2">
      <Button size="sm" onclick={() => { onSave(draft); editing = false }}>Speichern</Button>
      <Button size="sm" variant="ghost" onclick={() => editing = false}>Abbrechen</Button>
    </div>
  </div>
{:else}
  <div class="flex items-center gap-3 rounded-md border px-3 py-2">
    <input
      type="checkbox"
      checked={item.completed}
      onchange={() => item.id && onToggle(item.id, !item.completed)}
      class="h-4 w-4"
    />
    <span class:line-through={item.completed} class:text-ink-muted={item.completed}>
      {item.text}
    </span>
    {#if item.due_date}
      <span class="text-xs text-ink-muted ml-auto">bis {new Date(item.due_date).toLocaleDateString('de-DE')}</span>
    {/if}
    {#if isAdmin}
      <Button size="sm" variant="ghost" onclick={() => editing = true}>✎</Button>
    {/if}
  </div>
{/if}
