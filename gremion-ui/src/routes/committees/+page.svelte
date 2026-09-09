<script lang="ts">
  import { page } from '$app/state'
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import OrgTree from '$lib/components/committee/OrgTree.svelte'
  import OrgDetailPanel from '$lib/components/committee/OrgDetailPanel.svelte'
  import TermMapPanel from '$lib/components/committee/TermMapPanel.svelte'
  import { termFor } from '$lib/terms'
  import type { PageData } from './$types'
  import type { TreeNodeDTO } from './+page.server'

  let { data }: { data: PageData } = $props()
  let selected = $state<TreeNodeDTO | null>(data.tree[0] ?? null)
  const totalMembers = $derived(data.tree.reduce((s, n) => s + n.rollupCount, 0))

  // #289 (HANDOVER-v8 Part F): re-term the institution-specific nouns from the
  // active tenant's term-map (shipped on page.data.terms). StuRa tenant #1 has no
  // override, so every termFor falls back to the literal here → byte-identical.
  const terms = $derived(
    (page.data as { terms?: Record<string, string> | null }).terms ?? undefined,
  )
  const navCommittees = $derived(termFor(terms, 'navCommittees', 'Gremien & Referate'))
  const gremienPlural = $derived(termFor(terms, 'gremien', 'Gremien'))
  // Singular: prefer an explicit `gremienSingular`, else fall back to the tenant's
  // PLURAL term (consistent vocab for a configured tenant — Ausschüsse not the
  // literal "Gremium"), else the literal. Tenant #1 (no terms) → "Gremium".
  const gremiumSingular = $derived(termFor(terms, 'gremienSingular', termFor(terms, 'gremien', 'Gremium')))
</script>

<PageTitle title={navCommittees} />
<div class="page-head">
  <div>
    <div class="eyebrow">{navCommittees}</div>
    <h1 class="page-title">Organisation</h1>
    <div class="page-sub">{data.tree.length} {data.tree.length === 1 ? gremiumSingular : gremienPlural} · {totalMembers} Mitglieder inkl. Untereinheiten</div>
  </div>
</div>

{#if data.tree.length === 0}
  <div class="empty-state">
    <div class="glyph"><Icon name="users" size={22} /></div>
    <div class="ttl">Noch keine {gremienPlural}</div>
    <div class="sub">Sobald {gremienPlural} angelegt sind, erscheinen sie hier.</div>
  </div>
{:else}
  <div class="org-layout">
    <OrgTree nodes={data.tree} selectedId={selected?.id ?? null} onselect={(n) => (selected = n)} />
    <div class="org-aside">
      <OrgDetailPanel node={selected} isAdmin={data.isAdmin} {terms} />
      <TermMapPanel {terms} />
    </div>
  </div>
{/if}

<style>
  /* page-head is a bundle-ported block (not in the app.css shared layer); the
     grid, empty-state and type primitives all come from app.css. Values resolve
     to design tokens so .dark auto-switches. */
  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 24px;
    gap: 20px;
    flex-wrap: wrap;
  }
  .page-title {
    font-family: var(--font-display);
    font-size: 30px;
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 1.1;
  }
  .page-sub {
    color: var(--ink-muted);
    font-size: 13.5px;
    margin-top: 6px;
    max-width: 620px;
  }
  .org-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
    gap: 20px;
    align-items: start;
  }
  .org-aside {
    display: flex;
    flex-direction: column;
    gap: 16px;
    align-self: start;
  }
  @media (max-width: 760px) {
    .org-layout { grid-template-columns: 1fr; }
  }
</style>
