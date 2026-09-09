<script lang="ts">
  import { TYPE_LABEL, approvalAmount, relativeTime } from './format'
  import type { MyApproval } from './types'

  // `href` comes from moduleHref('finance', '/approvals'): the card renders only
  // where a registered module owns that surface, so each row links somewhere real.
  let {
    myApprovals,
    myApprovalsCount,
    href,
  }: { myApprovals: MyApproval[]; myApprovalsCount: number; href: string } = $props()
</script>

<div class="card">
  <div class="section-head card-head">
    <h3>Auf deine Freigabe</h3>
    <span class="pill pill-warn">{myApprovalsCount} offen</span>
  </div>
  <div class="card-body">
    {#if myApprovals.length === 0}
      <div class="empty-row">
        Keine offenen Freigaben. <span class="ok">Alle aktuellen Anträge sind bearbeitet ✓</span>
      </div>
    {:else}
      {#each myApprovals as a (a.type + a.approvable_id)}
        <a class="row row-stack row-link" {href}>
          <div class="appr-top">
            <div class="appr-id">
              <span class="pill pill-tiny">{TYPE_LABEL[a.type]}</span>
              <div class="primary appr-label">#{a.approvable_id}</div>
            </div>
            {#if approvalAmount(a.amount_cents)}
              <div class="mono appr-amount">{approvalAmount(a.amount_cents)}</div>
            {/if}
          </div>
          <div class="signer-trail">
            {#each a.signers as s, j (s.role + j)}
              <span
                class="signer-step"
                class:approved={s.state === 'approved'}
                class:pending={s.state === 'pending'}
                class:rejected={s.state === 'rejected'}
              >
                <span class="dot" aria-hidden="true"></span>
                {s.role}{s.state === 'approved' ? ' ✓' : ''}
              </span>
              {#if j < a.signers.length - 1}
                <span class="signer-arrow" aria-hidden="true">→</span>
              {/if}
            {/each}
            <span class="mono appr-time">{relativeTime(a.created_at)}</span>
          </div>
        </a>
      {/each}
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
  .pill-warn {
    background: var(--ember-soft);
    color: var(--ember);
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
  .row-stack {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  /* Anchor rows reuse .row/.row-stack layout + .row:hover background; only reset
     default link styling and add a pointer affordance. */
  .row-link {
    cursor: pointer;
    color: inherit;
    text-decoration: none;
  }
  .empty-row {
    padding: 28px 18px;
    text-align: center;
    font-size: 12.5px;
    color: var(--ink-muted);
  }

  /* Approval stacked rows */
  .appr-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    gap: 8px;
  }
  .appr-id {
    display: flex;
    gap: 8px;
    align-items: center;
    flex: 1;
    min-width: 0;
  }
  .appr-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .appr-amount {
    font-size: 13px;
    font-weight: 500;
    flex-shrink: 0;
    color: var(--ink);
  }
  .appr-time {
    margin-left: auto;
    font-size: 10px;
    color: var(--ink-muted);
  }
  .ok {
    color: var(--pine);
  }

  /* Two-signer trail */
  .signer-trail {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .signer-step {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px 6px;
    border-radius: 100px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    font-weight: 600;
    border: 1px solid var(--border);
    color: var(--ink-muted);
  }
  .signer-step .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--ink-faint);
  }
  .signer-step.approved {
    background: var(--pine-soft);
    color: var(--pine);
    border-color: transparent;
  }
  .signer-step.approved .dot {
    background: var(--pine);
  }
  .signer-step.pending {
    background: var(--surface-2);
    color: var(--ink-muted);
  }
  .signer-step.pending .dot {
    background: var(--ember);
    animation: pulse 1.8s infinite;
  }
  .signer-step.rejected {
    background: var(--rust-soft);
    color: var(--rust);
    border-color: transparent;
  }
  .signer-step.rejected .dot {
    background: var(--rust);
  }
  .signer-arrow {
    color: var(--ink-faint);
    font-family: var(--font-mono);
    font-size: 11px;
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
</style>
