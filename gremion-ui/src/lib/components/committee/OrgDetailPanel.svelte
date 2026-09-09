<script lang="ts">
  import type { TreeNodeDTO } from '../../../routes/committees/+page.server'
  import { termFor } from '$lib/terms'
  let { node, isAdmin = false, terms = undefined }: {
    node: TreeNodeDTO | null
    isAdmin?: boolean
    terms?: Record<string, string> | null
  } = $props()
  const eur0 = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
  // #289: full beratend/beschließend label for the authority badge.
  const authorityLabel = (a: TreeNodeDTO['authority']) => (a === 'deciding' ? 'Beschließend' : 'Beratend')
  // D6 (design v11): the caucus panel is GATED on the tenant term-map —
  // kommunales Vokabular ("Fraktionszusammensetzung") must not leak into
  // tenants without caucuses. A tenant that HAS them says so by defining the
  // 'fraktionen' term (see $lib/terms); it doubles as the panel heading.
  // StuRa tenant #1 defines none → no panel.
  const caucusTerm = $derived(termFor(terms ?? undefined, 'fraktionen', null))

  async function saveChildTerm(value: string, input: HTMLInputElement) {
    if (!node) return
    try {
      const res = await fetch(`/api/committees/${node.id}/child-term`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ childTerm: value }),
      })
      if (!res.ok) {
        // The server kept the old term — revert the input so the admin doesn't
        // believe an unsaved value was persisted.
        input.value = node.childTerm ?? ''
        alert('Bezeichnung konnte nicht gespeichert werden.')
        return
      }
      node.childTerm = value
    } catch {
      input.value = node.childTerm ?? ''
      alert('Bezeichnung konnte nicht gespeichert werden.')
    }
  }
</script>

{#if node}
  <aside class="detail-panel" style="--c-hue: {node.hue};">
    <div class="detail-head">
      <span class="node-mono">{node.abbr}</span>
      <div>
        <h3>{node.label}</h3>
        <span class="node-kind mono">{node.kind_friendly}</span>
        <span class="authority-badge" class:advisory={node.authority === 'advisory'} class:deciding={node.authority === 'deciding'}>{authorityLabel(node.authority)}</span>
      </div>
    </div>
    {#if node.desc}<p class="detail-desc">{node.desc}</p>{/if}
    <dl class="detail-stats">
      <!-- D6 (design v11): both counts live in ONE block branch — splitting them
           across an {#if} boundary let Svelte trim the leading space and render
           "10· 32" instead of "10 · 32 inkl. Untereinheiten". -->
      <div><dt class="mono">Mitglieder</dt><dd>
        {#if node.rollupCount !== node.memberCount}
          {node.memberCount} · {node.rollupCount} inkl. Untereinheiten
        {:else}
          {node.memberCount}
        {/if}
      </dd></div>
      {#if node.budget > 0}<div><dt class="mono">Haushaltsansatz</dt><dd>{eur0.format(node.budget / 100)}</dd></div>{/if}
    </dl>
    <!-- Caucus composition — rendered ONLY when the tenant's term map defines
         'fraktionen', so municipal vocabulary does not leak into caucus-less
         tenants. Honest disabled state: we do NOT fabricate seat counts. -->
    <!-- TODO: seat counts are not in the schema — this needs a seats column
         before the block can show anything. Until then it renders the honest
         disabled state below rather than a fabricated distribution. -->
    {#if caucusTerm}
      <div class="caucus-composition disabled">
        <h4 class="cc-head mono">{caucusTerm}</h4>
        <p class="cc-empty">Sitzverteilung noch nicht verfügbar.</p>
      </div>
    {/if}
    {#if isAdmin && node.children.length}
      <label class="child-term-edit">
        <span class="mono">Untergruppen-Bezeichnung</span>
        <input value={node.childTerm ?? ''} maxlength="80" onblur={(e) => saveChildTerm((e.target as HTMLInputElement).value, e.target as HTMLInputElement)} />
      </label>
    {/if}
    <!-- Carve note: Board/Matrix/Dokumente quick-links (→ /tasks, /messages,
         /files) are DROPPED here — those routes live in the product, not this
         governance-only kernel. The carve regeneration re-syncs from product
         where the routes exist. -->
  </aside>
{:else}
  <aside class="detail-panel empty"><p class="mono">Einheit wählen</p></aside>
{/if}

<style>
  .detail-panel {
    --c: hsl(var(--c-hue) 55% 45%);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg, 14px);
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    align-self: flex-start;
    position: sticky;
    top: 20px;
  }
  .detail-panel.empty {
    align-items: center;
    justify-content: center;
    min-height: 160px;
    color: var(--ink-muted);
  }
  .detail-head { display: flex; gap: 12px; align-items: center; }
  .detail-head h3 { font-size: 17px; font-weight: 600; }
  .node-mono {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 13px;
    color: #fff;
    background: var(--c);
    width: 40px; height: 40px;
    border-radius: 10px;
    display: grid; place-items: center;
    flex: 0 0 auto;
  }
  .node-kind {
    font-size: 11px;
    color: var(--ink-muted);
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .authority-badge {
    display: inline-block;
    margin-left: 8px;
    font-size: 10.5px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: .04em;
    border: 1px solid var(--line);
    color: var(--ink-muted);
  }
  .authority-badge.deciding {
    color: hsl(150 45% 32%);
    background: color-mix(in srgb, hsl(150 45% 45%) 14%, var(--surface));
    border-color: color-mix(in srgb, hsl(150 45% 45%) 35%, transparent);
  }
  .authority-badge.advisory {
    color: hsl(40 60% 32%);
    background: color-mix(in srgb, hsl(40 70% 50%) 16%, var(--surface));
    border-color: color-mix(in srgb, hsl(40 70% 50%) 35%, transparent);
  }
  .detail-desc { font-size: 13.5px; color: var(--ink-muted); line-height: 1.5; }
  .caucus-composition {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px;
    border: 1px dashed var(--line);
    border-radius: 10px;
  }
  .caucus-composition.disabled { opacity: 0.6; }
  .cc-head {
    font-size: 11px;
    color: var(--ink-muted);
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .cc-empty { font-size: 12.5px; color: var(--ink-muted); margin: 0; }
  .detail-stats {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
  }
  .detail-stats div { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .detail-stats dt { font-size: 11px; color: var(--ink-muted); text-transform: uppercase; letter-spacing: .04em; }
  .detail-stats dd { font-size: 13.5px; color: var(--ink); margin: 0; text-align: right; }
  .child-term-edit { display: flex; flex-direction: column; gap: 5px; }
  .child-term-edit span { font-size: 11px; color: var(--ink-muted); text-transform: uppercase; letter-spacing: .04em; }
  .child-term-edit input {
    font: inherit;
    font-size: 13.5px;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 9px;
    background: var(--surface);
    color: var(--ink);
  }
  .mono { font-family: var(--font-mono); }
</style>
