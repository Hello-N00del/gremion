<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation'
  import Icon from '$lib/components/ui/Icon.svelte'
  import PageTitle from '$lib/components/PageTitle.svelte'
  import BoardColumn from '$lib/components/board/BoardColumn.svelte'
  import PromoteDialog from '$lib/components/board/PromoteDialog.svelte'
  import { deriveHue } from '$lib/governance/committee-color'
  import { dueState } from '$lib/components/board/due'
  import type { PageData } from './$types'
  import type { CardView, StackView, BoardView } from '$lib/components/board/types'
  // Deck-board module CSS (moved out of app.css — design-review 2026-07 T3);
  // covers this page plus board/BoardColumn.svelte + board/Card.svelte, which
  // render only under this route. Route-level import → Vite code-splits it.
  import './deck.css'

  let { data }: { data: PageData } = $props()

  // SvelteKit's generated PageData widens the nested deck union; this alias
  // restores precise element types (board incl. org_unit_name / stacks / cards).
  const deck = $derived(
    data.deck as { board: BoardView & { org_unit_name: string }; stacks: StackView[]; cards: CardView[] } | null,
  )

  let filterMine = $state(false)
  let labelFilter = $state<string | null>(null)
  let showPromote = $state(false)

  const selectedBoardId = $derived(data.deck?.board.id ?? null)

  // Terminal "done" stacks (status === stack) — excluded from overdue / open
  // roll-ups, matching the v6 prototype isDoneStack().
  const doneStackIds = $derived(
    new Set(
      (deck?.stacks ?? [])
        .filter((s) => s.name === 'Erledigt' || s.name === 'Veröffentlicht')
        .map((s) => s.id),
    ),
  )

  const labels = $derived(
    [...new Set((data.deck?.cards ?? []).map((c) => c.label).filter((x): x is string => !!x))].sort(),
  )

  // Cards after the Meine/Alle + label filter (used for the columns + counts).
  const visibleCards = $derived(
    (data.deck?.cards ?? []).filter(
      (c) => (!filterMine || c.is_mine) && (!labelFilter || c.label === labelFilter),
    ),
  )

  const cardsByStack = $derived.by(() => {
    const map: Record<string, CardView[]> = {}
    for (const c of visibleCards) (map[c.stack_id] ??= []).push(c)
    return map
  })

  const overdueCount = $derived(
    visibleCards.filter((c) => !doneStackIds.has(c.stack_id) && dueState(c.due_date)?.cls === 'over').length,
  )
  const myOpenCount = $derived(
    (data.deck?.cards ?? []).filter((c) => c.is_mine && !doneStackIds.has(c.stack_id)).length,
  )

  function selectBoard(id: string) {
    goto(`/tasks?board=${id}`, { invalidateAll: true })
  }

  let creatingFor = $state<string | null>(null)
  let createError = $state<string | null>(null)

  // Create the unit's board, then open it. 409 = a board appeared meanwhile
  // (another tab / member): open that one instead of reporting a failure.
  async function createBoard(orgUnitId: string) {
    creatingFor = orgUnitId
    createError = null
    try {
      const res = await fetch('/api/board', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgUnitId }),
      })
      const body = await res.json().catch(() => null)
      const id = body?.data?.id
      if ((res.status === 201 || res.status === 409) && typeof id === 'string') {
        await goto(`/tasks?board=${id}`, { invalidateAll: true })
        return
      }
      createError = res.status === 403 ? 'Dafür fehlt dir die Berechtigung.' : 'Das Board konnte nicht angelegt werden. Bitte versuche es noch einmal.'
    } catch {
      createError = 'Das Board konnte nicht angelegt werden. Bitte prüfe die Verbindung und versuche es noch einmal.'
    } finally {
      creatingFor = null
    }
  }

  async function onPromoted() {
    showPromote = false
    await invalidateAll()
  }
</script>

<PageTitle title="Aufgaben" />

