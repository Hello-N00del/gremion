<script lang="ts">
  import { page } from '$app/state'
  import { invalidateAll } from '$app/navigation'
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { resolveBrand } from '$lib/brand'
  import { PLUGGABLE_MODULES, CORE_MODULE_LABELS } from '$lib/instance-status'
  import { countReachable, ROW_PILL, systemHeadline, systemServices } from './signals'
  import type { PageData } from './$types'

  // Read-only for it-admins (the route is it-admin-gated). Renders what the app
  // can check right now (data.services, live probes run by the load) and the
  // active-module catalog. No provisioning ledger and no canned snapshot: a
  // service the app cannot check is not listed (see ./signals.ts).
  let { data }: { data: PageData } = $props()

  const brand = $derived(resolveBrand(page.data.brand))
  const services = $derived(systemServices(data.services))
  const meta = $derived(systemHeadline(data.tenantActive, services))
  const tally = $derived(countReachable(services))
  const pct = $derived(tally.total === 0 ? 0 : Math.round((tally.ok / tally.total) * 100))
  const toneVar = $derived(
    meta.tone === 'danger' ? 'var(--rust)' : meta.tone === 'warn' ? 'var(--ember)' : 'var(--pine)',
  )

  const shared = $derived(services.filter((s) => s.plane === 'shared'))
  const tenantRows = $derived(services.filter((s) => s.plane === 'tenant'))

  const SERVICE_ICON: Record<string, string> = {
    app: 'package',
    registry: 'sliders',
    db: 'archive',
    keycloak: 'key',
    nextcloud: 'folder',
    matrix: 'matrix',
  }

  let refreshing = $state(false)
  async function refresh() {
    refreshing = true
    try {
      await invalidateAll()
    } finally {
      refreshing = false
    }
  }
</script>

<PageTitle title="Systemstatus" />

