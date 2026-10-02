<script lang="ts">
  import { dndzone } from 'svelte-dnd-action'
  import { invalidateAll } from '$app/navigation'
  import Icon from '$lib/components/ui/Icon.svelte'
  import Card from './Card.svelte'
  import type { CardView } from './types'

  let { boardId, stack, cards }: { boardId: string; stack: { id: string; name: string }; cards: CardView[] } =
    $props()

  // A card's status IS the stack it sits in; the terminal stacks get the
  // struck-through / "Erledigt" treatment (matches the v6 prototype).
  const done = $derived(stack.name === 'Erledigt' || stack.name === 'Veröffentlicht')

  // Local drag state seeded from the (filtered) prop. The parent reloads via
  // invalidateAll after a successful PATCH, which reseeds this list.
  let items = $state<CardView[]>([])
  $effect(() => {
    items = [...cards]
  })

  let composing = $state(false)
  let draft = $state('')

  // On drop, persist each card's new { stackId, order } in this column.
  // Optimistic single-writer model: PATCH per card (the plan's contract).
  async function onFinalize(e: CustomEvent) {
    items = e.detail.items
    try {
      const results = await Promise.all(
        items.map((c, i) =>
          fetch(`/api/board/${boardId}/cards`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cardId: c.id, stackId: stack.id, order: i }),
          }),
        ),
      )
      if (results.some((res) => !res.ok)) {
        alert('Reihenfolge konnte nicht gespeichert werden.')
      }
    } catch {
      alert('Reihenfolge konnte nicht gespeichert werden.')
    }
    // Reseed from the server in all cases: on success this reconciles the
    // parent's derived counts/filters with the persisted order; on failure it
    // snaps the column back to the server's truth instead of leaving a desync.
    await invalidateAll()
  }

  async function addCard() {
    const title = draft.trim()
    if (!title) {
      composing = false
      return
    }
    let res: Response
    try {
      res = await fetch(`/api/board/${boardId}/cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stackId: stack.id, title }),
      })
    } catch {
      alert('Karte konnte nicht hinzugefügt werden.')
      return
    }
    if (!res.ok) {
      // Keep the typed title + open composer so the input is not lost on failure.
      alert('Karte konnte nicht hinzugefügt werden.')
      return
    }
    draft = ''
    composing = false
    await invalidateAll()
  }

  function onComposeKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      addCard()
    } else if (e.key === 'Escape') {
      composing = false
      draft = ''
    }
  }
</script>

<section class="deck-stack">
  <div class="deck-stack-head">
    <span class="t">{stack.name}</span>
    <span class="c">{items.length}</span>
  </div>
  <div
    class="deck-list"
    use:dndzone={{ items, flipDurationMs: 120 }}
    onconsider={(e) => (items = e.detail.items)}
    onfinalize={onFinalize}
  >
    {#each items as c (c.id)}
      <Card card={c} {done} />
    {/each}
  </div>

  {#if composing}
    <div class="deck-compose">
      <!-- svelte-ignore a11y_autofocus -->
      <textarea bind:value={draft} placeholder="Kartentitel…" rows="2" autofocus onkeydown={onComposeKey}></textarea>
      <div class="deck-compose-actions">
        <button class="btn btn-primary btn-sm" onclick={addCard}>Hinzufügen</button>
        <button class="btn btn-ghost btn-sm" onclick={() => { composing = false; draft = '' }}>Abbrechen</button>
      </div>
    </div>
  {:else}
    <button class="deck-add" onclick={() => (composing = true)}><Icon name="plus" size={13} /> Karte</button>
  {/if}
</section>
