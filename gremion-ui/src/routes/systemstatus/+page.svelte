<script lang="ts">
  import { page } from '$app/state'
  import { invalidateAll } from '$app/navigation'
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { resolveBrand } from '$lib/brand'
  import {
    INSTANCE_STATE_META,
    STATUS_PILL,
    SERVICE_ICON,
    PLUGGABLE_MODULES,
    CORE_MODULE_LABELS,
    instanceServices,
    type InstanceState,
  } from '$lib/instance-status'
  import type { PageData } from './$types'

  // #264 (HANDOVER-v8 Part C) — provisioning-convergence Systemstatus. Read-only
  // for it-admins (the route is it-admin-gated). Renders the real backend state
  // (data.instance) against the four-state machine, split shared control-plane vs
  // silo data-plane, plus the active-module catalog. Ported from prototype
  // web/systemstatus.jsx using repo tokens.
  let { data }: { data: PageData } = $props()

  const brand = $derived(resolveBrand(page.data.brand))
  // NB: not named `state` — that collides with the `$state` rune ($state(...)
  // gets parsed as store-subscribe of a `state` variable).
  const instState = $derived(data.instance.state as InstanceState)
  const meta = $derived(INSTANCE_STATE_META[instState] ?? INSTANCE_STATE_META.ready)
  const services = $derived(instanceServices(instState, data.instance.realStatuses))

  const ready = $derived(services.filter((s) => s.status === 'ok').length)
  const total = $derived(services.length)
  const pct = $derived(Math.round((ready / total) * 100))
  const toneVar = $derived(
    meta.tone === 'danger' ? 'var(--rust)' : meta.tone === 'warn' ? 'var(--ember)' : 'var(--pine)',
  )

  const shared = $derived(services.filter((s) => s.plane === 'shared'))
  const silo = $derived(services.filter((s) => s.plane === 'silo'))

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
    <h1 class="page-title">Bereitstellung &amp; Konvergenz</h1>
    <div class="page-sub">
      {brand.product} · Mandant · Realm <span class="mono">{data.realm}</span>
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
    <div class="sys-prog">
      <div class="sys-progbar"><span style="width: {pct}%; background: {toneVar};"></span></div>
      <span class="mono sys-prog-label">{ready} / {total} Dienste bereit</span>
    </div>
  </div>
  <div class="sys-head-side">
    <div class="eyebrow">Steuerebene</div>
    <div class="mono sys-side-val">geteilt · 1 Image</div>
    <div class="eyebrow sys-side-eyebrow">Datenebene</div>
    <div class="mono sys-side-val">Silo · realm {data.realm}</div>
  </div>
</div>

{#snippet plane(title: string, tag: string, hint: string, list: typeof services)}
  <div class="sys-plane-label">
    <span>{title}</span><span class="tag">{tag}</span><span class="ln"></span>
    <span class="sys-plane-hint">{hint}</span>
  </div>
  <div class="card sys-svc-card">
    {#each list as s (s.key)}
      <div class="sys-svc is-{s.status}">
        <div class="svc-ico"><Icon name={SERVICE_ICON[s.key] ?? 'package'} size={19} /></div>
        <div class="svc-body">
          <div class="svc-name">{s.name}</div>
          <div class="svc-tech mono">{s.tech}</div>
          <div class="svc-msg">{s.message}</div>
        </div>
        <div class="svc-right">
          <span class="pill {STATUS_PILL[s.status].cls}">
            <Icon name={STATUS_PILL[s.status].icon} size={10} />
            {STATUS_PILL[s.status].label}
          </span>
          {#if s.status === 'failed'}
            <button type="button" class="btn btn-sm"><Icon name="refresh" size={13} /> Erneut versuchen</button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/snippet}

{@render plane('Geteilte Steuerebene', 'shared control-plane', 'ein Image · alle Mandanten', shared)}
{@render plane('Eigene Datenebene', 'silo data-plane', 'nur dieser Mandant · eigene DB, eigenes Realm', silo)}

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
    Die vier Zustände (<span class="mono">provisioning · ready · degraded · failed</span>) spiegeln den
    Konvergenz-Controller des Frameworks. Eine zweite Instanz (z. B. Gemeinderat) durchläuft denselben
    Ablauf — mit eigenem Realm, eigener DB und ihrer eigenen Modulauswahl.
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
  .sys-side-eyebrow {
    margin-top: 12px;
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
  .sys-svc.is-failed .svc-ico {
    background: var(--rust-soft);
    color: var(--rust-ink);
  }
  .sys-svc.is-provisioning .svc-ico,
  .sys-svc.is-degraded .svc-ico {
    background: var(--ember-soft);
    color: var(--ember-ink);
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