<div class="page-head">
  <div>
    <div class="eyebrow">Arbeitsbereich · Aufgaben-Board</div>
    <h1 class="page-title">Aufgaben</h1>
    {#if deck}
      <div class="page-sub">
        Board <strong>{deck.board.name}</strong> · {deck.board.org_unit_name} · {visibleCards.length} Karten{#if overdueCount > 0} · <span class="overdue">{overdueCount} überfällig</span>{/if} · {myOpenCount} offen für dich
      </div>
    {:else}
      <div class="page-sub">Aufgabenboards der Gremien — ziehen zum Verschieben.</div>
    {/if}
  </div>
  {#if data.deck}
    <button class="btn btn-sm" onclick={() => (showPromote = true)}>
      <Icon name="checklist" size={14} /> Aus Protokoll übernehmen
    </button>
  {/if}
</div>

{#if data.boards.length === 0}
  <div class="empty-state">
    <div class="glyph"><Icon name="checklist" size={22} /></div>
    <div class="ttl">Noch keine Aufgabenboards</div>
    <div class="sub">Für deine Gremien wurde noch kein Board angelegt.</div>
    {#if data.creatable.length > 0}
      <div class="create-row">
        {#each data.creatable as u (u.id)}
          <button class="btn btn-primary" disabled={creatingFor !== null} onclick={() => createBoard(u.id)}>
            Board für {u.name} anlegen
          </button>
        {/each}
      </div>
    {:else}
      <div class="sub">Tritt zuerst einem Gremium bei, dann kannst du dessen Board anlegen.</div>
    {/if}
    {#if createError}<div class="create-error" role="alert">{createError}</div>{/if}
  </div>
{:else}
  <nav class="board-bar" aria-label="Board auswählen">
    <span class="eyebrow" style="margin-right:4px"><Icon name="sitemap" size={13} /> Board</span>
    {#each data.boards as b (b.id)}
      <button
        class="board-chip"
        class:on={b.id === selectedBoardId}
        style="--c-hue: {deriveHue(b.org_unit_id)}"
        onclick={() => selectBoard(b.id)}
      >
        <span class="swatch"></span>{b.name}
      </button>
    {/each}
    <span class="deck-grow"></span>
    {#each data.creatable as u (u.id)}
      <button class="btn btn-sm" disabled={creatingFor !== null} onclick={() => createBoard(u.id)}>
        <Icon name="plus" size={13} /> Board für {u.name} anlegen
      </button>
    {/each}
    {#if data.archivedCount > 0}
      <span class="board-archived" title="Archivierte Boards"><Icon name="archive" size={13} /> {data.archivedCount} archiviert</span>
    {/if}
  </nav>

  {#if deck}
    <div class="deck-filters">
      <div class="deck-seg">
        <button class:on={filterMine} onclick={() => (filterMine = true)}>Meine Karten</button>
        <button class:on={!filterMine} onclick={() => (filterMine = false)}>Alle</button>
      </div>
      {#if labels.length > 0}
        <div class="label-filter">
          <span class="eyebrow" style="margin-right:2px">Label</span>
          <button class="lf-chip" class:on={!labelFilter} onclick={() => (labelFilter = null)}>Alle</button>
          {#each labels as l (l)}
            <button
              class="lf-chip"
              class:on={labelFilter === l}
              style="--c-hue: {deriveHue(l)}"
              onclick={() => (labelFilter = labelFilter === l ? null : l)}
            >
              <span class="dot"></span>{l}
            </button>
          {/each}
        </div>
      {/if}
      <span class="deck-grow"></span>
      <span class="eyebrow">{deck.stacks.length} Stacks · {visibleCards.length} Karten</span>
    </div>

    {#if deck.cards.length === 0}
      <p class="muted">Dieses Board ist noch leer. Lege eine Karte an oder übernimm eine Aufgabe aus einem Protokoll.</p>
    {/if}
    <div class="deck-board" style="grid-template-columns: repeat({deck.stacks.length}, minmax(248px, 1fr))">
      {#each deck.stacks as stack (stack.id)}
        <BoardColumn
          boardId={deck.board.id}
          stack={{ id: stack.id, name: stack.name }}
          cards={cardsByStack[stack.id] ?? []}
        />
      {/each}
    </div>
  {/if}
{/if}

{#if showPromote && selectedBoardId}
  <PromoteDialog boardId={selectedBoardId} onclose={() => (showPromote = false)} onpromoted={onPromoted} />
{/if}

<style>
  /* page-head is a bundle-ported block (committees mirrors this exactly); the
     board grid / cards / empty-state / type primitives all come from app.css. */
  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 18px;
    gap: 20px;
    flex-wrap: wrap;
  }
  .page-title {
    font-family: var(--font-display);
    font-size: 30px;
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 1.1;
  }
  .page-sub {
    color: var(--ink-muted);
    font-size: 13.5px;
    margin-top: 6px;
    max-width: 640px;
  }
  .page-sub strong {
    color: var(--ink);
    font-weight: 600;
  }
  .overdue {
    color: var(--rust);
  }
  .create-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 14px;
  }
  .create-error {
    color: var(--rust);
    font-size: 13px;
    margin-top: 10px;
  }
</style>
