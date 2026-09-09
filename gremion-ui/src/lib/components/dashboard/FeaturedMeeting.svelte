<script lang="ts">
  import { t } from '$lib/i18n'
  import { fmtCountdown, fmtMeetingPill } from './format'
  import type { Upcoming } from './types'

  // Featured: next meeting (real calendar event, or empty state).
  let { nextMeeting }: { nextMeeting: Upcoming | null } = $props()
</script>

{#if nextMeeting}
  <div class="featured">
    <div>
      <div class="eyebrow">Nächster Termin</div>
      <h2 class="display feat-title">{nextMeeting.title}</h2>
      <div class="feat-detail">
        {fmtMeetingPill(nextMeeting.startIso, $t)}{nextMeeting.where ? ` · ${nextMeeting.where}` : ''}
      </div>
    </div>
    <div class="feat-count">
      <div class="countdown mono">{fmtCountdown(nextMeeting.startIso, $t)}</div>
      <div class="eyebrow feat-count-label">Beginnt in</div>
    </div>
  </div>
{:else}
  <div class="card featured-empty">
    <div class="eyebrow">Nächster Termin</div>
    <div class="feat-detail">
      Keine anstehenden Termine in den nächsten 30 Tagen.
    </div>
  </div>
{/if}

<style>
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    box-shadow: var(--sh-1);
    overflow: hidden;
  }

  /* Featured event card */
  .featured {
    background: var(--ink);
    color: var(--paper);
    border-radius: var(--r-md);
    padding: 22px 24px;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 24px;
    align-items: center;
    position: relative;
    overflow: hidden;
  }
  .featured::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 3px;
    background: var(--ember);
  }
  .featured .eyebrow {
    color: var(--ember);
  }
  .feat-title {
    font-size: 26px;
    margin: 8px 0 4px;
    font-weight: 600;
    color: var(--paper);
  }
  .feat-detail {
    color: var(--ink-muted);
    font-size: 13.5px;
  }
  .feat-count {
    text-align: right;
  }
  .feat-count-label {
    margin-top: 6px;
    color: var(--ember);
  }
  .countdown {
    font-family: var(--font-mono);
    font-size: 36px;
    font-weight: 500;
    letter-spacing: -0.02em;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
  }
  .featured-empty {
    padding: 18px 20px;
  }

  @media (max-width: 560px) {
    .featured {
      grid-template-columns: 1fr;
    }
    .feat-count {
      text-align: left;
    }
  }
</style>
