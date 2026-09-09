<script lang="ts">
  import { eur0 } from './format'
  import type { BudgetSummary } from './types'

  // KPI row — role-dependent. #290: on a finance-OFF tenant the two finance
  // KPIs (Offene Freigaben / Budget frei) are replaced with non-finance KPIs
  // so the grid stays full and shows no empty finance dashes. Tenant #1
  // (finance ON) is unchanged.
  let {
    isMember,
    financeEnabled,
    upcomingCount,
    myEventCount,
    liveVotesCount,
    unreadCount,
    approvalsCount,
    budgetSummary,
    gremienPlural,
  }: {
    isMember: boolean
    financeEnabled: boolean
    upcomingCount: number
    myEventCount: number
    liveVotesCount: number
    unreadCount: number
    approvalsCount: number
    budgetSummary: BudgetSummary | null
    gremienPlural: string
  } = $props()
</script>

{#if isMember}
  <div class="kpi-grid kpi-row">
    <div class="kpi"><div class="label">Anstehende Termine</div><div class="val">{upcomingCount}</div><div class="delta">nächste 30 Tage</div></div>
    <div class="kpi"><div class="label">In meinen {gremienPlural}</div><div class="val">{myEventCount}</div><div class="delta">davon meine</div></div>
    <div class="kpi"><div class="label">Abstimmungen</div><div class="val">{liveVotesCount}</div><div class="delta">offen für dich</div></div>
    <div class="kpi"><div class="label">Ungelesen · Matrix</div><div class="val">{unreadCount}</div><div class="delta">{unreadCount > 0 ? 'neue Nachrichten' : 'alles gelesen'}</div></div>
  </div>
{:else}
  <div class="kpi-grid kpi-row">
    {#if financeEnabled}
      <div class="kpi">
        <div class="label">Offene Freigaben</div>
        <div class="val">{approvalsCount}</div>
        <div class="delta up">{approvalsCount > 0 ? '▲ wartet auf dich' : 'keine offen'}</div>
      </div>
      <div class="kpi">
        <div class="label">Budget frei</div>
        {#if budgetSummary}
          <div class="val">{eur0.format(budgetSummary.freeCents / 100)}</div>
          <div class="delta">von {eur0.format(budgetSummary.totalCents / 100)}</div>
        {:else}
          <div class="val budget-empty">—</div>
          <div class="delta">kein Haushaltsplan</div>
        {/if}
      </div>
      <div class="kpi">
        <div class="label">Aktive Abstimmungen</div>
        <div class="val">{liveVotesCount}</div>
        <div class="delta">laufend</div>
      </div>
      <div class="kpi">
        <div class="label">Anstehende Termine</div>
        <div class="val">{upcomingCount}</div>
        <div class="delta">nächste 30 Tage</div>
      </div>
    {:else}
      <div class="kpi">
        <div class="label">Aktive Abstimmungen</div>
        <div class="val">{liveVotesCount}</div>
        <div class="delta">laufend</div>
      </div>
      <div class="kpi">
        <div class="label">Anstehende Termine</div>
        <div class="val">{upcomingCount}</div>
        <div class="delta">nächste 30 Tage</div>
      </div>
      <div class="kpi"><div class="label">In meinen {gremienPlural}</div><div class="val">{myEventCount}</div><div class="delta">davon meine</div></div>
      <div class="kpi"><div class="label">Ungelesen · Matrix</div><div class="val">{unreadCount}</div><div class="delta">{unreadCount > 0 ? 'neue Nachrichten' : 'alles gelesen'}</div></div>
    {/if}
  </div>
{/if}

<style>
  /* KPI */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
  }
  .kpi-row {
    margin-top: 24px;
  }
  .kpi {
    padding: 16px 18px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--sh-1);
  }
  .kpi .label {
    font-family: var(--font-mono);
    font-size: 10.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ink-muted);
  }
  .kpi .val {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1;
    margin-top: 8px;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .kpi .delta {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-muted);
    margin-top: 8px;
  }
  .kpi .delta.up {
    color: var(--pine);
  }
  .budget-empty {
    color: var(--ink-faint);
  }

  @media (max-width: 860px) {
    .kpi-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
