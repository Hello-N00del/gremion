<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'
  import { t } from '$lib/i18n'
  import { fmtMeetingPill, greeting } from './format'
  import type { Upcoming } from './types'

  // Page head: title block (left) + actions (right).
  let {
    nextMeeting,
    firstName,
    isMember,
    financeEnabled,
    approvalsCount,
    liveVotesCount,
    myEventCount,
    gremienPlural,
    newExpenseHref,
  }: {
    nextMeeting: Upcoming | null
    firstName: string
    isMember: boolean
    financeEnabled: boolean
    approvalsCount: number
    liveVotesCount: number
    myEventCount: number
    gremienPlural: string
    /** moduleHref('finance', '/expenses'), or null when no module owns it. */
    newExpenseHref: string | null
  } = $props()
</script>

<div class="page-head">
  <div>
    {#if nextMeeting}
      <span class="pill pill-accent pill-live">{nextMeeting.title} · {fmtMeetingPill(nextMeeting.startIso, $t)}</span>
    {/if}
    <h1 class="page-title" style="margin-top: 10px;">{greeting($t)}, {firstName}.</h1>
    <div class="page-sub">
      {#if isMember || !financeEnabled}
        {myEventCount} Termine in deinen {gremienPlural} · {liveVotesCount} Abstimmungen laufen.
      {:else}
        {approvalsCount} Anträge warten auf Freigabe · {liveVotesCount} Abstimmungen laufen.
      {/if}
    </div>
  </div>
  <div class="head-actions">
    {#if !isMember}
      <button type="button" class="btn"><Icon name="download" size={15} /> Export</button>
    {/if}
    <!-- The "Antrag stellen" CTA is hidden both when the tenant switched the
         module off AND when no registered module owns the destination, so it
         can never become a dead link. -->
    {#if financeEnabled && newExpenseHref}
      <a class="btn btn-primary" href={newExpenseHref}><Icon name="plus" size={15} /> Antrag stellen</a>
    {/if}
  </div>
</div>

<style>
  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 24px;
    gap: 20px;
  }
  .page-title {
    font-family: var(--font-display);
    font-size: 34px;
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 1.1;
    color: var(--ink);
  }
  .page-sub {
    color: var(--ink-muted);
    font-size: 13.5px;
    margin-top: 6px;
    max-width: 620px;
  }
  .head-actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
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

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: var(--r-sm);
    background: var(--surface);
    border: 1px solid var(--border-strong);
    color: var(--ink);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    text-decoration: none;
    transition: all var(--d-fast);
    line-height: 1;
  }
  .btn:hover {
    background: var(--surface-2);
  }
  .btn-primary {
    background: var(--ink);
    color: var(--paper);
    border-color: var(--ink);
  }
  .btn-primary:hover {
    background: var(--ink-2);
  }

  @media (max-width: 560px) {
    .page-head {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
