<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { PageData } from './$types'

  let { data }: { data: PageData } = $props()

  // Section metadata stays in code; only the boolean enabled state lives in config.
  // Keep this list in sync with gremion-public's section renderers.
  interface SectionMeta {
    key: string
    label: string
    description: string
    icon: string
  }

  const SECTION_META: readonly SectionMeta[] = [
    { key: 'news',       label: 'Aktuelles',         description: 'Neuigkeiten-Feed auf der Landingpage',     icon: 'bell' },
    { key: 'board',      label: 'Vorstand',           description: 'Referate, Zuständigkeiten, Sprechzeiten', icon: 'users' },
    { key: 'committees', label: 'Gremien',            description: 'Ausschüsse, AGs, Sitzungsrhythmus',       icon: 'users' },
    { key: 'votes',      label: 'Abstimmungen',       description: 'Laufende Wahlen + Archiv mit Prüfzahlen', icon: 'vote' },
    { key: 'meetings',   label: 'Sitzungen',          description: 'Öffentliche Tagesordnungen, Protokolle',  icon: 'calendar' },
    { key: 'budget',     label: 'Haushalt',           description: 'Budgetübersicht + Bewilligungsliste',     icon: 'euro' },
    { key: 'antrag',     label: 'Antragsformular',    description: 'Öffentliches Formular ohne Login',        icon: 'edit' },
  ]

  // Two parallel maps:
  //   savedSections — the server-confirmed state (updated on successful PATCH).
  //   toggles       — the user's local working copy.
  // svelte-ignore state_referenced_locally
  let savedSections = $state<Record<string, boolean>>({ ...data.portalSections })
  // svelte-ignore state_referenced_locally
  let toggles = $state<Record<string, boolean>>({ ...data.portalSections })
  let saveState = $state<'idle' | 'saving' | 'saved' | 'error'>('idle')
  let saveError = $state<string | null>(null)

  let isDirty = $derived(
    SECTION_META.some((s) => toggles[s.key] !== savedSections[s.key]),
  )

  const domain = $derived(data.domain || 'stura.example.edu')
  const isOnline = true
  const activeSections = $derived(SECTION_META.filter((s) => toggles[s.key]).length)

  // v5 Task 4.2 — local-only controls (mirror the prototype's cfg state). These
  // are presentation/config knobs the prototype keeps client-side; only the
  // section toggles are persisted today, so Haushalt-Detailgrad, Antragsmodus and
  // the comments toggle stay local until their config slots are wired (SEED §6).
  let budgetDetail = $state<'summary' | 'items' | 'none'>('summary')
  let antragMode = $state<'auto' | 'review' | 'closed'>('review')
  let commentsAllowed = $state(false)

  // v5 Task 4.2 — Veröffentlichungen publish log. Forward-shape: no publish-log
  // table exists yet (SEED §6), so we render the empty state rather than invent
  // commit hashes. When a real log source lands, map its rows into `publishLog`.
  const publishLog: Array<{ when: string; who: string; what: string; hash: string }> = []
  // View-count is forward-shape too (Plausible not wired) → shown as "—".
  const viewCount: number | null = null

  async function save() {
    saveState = 'saving'
    saveError = null
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org: { portal_sections: toggles } }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      savedSections = { ...toggles }
      saveState = 'saved'
      setTimeout(() => { if (saveState === 'saved') saveState = 'idle' }, 2000)
    } catch (e) {
      saveError = e instanceof Error ? e.message : 'Speichern fehlgeschlagen'
      saveState = 'error'
    }
  }
</script>

<PageTitle title="Portal-Verwaltung" />

