<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'

  interface PromotableItem {
    id: string
    text: string
    assignee_name: string | null
    due_date: string | null
    meeting_date: string
  }

  let { boardId, onclose, onpromoted }: { boardId: string; onclose: () => void; onpromoted: () => void } = $props()

  let items = $state<PromotableItem[]>([])
  let loading = $state(true)
  let busyId = $state<string | null>(null)
  let errorMsg = $state<string | null>(null)

  async function loadItems() {
    loading = true
    errorMsg = null
    try {
      const res = await fetch(`/api/board/${boardId}/promotable`)
      if (!res.ok) throw new Error('Konnte Aufgaben nicht laden')
      items = (await res.json()).data
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : 'Fehler'
    } finally {
      loading = false
    }
  }

  async function promote(id: string) {
    busyId = id
    errorMsg = null
    try {
      const res = await fetch(`/api/board/${boardId}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionItemId: id }),
      })
      if (!res.ok) throw new Error('Übernehmen fehlgeschlagen')
      onpromoted()
    } catch (e) {
      errorMsg = e instanceof Error ? e.message : 'Fehler'
    } finally {
      busyId = null
    }
  }

  $effect(() => {
    loadItems()
  })
</script>

<div
  class="dialog-backdrop"
  role="button"
  tabindex="-1"
  aria-label="Dialog schließen"
  onclick={onclose}
  onkeydown={(e) => {
    if (e.key === 'Escape') onclose()
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="dialog"
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label="Aufgabe aus Protokoll übernehmen"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="dialog-head">
      <div>
        <div class="eyebrow">Aus Protokoll übernehmen</div>
        <h3>Offene Sitzungs-Aufgaben</h3>
      </div>
      <button class="dlg-close" onclick={onclose} aria-label="Schließen"><Icon name="x" size={16} /></button>
    </div>

    <div class="dialog-body">
      {#if errorMsg}<p class="err">{errorMsg}</p>{/if}
      {#if loading}
        <p class="muted">Lade offene Aufgaben…</p>
      {:else if items.length === 0}
        <p class="muted">Keine offenen Sitzungs-Aufgaben für dieses Gremium.</p>
      {:else}
        {#each items as item (item.id)}
          <div class="promote-row">
            <div class="pr-main">
              <div class="pr-title">{item.text}</div>
              <div class="pr-sub">
                {new Date(item.meeting_date).toLocaleDateString('de-DE')}{#if item.assignee_name} · {item.assignee_name}{/if}
              </div>
            </div>
            <button class="btn btn-sm" disabled={busyId === item.id} onclick={() => promote(item.id)}>
              {#if busyId === item.id}…{:else}<Icon name="arrow-right" size={13} /> Übernehmen{/if}
            </button>
          </div>
        {/each}
      {/if}
    </div>

    <div class="dialog-foot"><Icon name="info" size={13} /> Aufgaben stammen aus den Protokollen dieses Gremiums.</div>
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
    max-height: 80vh;
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
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: auto;
  }
  .promote-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
  }
  .promote-row:hover {
    border-color: var(--border-strong);
  }
  .pr-main {
    flex: 1;
    min-width: 0;
  }
  .pr-title {
    font-size: 13.5px;
    font-weight: 500;
    color: var(--ink);
  }
  .pr-sub {
    font-size: 12px;
    color: var(--ink-muted);
    margin-top: 3px;
  }
  .dialog-foot {
    padding: 12px 22px;
    background: var(--surface-2);
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--ink-muted);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .muted {
    color: var(--ink-muted);
    font-size: 13px;
  }
  .err {
    color: var(--rust);
    font-size: 13px;
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
