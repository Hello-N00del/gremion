<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { PageData } from './$types'
  import { env } from '$env/dynamic/public'

  let { data }: { data: PageData } = $props()

  const heliosBase = env.PUBLIC_HELIOS_URL ?? ''

  // v4 lifecycle tabs. Aktiv = anything not yet closed (open + draft, so admin
  // drafts aren't hidden); Geschlossen = closed. Mirrors the prototype's
  // live/closed split (screens-v4 ElectionsScreen) against real lifecycle data.
  let activeTab = $state<'aktiv' | 'closed'>('aktiv')
  const liveCount = $derived(data.elections.filter((e) => e.lifecycle !== 'closed').length)
  const closedCount = $derived(data.elections.filter((e) => e.lifecycle === 'closed').length)
  const shownElections = $derived(
    activeTab === 'closed'
      ? data.elections.filter((e) => e.lifecycle === 'closed')
      : data.elections.filter((e) => e.lifecycle !== 'closed'),
  )

  function formatDate(iso: string | null): string {
    if (!iso) return '–'
    return new Date(iso).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  function lifecycleLabel(lc: 'draft' | 'open' | 'closed'): string {
    switch (lc) {
      case 'draft':
        return 'Entwurf'
      case 'open':
        return 'Laufend'
      case 'closed':
        return 'Geschlossen'
    }
  }
</script>

<PageTitle title="Wahlen" />

<div class="elections-page">
  <div class="page-head">
    <div>
      <div class="eyebrow"><Icon name="shield" size={12} /> Wahlen · Helios</div>
      <h1 class="page-title">Personenwahlen</h1>
      <p class="page-sub">
        Verifizierbare, kryptografisch nachprüfbare Wahlen. Stimmen werden in einer externen
        Helios-Instanz abgegeben — Trustees verteilen die Schlüssel. Für offene Umfragen siehe
        <a href="/votes" class="inline-link">Abstimmungen</a>.
      </p>
    </div>
    {#if data.isAdmin}
      <a href="/elections/new" class="btn btn-sm btn-primary"><Icon name="plus" size={14} /> Neue Wahl anlegen</a>
    {/if}
  </div>

  {#if data.elections.length > 0}
    <div class="segmented">
      <button type="button" class="seg-btn" class:on={activeTab === 'aktiv'} onclick={() => (activeTab = 'aktiv')}>
        <span class="seg-dot live" aria-hidden="true"></span>
        <span>Aktiv</span>
        <span class="mono seg-n">{liveCount}</span>
      </button>
      <button type="button" class="seg-btn" class:on={activeTab === 'closed'} onclick={() => (activeTab = 'closed')}>
        <span class="seg-dot" aria-hidden="true"></span>
        <span>Geschlossen</span>
        <span class="mono seg-n">{closedCount}</span>
      </button>
    </div>
  {/if}

  {#if data.elections.length === 0}
    <div class="empty-card">
      <Icon name="shield" size={26} />
      {#if data.isAdmin}
        <span>Noch keine Wahlen angelegt. Verwenden Sie „Neue Wahl anlegen", um zu starten.</span>
      {:else}
        <span>Aktuell sind keine Wahlen für Ihre Gremien offen.</span>
      {/if}
    </div>
  {:else}
    <ul class="election-list" role="list">
      {#each shownElections as election (election.uuid)}
        <li class="card card-pad election-card">
          <div class="election-top">
            <span class="kind-badge helios"><Icon name="shield" size={11} /> HELIOS · E2E</span>
            <div class="election-pills">
              <span
                class="pill"
                class:pill-accent={election.lifecycle === 'open'}
                class:pill-live={election.lifecycle === 'open'}
                class:pill-warn={election.lifecycle === 'draft'}
              >{lifecycleLabel(election.lifecycle)}</span>
              {#if election.calendarLinked}
                <span class="pill"><Icon name="calendar" size={11} /> Kalender</span>
              {/if}
            </div>
          </div>
          <a href="/elections/{election.uuid}" class="election-title">{election.name}</a>
          {#if election.description}
            <p class="election-desc">{election.description}</p>
          {/if}
          <div class="election-meta mono">
            {formatDate(election.votingStartsAt)} – {formatDate(election.votingEndsAt)} ·
            {election.numCastVotes} abgegebene Stimmen
          </div>
          <div class="election-actions">
            {#if election.lifecycle === 'open' && heliosBase}
              <a href="/elections/{election.uuid}" class="btn btn-sm btn-primary"><Icon name="shield" size={13} /> Zur Wahl</a>
            {/if}
            <a href="/elections/{election.uuid}" class="btn btn-sm">Details <Icon name="arrow-right" size={13} /></a>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  /* Helios elections list (Task 3.1) — institutional restyle. Generic primitives
     (.card, .pill, .btn, .eyebrow, .mono) from app.css; bespoke classes resolve
     to design tokens so .dark auto-switches. */
  .elections-page {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 20px;
    flex-wrap: wrap;
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .page-title {
    font-family: var(--font-display);
    font-size: 28px;
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 1.1;
  }
  .page-sub {
    font-size: 13px;
    color: var(--ink-muted);
    margin-top: 6px;
    max-width: 580px;
    line-height: 1.5;
  }
  .inline-link {
    color: var(--accent-ink);
    text-decoration: underline;
  }

  .segmented {
    display: inline-flex;
    border: 1px solid var(--border-strong);
    border-radius: var(--r-sm);
    overflow: hidden;
    width: fit-content;
  }
  .seg-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 14px;
    border: 0;
    background: transparent;
    color: var(--ink-muted);
    font-size: 13px;
    cursor: pointer;
  }
  .seg-btn:hover {
    color: var(--ink);
  }
  .seg-btn.on {
    background: var(--accent-soft);
    color: var(--accent-ink);
  }
  .seg-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ink-faint);
  }
  .seg-dot.live {
    background: var(--pine);
  }
  .seg-n {
    font-size: 12px;
  }

  .kind-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.06em;
    padding: 3px 7px;
    border-radius: 100px;
    background: var(--accent-soft);
    color: var(--accent-ink);
  }

  .election-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .election-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .election-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }
  .election-pills {
    display: flex;
    gap: 6px;
  }
  .election-title {
    font-family: var(--font-display);
    font-size: 16px;
    font-weight: 600;
    color: var(--ink);
    text-decoration: none;
  }
  .election-title:hover {
    text-decoration: underline;
  }
  .election-desc {
    font-size: 13px;
    color: var(--ink-muted);
    line-height: 1.5;
    margin: 0;
  }
  .election-meta {
    font-size: 11.5px;
    color: var(--ink-muted);
  }
  .election-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 4px;
  }

  .empty-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 40px 20px;
    text-align: center;
    color: var(--ink-muted);
    border: 1px dashed var(--border);
    border-radius: var(--r-md);
    font-size: 13px;
  }
</style>