<div class="page-head">
  <div>
    <div class="eyebrow">Portal · Verwaltung</div>
    <h1 class="page-title">Öffentliches Portal</h1>
    <div class="page-sub">
      Was Studierende ohne Login auf <span class="mono">{domain}</span> sehen.
    </div>
  </div>
  <div class="head-actions">
    {#if isDirty}
      <span class="pill pill-warn">Ungespeicherte Änderungen</span>
    {/if}
    <a href="https://{domain}" target="_blank" rel="noopener noreferrer" class="btn btn-sm">
      <Icon name="external-link" size={14} /> Vorschau
    </a>
    <button type="button" class="btn btn-primary btn-sm" onclick={save} disabled={!isDirty || saveState === 'saving'}>
      {#if saveState === 'saving'}Speichert…{:else if saveState === 'saved'}✓ Gespeichert{:else}<Icon name="check" size={14} /> Veröffentlichen{/if}
    </button>
  </div>
</div>

{#if saveError}
  <div class="save-error">{saveError}</div>
{/if}

<!-- Status bar -->
<div class="card card-pad status-bar">
  <div class="status-online">
    <span class="status-dot" style="background: {isOnline ? 'var(--pine)' : 'var(--rust)'};"></span>
    <div>
      <div class="status-label">{isOnline ? 'Portal ist öffentlich' : 'Portal offline'}</div>
      <div class="mono status-meta">HTTPS · LE-Zert · TLS 1.3</div>
    </div>
  </div>
  <div class="status-domain">
    <div class="eyebrow">Domain</div>
    <div class="mono status-domain-val">https://{domain}</div>
  </div>
  <div class="status-stat">
    <div class="mono status-num">{activeSections}<span class="faint">/{SECTION_META.length}</span></div>
    <div class="eyebrow">Bereiche aktiv</div>
  </div>
  <div class="status-stat">
    <div class="mono status-num">{viewCount ?? '—'}</div>
    <div class="eyebrow">Aufrufe · 30 T.</div>
  </div>
</div>

<div class="portal-grid">
  <!-- LEFT — section toggles -->
  <div class="card">
    <div class="card-head">
      <h3>Bereiche des Portals</h3>
      <span class="eyebrow">Sichtbar für die Öffentlichkeit</span>
    </div>
    <ul class="section-list">
      {#each SECTION_META as section (section.key)}
        <li class="section-row" class:off={!toggles[section.key]}>
          <div class="section-icon"><Icon name={section.icon} size={16} /></div>
          <div class="section-body">
            <div class="section-label">{section.label}</div>
            <div class="section-desc">{section.description}</div>
          </div>
          <label class="portal-toggle" title="{section.label} {toggles[section.key] ? 'deaktivieren' : 'aktivieren'}">
            <input type="checkbox" bind:checked={toggles[section.key]} class="vh" />
            <div class="portal-toggle-track"></div>
            <div class="portal-toggle-thumb"></div>
          </label>
        </li>
      {/each}
    </ul>
  </div>

  <!-- RIGHT — granular settings -->
  <div class="settings-col">
    <!-- Haushalt 3-way -->
    <div class="card">
      <div class="card-head card-head-stack">
        <h3>Haushalt</h3>
        <span class="eyebrow">Detailgrad der Veröffentlichung</span>
      </div>
      <div class="radio-group">
        {#each [
          { v: 'summary', l: 'Nur Summen', s: 'Budget pro Referat, keine Einzelposten' },
          { v: 'items',   l: 'Einzelposten + Bewilligungen', s: 'Voller Haushaltsplan, anonymisierte Antragsteller' },
          { v: 'none',    l: 'Nicht veröffentlichen', s: 'Haushalt bleibt intern' },
        ] as opt (opt.v)}
          <label class="radio-row">
            <input type="radio" name="budget-detail" value={opt.v} checked={budgetDetail === opt.v}
              onchange={() => (budgetDetail = opt.v as typeof budgetDetail)} />
            <div>
              <div class="radio-label">{opt.l}</div>
              <div class="radio-sub">{opt.s}</div>
            </div>
          </label>
        {/each}
      </div>
    </div>

    <!-- Antragsformular -->
    <div class="card">
      <div class="card-head card-head-stack">
        <h3>Antragsformular</h3>
        <span class="eyebrow">Öffentliches Einreichen</span>
      </div>
      <div class="antrag-body">
        <div class="antrag-row">
          <div>
            <div class="radio-label">Modus</div>
            <div class="radio-sub">Wie neue Anträge von extern verarbeitet werden</div>
          </div>
          <div class="seg">
            {#each [{ v: 'auto', l: 'AUTO' }, { v: 'review', l: 'PRÜFEN' }, { v: 'closed', l: 'ZU' }] as o (o.v)}
              <button type="button" class:on={antragMode === o.v} onclick={() => (antragMode = o.v as typeof antragMode)}>{o.l}</button>
            {/each}
          </div>
        </div>
        <div class="antrag-row antrag-row-divided">
          <div>
            <div class="radio-label">Kommentare zulassen</div>
            <div class="radio-sub">Moderierte Diskussion zu Anträgen</div>
          </div>
          <label class="portal-toggle" title="Kommentare {commentsAllowed ? 'deaktivieren' : 'aktivieren'}">
            <input type="checkbox" bind:checked={commentsAllowed} class="vh" />
            <div class="portal-toggle-track"></div>
            <div class="portal-toggle-thumb"></div>
          </label>
        </div>
      </div>
    </div>

    <!-- DSGVO -->
    <div class="card">
      <div class="card-head card-head-stack">
        <h3>Datenschutz</h3>
        <span class="eyebrow">DSGVO</span>
      </div>
      <div class="dsgvo-body">
        <div class="dsgvo-line"><Icon name="check" size={12} /> Cookie-Banner aktiv</div>
        <div class="dsgvo-line"><Icon name="check" size={12} /> Datenschutzerklärung verlinkt</div>
        <div class="dsgvo-line"><Icon name="check" size={12} /> Keine Drittanbieter-Tracker</div>
      </div>
    </div>
  </div>
</div>

<!-- Publish log -->
<div class="card publish-log">
  <div class="card-head">
    <h3>Veröffentlichungen</h3>
    <span class="eyebrow">Änderungsverlauf</span>
  </div>
  {#if publishLog.length === 0}
    <div class="empty-state empty-inline">
      <div class="ttl">Noch keine Veröffentlichungen</div>
      <div class="sub">Sobald Bereiche veröffentlicht werden, erscheint hier der Verlauf mit Commit-Hash, Zeitpunkt und verantwortlicher Person.</div>
    </div>
  {:else}
    <ul class="log-list">
      {#each publishLog as e, i (i)}
        <li class="log-row">
          <div class="mono log-when">{e.when}</div>
          <div class="log-body">
            <div class="log-what">{e.what}</div>
            <div class="log-who">von {e.who}</div>
          </div>
          <span class="mono log-hash">#{e.hash}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .page-head {
    display: flex; justify-content: space-between; align-items: flex-end;
    margin-bottom: 20px; gap: 20px; flex-wrap: wrap;
  }
  .page-title { font-family: var(--font-display); font-size: 28px; font-weight: 500; letter-spacing: -0.015em; }
  .page-sub { color: var(--ink-muted); font-size: 13.5px; margin-top: 6px; }
  .head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

  .save-error {
    margin-bottom: 16px; padding: 10px 14px; border-radius: var(--r-sm, 6px);
    background: var(--rust-soft, var(--surface-2)); color: var(--rust-ink, var(--rust));
    border: 1px solid var(--border); font-size: 13px;
  }

  .status-bar { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; margin-bottom: 20px; }
  .status-online { display: flex; align-items: center; gap: 12px; }
  .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .status-label { font-size: 14px; font-weight: 500; }
  .status-meta { font-size: 11px; color: var(--ink-muted); margin-top: 2px; }
  .status-domain { min-width: 0; flex: 1; }
  .status-domain-val { font-size: 13px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status-stat { text-align: center; }
  .status-num { font-size: 22px; font-weight: 500; letter-spacing: -0.01em; }
  .status-num .faint { color: var(--ink-faint); }

  .portal-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 20px; align-items: flex-start; }
  @media (max-width: 900px) { .portal-grid { grid-template-columns: 1fr; } }

  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 14px 18px 12px; border-bottom: 1px solid var(--border); }
  .card-head-stack { flex-direction: column; align-items: flex-start; gap: 2px; }
  .card-head h3 { font-family: var(--font-display); font-size: 15px; font-weight: 600; }

  .section-list { list-style: none; }
  .section-row { display: flex; align-items: center; gap: 14px; padding: 14px 18px; border-bottom: 1px solid var(--border); }
  .section-row:last-child { border-bottom: none; }
  .section-row.off { opacity: 0.55; }
  .section-icon {
    width: 34px; height: 34px; border-radius: var(--r-sm, 6px); display: grid; place-items: center;
    background: var(--accent-soft, var(--surface-2)); color: var(--accent-ink); border: 1px solid var(--border); flex-shrink: 0;
  }
  .section-body { flex: 1; min-width: 0; }
  .section-label { font-size: 13.5px; font-weight: 500; }
  .section-desc { font-size: 11.5px; color: var(--ink-muted); margin-top: 2px; }

  .settings-col { display: flex; flex-direction: column; gap: 16px; }

  .radio-group { padding: 6px 18px 14px; }
  .radio-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-bottom: 1px solid var(--border); cursor: pointer; }
  .radio-row:last-child { border-bottom: none; }
  .radio-row input { margin-top: 3px; accent-color: var(--accent-ink, var(--accent)); }
  .radio-label { font-size: 13.5px; font-weight: 500; }
  .radio-sub { font-size: 11.5px; color: var(--ink-muted); margin-top: 2px; }

  .antrag-body { padding: 14px 18px 16px; display: flex; flex-direction: column; gap: 10px; }
  .antrag-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .antrag-row-divided { padding-top: 10px; border-top: 1px solid var(--border); }
  .seg { display: inline-flex; border: 1px solid var(--border-strong, var(--border)); border-radius: var(--r-sm, 6px); overflow: hidden; }
  .seg button {
    padding: 5px 10px; font-size: 10.5px; font-family: var(--font-mono); letter-spacing: 0.04em;
    background: var(--surface); color: var(--ink-muted); border: none; cursor: pointer; border-right: 1px solid var(--border);
  }
  .seg button:last-child { border-right: none; }
  .seg button.on { background: var(--accent); color: var(--accent-contrast, #fff); }

  .dsgvo-body { padding: 12px 18px 16px; display: flex; flex-direction: column; gap: 8px; }
  .dsgvo-line { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-muted); }
  .dsgvo-line :global(svg) { color: var(--pine); }

  .publish-log { margin-top: 20px; }
  .empty-inline { padding: 20px 18px; }
  .log-list { list-style: none; padding: 4px 4px 8px; }
  .log-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; }
  .log-when { font-size: 11px; color: var(--ink-muted); width: 120px; flex-shrink: 0; }
  .log-body { flex: 1; min-width: 0; }
  .log-what { font-size: 13px; }
  .log-who { font-size: 11.5px; color: var(--ink-muted); margin-top: 2px; }
  .log-hash { font-size: 10px; color: var(--ink-faint); letter-spacing: 0.04em; }

  /* Toggle switch (scoped — the old page referenced these classes but never
     defined them; define them here so the control is functional). */
  .vh {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  .portal-toggle { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; cursor: pointer; }
  .portal-toggle-track {
    position: absolute; inset: 0; border-radius: 100px;
    background: var(--surface-3); border: 1px solid var(--border-strong, var(--border));
    transition: background var(--d-fast, 0.15s), border-color var(--d-fast, 0.15s);
  }
  .portal-toggle-thumb {
    position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: left var(--d-fast, 0.15s);
  }
  .portal-toggle :global(input:checked ~ .portal-toggle-track) { background: var(--pine); border-color: var(--pine); }
  .portal-toggle :global(input:checked ~ .portal-toggle-thumb) { left: 20px; }
  .portal-toggle :global(input:focus-visible ~ .portal-toggle-track) { box-shadow: 0 0 0 3px var(--accent-soft, rgba(0, 0, 0, 0.1)); }
</style>
