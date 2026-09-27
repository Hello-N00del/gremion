<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'
  import { t } from '$lib/i18n'

  // Shared committee tile, consumed by the admin /members grid (readonly=false:
  // name links into the committee detail, Protokolle/Beschlüsse actions shown)
  // and the member-facing /committees browser (readonly=true: informational
  // only — no links into the admin-gated detail pages). Generic primitives
  // (.card, .card-pad, .pill, .btn, .mono, .display) come from app.css; the
  // bespoke committee-card classes below resolve to design tokens so .dark
  // auto-switches.
  export interface CommitteeCardData {
    id: string
    label: string
    abbr: string
    hue: number
    desc: string
    kind: string
    wantsRoom: boolean
    wantsFiles: boolean
    memberCount: number
    /** Planned EXPENSE budget for this OU (integer euro-cents) from the active
     *  Haushaltsplan section. Absent / 0 → no Haushaltsansatz line. */
    budget?: number
  }

  let { card, readonly = false }: { card: CommitteeCardData; readonly?: boolean } = $props()

  const kindLabel = $derived(
    card.kind === 'council'
      ? $t('committee.kind.council')
      : card.kind === 'group'
        ? $t('committee.kind.group')
        : $t('committee.kind.generic')
  )

  const eur0 = new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  })
</script>

<div class="card card-pad committee-card">
  <span class="committee-kind">{kindLabel}</span>

  {#if readonly}
    <div class="committee-card-head committee-card-head-static">
      <div class="committee-mono" style="--c-hue: {card.hue};">{card.abbr}</div>
      <div class="committee-head-text">
        <div class="display committee-name">{card.label}</div>
        <div class="mono committee-count">
          {card.memberCount} {card.memberCount === 1 ? $t('committee.member') : $t('committee.members')}
        </div>
      </div>
    </div>
  {:else}
    <a href="/members/committees/{card.id}" class="committee-card-head">
      <div class="committee-mono" style="--c-hue: {card.hue};">{card.abbr}</div>
      <div class="committee-head-text">
        <div class="display committee-name">{card.label}</div>
        <div class="mono committee-count">
          {card.memberCount} {card.memberCount === 1 ? $t('committee.member') : $t('committee.members')}
        </div>
      </div>
    </a>
  {/if}

  {#if card.desc}
    <p class="committee-desc">{card.desc}</p>
  {/if}

  <!-- Haushaltsansatz — planned EXPENSE budget from the active Haushaltsplan
       section bound to this OU's finance unit (Task 3.5). Hidden when 0/absent. -->
  {#if card.budget && card.budget > 0}
    <div class="committee-budget">
      <div class="eyebrow committee-budget-label">Haushaltsansatz · Ausgaben</div>
      <div class="mono committee-budget-val">{eur0.format(card.budget / 100)}</div>
    </div>
  {/if}

  <!-- Avatar stack (initials-only; faithful to the bundle's overlap row) -->
  {#if card.memberCount > 0}
    <div class="avatar-stack">
      {#each Array(Math.min(5, card.memberCount)) as _, j (j)}
        <div class="avatar-pip" style="margin-left: {j > 0 ? '-8px' : '0'}; z-index: {5 - j};">
          {card.abbr}
        </div>
      {/each}
      {#if card.memberCount > 5}
        <span class="mono avatar-more">+{card.memberCount - 5}</span>
      {/if}
    </div>
  {/if}

  <!-- Raum / Dateien — surfaced only when the committee provisions the
       corresponding external module (Matrix room / Nextcloud folder). -->
  {#if card.wantsRoom || card.wantsFiles}
    <div class="committee-actions">
      {#if card.wantsRoom}
        <span class="pill committee-affordance"><Icon name="chat" size={12} /> Raum</span>
      {/if}
      {#if card.wantsFiles}
        <span class="pill committee-affordance"><Icon name="folder" size={12} /> Dateien</span>
      {/if}
    </div>
  {/if}

  {#if !readonly}
    <div class="committee-actions committee-links">
      <a href="/members/committees/{card.id}/protokolle" class="btn btn-sm btn-ghost committee-action">
        <Icon name="folder" size={13} /> Protokolle
      </a>
      <a href="/members/committees/{card.id}/beschluesse" class="btn btn-sm btn-ghost committee-action">
        <Icon name="check" size={13} /> Beschlüsse
      </a>
    </div>
  {/if}
</div>

<style>
  /* Committee card (T4.5) — bespoke classes ported from the design bundle
     (web/tokens.css). Generic primitives come from app.css. */
  .committee-card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    position: relative;
    overflow: hidden;
  }
  .committee-kind {
    position: absolute;
    top: 0;
    right: 0;
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.08em;
    padding: 2px 7px;
    border-radius: 0 0 0 var(--r-xs);
    background: var(--surface-2);
    color: var(--ink-muted);
    font-weight: 600;
    text-transform: uppercase;
  }
  .committee-card-head {
    display: flex;
    align-items: center;
    gap: 12px;
    text-decoration: none;
    color: inherit;
  }
  .committee-mono {
    width: 38px;
    height: 38px;
    border-radius: var(--r-sm);
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--paper);
    background: oklch(50% 0.13 var(--c-hue, 252));
  }
  :global(.dark) .committee-mono {
    color: #0e0f10;
    background: oklch(72% 0.14 var(--c-hue, 252));
  }
  .committee-head-text {
    min-width: 0;
    flex: 1;
  }
  .committee-name {
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.005em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .committee-count {
    font-size: 11px;
    color: var(--ink-muted);
    margin-top: 2px;
  }
  .committee-desc {
    font-size: 12.5px;
    color: var(--ink-muted);
    line-height: 1.5;
    margin: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .committee-budget {
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .committee-budget-label {
    font-size: 9.5px;
  }
  .committee-budget-val {
    font-size: 15px;
    font-weight: 500;
    margin-top: 2px;
    color: var(--ink);
  }
  .avatar-stack {
    display: flex;
    align-items: center;
  }
  .avatar-pip {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-family: var(--font-mono);
    font-size: 10px;
    background: var(--surface-2);
    color: var(--ink-muted);
    border: 1.5px solid var(--surface);
  }
  .avatar-more {
    font-size: 11px;
    color: var(--ink-muted);
    align-self: center;
    margin-left: 6px;
  }
  .committee-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .committee-affordance {
    gap: 4px;
  }
  .committee-links {
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .committee-action {
    flex: 1;
    justify-content: center;
  }
</style>
