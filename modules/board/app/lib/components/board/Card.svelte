<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'
  import Pill from '$lib/components/pills/Pill.svelte'
  import { deriveHue } from '$lib/governance/committee-color'
  import { dueState } from './due'
  import type { CardView } from './types'

  // `done` reflects the stack the card sits in (status === stack); it drives
  // the struck-through title + "Erledigt" due pill, matching the v6 prototype.
  let { card, done = false }: { card: CardView; done?: boolean } = $props()

  function initials(name: string): string {
    return name
      .replace(/^@/, '')
      .split(/[\s.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('')
  }

  // due_date is normalised to YYYY-MM-DD at the loader boundary; dueState also
  // slices + NaN-guards so a stray timestamp never prints "Invalid Date".
  const due = $derived(dueState(card.due_date, { done }))
  // Per-label hue (deterministic from the label string), like the org-unit hue.
  const labelHue = $derived(card.label ? deriveHue(card.label) : null)
</script>

<article class="deck-card" class:done>
  <span class="deck-grip" aria-hidden="true"><Icon name="grip" size={14} /></span>
  <div class="deck-card-body">
    {#if card.label}
      <span class="deck-label" style="--c-hue: {labelHue}">{card.label}</span>
    {/if}
    <div class="deck-card-title">{card.title}</div>
    {#if card.description}<div class="deck-card-desc">{card.description}</div>{/if}
    <div class="deck-card-foot">
      {#if card.protocol_action_item_id}
        <Pill tone="accent" icon="checklist" title="Aus Protokoll übernommen">Sitzung</Pill>
      {/if}
      <span class="deck-foot-spacer"></span>
      {#if due}
        <Pill tone={due.cls === 'over' ? 'danger' : due.cls === 'soon' ? 'warn' : due.cls === 'done' ? 'success' : 'neutral'}>
          {due.label}
        </Pill>
      {/if}
      {#if card.assignee_name}
        <span class="deck-av" title={card.assignee_name}>{initials(card.assignee_name)}</span>
      {/if}
    </div>
  </div>
</article>
