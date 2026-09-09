<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'

  // `href` comes from moduleHref('votes'): the card is rendered only when a
  // registered module owns that segment, so the destination is never a guess.
  let { liveVotesCount, href }: { liveVotesCount: number; href: string } = $props()
</script>

<div class="card">
  <div class="section-head card-head">
    <h3>Aktive Abstimmungen</h3>
    {#if liveVotesCount > 0}
      <span class="pill pill-accent pill-live">{liveVotesCount} live</span>
    {/if}
  </div>
  <div class="card-body">
    {#if liveVotesCount > 0}
      <a class="row row-link" {href}>
        <div class="row-main">
          <div class="primary">
            {liveVotesCount}
            {liveVotesCount === 1 ? 'laufende Abstimmung' : 'laufende Abstimmungen'}
          </div>
          <div class="secondary">Offene Abstimmungen, an denen Sie teilnehmen können.</div>
        </div>
        <Icon name="chevron-right" size={15} class="row-chevron" />
      </a>
    {:else}
      <div class="empty-row">
        Keine laufenden Abstimmungen. <a {href} class="head-link">Zu den Abstimmungen →</a>
      </div>
    {/if}
  </div>
</div>

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--sh-1);
    overflow: hidden;
  }
  .section-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .section-head h3 {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 500;
    letter-spacing: -0.01em;
    color: var(--ink);
    margin: 0;
  }
  .card-head {
    padding: 14px 18px 0;
  }
  .card-body {
    padding: 6px 4px;
  }
  .head-link {
    color: var(--accent-ink);
    text-decoration: none;
  }
  .head-link:hover {
    color: var(--ink);
  }

  /* Pills */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border-radius: 100px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    background: var(--surface-2);
    color: var(--ink-2);
    border: 1px solid var(--border);
  }
  .pill-accent {
    background: var(--accent-soft);
    color: var(--accent-ink);
    border-color: transparent;
  }
  .pill-live::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1.8s infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }

  /* Rows */
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    transition: background var(--d-fast);
  }
  .row:last-child {
    border-bottom: none;
  }
  .row:hover {
    background: var(--surface-2);
  }
  .row .primary {
    font-weight: 500;
    font-size: 13.5px;
    color: var(--ink);
  }
  .row .secondary {
    font-size: 12px;
    color: var(--ink-muted);
    margin-top: 2px;
  }
  /* Anchor rows reuse .row layout + .row:hover background; only reset default
     link styling and add a pointer affordance. */
  .row-link {
    cursor: pointer;
    color: inherit;
    text-decoration: none;
  }
  .row-main {
    flex: 1;
    min-width: 0;
  }
  .row :global(.row-chevron) {
    color: var(--ink-faint);
    flex-shrink: 0;
  }
  .empty-row {
    padding: 28px 18px;
    text-align: center;
    font-size: 12.5px;
    color: var(--ink-muted);
  }
</style>