<div class="page-head">
  <div>
    <div class="eyebrow">Verwaltung · Systemstatus</div>
    <h1 class="page-title">Dienste &amp; Module</h1>
    <div class="page-sub">
      {brand.product} · Mandant{#if data.realm}
        · Realm <span class="mono">{data.realm}</span>{/if}
    </div>
  </div>
  <button type="button" class="btn btn-sm" onclick={refresh} disabled={refreshing}>
    <Icon name="refresh" size={14} /> Status aktualisieren
  </button>
</div>

<!-- Overall state -->
<div class="sys-head" class:warn={meta.tone === 'warn'} class:danger={meta.tone === 'danger'}>
  <div class="sys-head-main">
    <div class="badge-xl" style="color: {toneVar}; border-color: {toneVar};">
      <Icon name={meta.icon} size={13} /> {meta.label} · {meta.eyebrow}
    </div>
    <div class="sys-headline display">{meta.headline}</div>
    <div class="sys-sub">{meta.sub}</div>
    {#if tally.total > 0}
      <div class="sys-prog">
        <div class="sys-progbar"><span style="width: {pct}%; background: {toneVar};"></span></div>
        <span class="mono sys-prog-label">{tally.ok} / {tally.total} Dienste erreichbar</span>
      </div>
    {/if}
  </div>
  {#if data.realm}
    <div class="sys-head-side">
      <div class="eyebrow">Mandant</div>
      <div class="mono sys-side-val">aktiv · Realm {data.realm}</div>
    </div>
  {/if}
</div>

{#snippet plane(title: string, tag: string, hint: string, list: typeof services)}
  <div class="sys-plane-label">
    <span>{title}</span><span class="tag">{tag}</span><span class="ln"></span>
    <span class="sys-plane-hint">{hint}</span>
  </div>
  <div class="card sys-svc-card">
    {#each list as s (s.key)}
      {@const pill = ROW_PILL[s.status]}
      <div class="sys-svc is-{s.status}">
        <div class="svc-ico"><Icon name={SERVICE_ICON[s.key] ?? 'package'} size={19} /></div>
        <div class="svc-body">
          <div class="svc-name">{s.name}</div>
          <div class="svc-tech mono">{s.tech}</div>
          <div class="svc-msg">{s.message}</div>
        </div>
        <div class="svc-right">
          <span class="pill {pill.cls}">
            <Icon name={pill.icon} size={10} />
            {pill.label}
          </span>
        </div>
      </div>
    {/each}
  </div>
{/snippet}

{#if shared.length > 0}
  {@render plane('Anwendung', 'diese Instanz', 'läuft, sonst gäbe es diese Seite nicht', shared)}
{/if}
{#if tenantRows.length > 0}
  {@render plane('Dienste des Mandanten', 'geprüft beim Laden', 'Zeitlimit je Dienst: 3 Sekunden', tenantRows)}
{/if}

<!-- Active-module catalog — derived from the registered manifests -->
<div class="sys-plane-label">
  <span>Aktive Module</span><span class="tag">pro Mandant</span><span class="ln"></span>
</div>
<div class="mod-grid">
  {#if PLUGGABLE_MODULES.length === 0}
    <div class="mod-card">
      <div class="mc-top"><div class="mc-name">Keine abwählbaren Module</div></div>
      <div class="mc-note">
        Diese Instanz führt ausschließlich Kernmodule. Abwählbare Module erscheinen hier,
        sobald ein Modul registriert ist, das der Mandant ein- und ausschalten kann.
      </div>
    </div>
  {/if}
  {#each PLUGGABLE_MODULES as m (m.id)}
    {@const off = data.modules[m.id] === false}
    <div class="mod-card" class:off>
      <div class="mc-top">
        <div class="mc-name">{m.label}</div>
        {#if off}
          <span class="pill"><Icon name="toggle-left" size={10} /> Aus</span>
        {:else}
          <span class="pill pill-success"><Icon name="check" size={10} /> Aktiv</span>
        {/if}
      </div>
      <div class="mc-svc mono">{m.service}</div>
      <div class="mc-note">{m.note}</div>
    </div>
  {/each}
  <div class="mod-card">
    <div class="mc-top">
      <div class="mc-name">Kernmodule</div>
      <span class="pill">{CORE_MODULE_LABELS.length} immer aktiv</span>
    </div>
    <div class="mc-svc mono">{CORE_MODULE_LABELS.join(' · ')}</div>
    <div class="mc-note">Diese Module sind nicht abwählbar — sie bilden das Gerüst jeder Instanz.</div>
  </div>
</div>

<div class="sys-foot">
  <Icon name="info" size={15} />
  <span>
    Die Anzeige prüft jeden Dienst erneut, wenn die Seite geladen oder „Status aktualisieren“ gedrückt wird.
    Ein Dienst, den die Anwendung nicht selbst prüfen kann, wird nicht aufgeführt.
  </span>
</div>

<style>
  /* page-head / page-title / page-sub / eyebrow / mono / card / pill / btn all
     come from app.css; only the sys-specific composition lives here. Every value
     resolves to a design token so .dark auto-switches. */
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
  }

  /* Overall-state header */
  .sys-head {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
    padding: 22px 24px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--pine);
    border-radius: var(--r-md);
    background: var(--surface);
    box-shadow: var(--sh-1);
    margin-bottom: 22px;
  }
  .sys-head.warn {
    border-left-color: var(--ember);
  }
  .sys-head.danger {
    border-left-color: var(--rust);
  }
  .sys-head-main {
    min-width: 0;
    flex: 1;
  }
  .badge-xl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: 100px;
    border: 1px solid var(--pine);
    background: var(--surface);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .sys-headline {
    font-family: var(--font-display);
    font-size: 22px;
    font-weight: 600;
    margin: 12px 0 4px;
    color: var(--ink);
  }
  .sys-sub {
    font-size: 13px;
    color: var(--ink-2);
    line-height: 1.55;
    max-width: 640px;
  }
  .sys-prog {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
  }
  .sys-progbar {
    flex: 1;
    max-width: 320px;
    height: 6px;
    border-radius: 3px;
    background: var(--surface-2);
    overflow: hidden;
  }
  .sys-progbar span {
    display: block;
    height: 100%;
    border-radius: 3px;
    transition: width var(--d-med) var(--e-out);
  }
  .sys-prog-label {
    font-size: 12px;
    color: var(--ink-2);
    font-weight: 500;
  }
  .sys-head-side {
    flex-shrink: 0;
    text-align: right;
  }
  .sys-side-val {
    font-size: 12px;
    color: var(--ink-2);
    margin-top: 6px;
  }

  /* Plane label divider */
  .sys-plane-label {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 22px 0 10px;
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--ink-2);
    font-weight: 600;
  }
  .sys-plane-label .tag {
    font-size: 10px;
    color: var(--ink-faint);
    letter-spacing: 0.06em;
    text-transform: none;
    font-weight: 500;
  }
  .sys-plane-label .ln {
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .sys-plane-hint {
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    font-size: 11px;
    color: var(--ink-faint);
    flex-shrink: 0;
  }

  /* Service rows */
  .sys-svc-card {
    overflow: hidden;
  }
  .sys-svc {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
  }
  .sys-svc:last-child {
    border-bottom: none;
  }
  .svc-ico {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: var(--r-sm);
    background: var(--surface-2);
    color: var(--ink-2);
    display: grid;
    place-items: center;
  }
  .sys-svc.is-unreachable .svc-ico {
    background: var(--rust-soft);
    color: var(--rust-ink);
  }
  .sys-svc.is-off {
    opacity: 0.7;
  }
  .svc-body {
    flex: 1;
    min-width: 0;
  }
  .svc-name {
    font-size: 13.5px;
    font-weight: 600;
    color: var(--ink);
  }
  .svc-tech {
    font-size: 11px;
    color: var(--ink-muted);
    margin-top: 1px;
  }
  .svc-msg {
    font-size: 12px;
    color: var(--ink-2);
    margin-top: 3px;
  }
  .svc-right {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-shrink: 0;
  }

  /* Module catalog */
  .mod-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
  }
  .mod-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    padding: 14px 16px;
    box-shadow: var(--sh-1);
  }
  .mod-card.off {
    opacity: 0.7;
    background: var(--surface-2);
  }
  .mc-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .mc-name {
    font-family: var(--font-display);
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
  }
  .mc-svc {
    font-size: 11px;
    color: var(--ink-muted);
    margin-bottom: 6px;
  }
  .mc-note {
    font-size: 12px;
    color: var(--ink-2);
    line-height: 1.5;
  }

  .sys-foot {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin-top: 22px;
    padding: 12px 14px;
    border-radius: var(--r-sm);
    background: var(--accent-faint);
    font-size: 12.5px;
    color: var(--ink-2);
    line-height: 1.5;
  }
  .sys-foot :global(svg) {
    color: var(--accent);
    flex-shrink: 0;
    margin-top: 1px;
  }

  @media (max-width: 760px) {
    .mod-grid {
      grid-template-columns: 1fr;
    }
    .sys-head-side {
      text-align: left;
    }
  }
</style>
