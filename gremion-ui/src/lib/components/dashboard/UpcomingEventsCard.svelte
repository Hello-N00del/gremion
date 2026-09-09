<script lang="ts">
  import { fmtEventWhen } from './format'
  import type { Upcoming } from './types'

  let { isMember, upcoming }: { isMember: boolean; upcoming: Upcoming[] } = $props()
</script>

<div class="card">
  <div class="section-head card-head">
    <h3>{isMember ? 'Deine Woche' : 'Anstehend'}</h3>
  </div>
  <div class="card-body">
    {#each upcoming.slice(0, 5) as ev (ev.id)}
      <div class="row">
        <div class="row-date mono">{fmtEventWhen(ev.startIso)}</div>
        <div class="row-main" style:opacity={ev.mine ? 1 : 0.7}>
          <div class="primary">{ev.title}</div>
          {#if ev.where}<div class="secondary">{ev.where}</div>{/if}
        </div>
        {#if ev.mine}
          <span class="pill pill-accent pill-tiny">Mein</span>
        {/if}
        <span class="row-bar" style="background: oklch(55% 0.13 {ev.hue});" aria-hidden="true"></span>
      </div>
    {:else}
      <div class="empty-row">Keine anstehenden Termine in den nächsten 30 Tagen.</div>
    {/each}
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
  .pill-tiny {
    font-size: 9.5px;
  }
  .pill-accent {
    background: var(--accent-soft);
    color: var(--accent-ink);
    border-color: transparent;
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
  .row-date {
    width: 90px;
    flex-shrink: 0;
    font-size: 12px;
    color: var(--ink-muted);
  }
  .row-main {
    flex: 1;
    min-width: 0;
  }
  .row-main .primary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-bar {
    width: 3px;
    align-self: stretch;
    border-radius: 2px;
    flex-shrink: 0;
  }
  .empty-row {
    padding: 28px 18px;
    text-align: center;
    font-size: 12.5px;
    color: var(--ink-muted);
  }
</style>
