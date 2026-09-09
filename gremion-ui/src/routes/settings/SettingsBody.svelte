<script lang="ts">
  import type { PageData, LayoutData } from './$types'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { t } from '$lib/i18n'
  import { scopeLabels, type ScopeKind } from '$lib/auth/labels'
  import { goto } from '$app/navigation'
  import { untrack } from 'svelte'

  // Tab bodies lifted in as section panels (logic unchanged):
  import TabGeneral from './tabs/TabGeneral.svelte'
  import TabServices from './tabs/TabServices.svelte'
  import TabEmail from './tabs/TabEmail.svelte'
  import TabLegal from './tabs/TabLegal.svelte'
  import TabRetention from './tabs/TabRetention.svelte'
  import TabBackups from './tabs/TabBackups.svelte'
  import TabAccessibility from './tabs/TabAccessibility.svelte'
  import TabDangerZone from './tabs/TabDangerZone.svelte'
  // Datenschutz inline form (lifted from compliance/+page.svelte)
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  let {
    data,
    activeSection,
  }: { data: PageData & LayoutData; activeSection?: string } = $props()

  type SectionKey =
    | 'profil'
    | 'darstellung'
    | 'organisation'
    | 'dienste'
    | 'email'
    | 'rechtliches'
    | 'datenschutz'
    | 'sicherungen'
    | 'loeschfristen'
    | 'gefahrenzone'

  type Section = {
    key: SectionKey
    label: string
    icon: string
    group: string
    show: boolean
    danger?: boolean
  }

  const sections: Section[] = $derived([
    { key: 'profil', label: 'Profil', icon: 'badge', group: 'Konto', show: true },
    { key: 'darstellung', label: 'Darstellung & Barrierefreiheit', icon: 'eye', group: 'Konto', show: true },
    { key: 'organisation', label: 'Organisation', icon: 'settings', group: 'Verwaltung', show: data.isITAdmin },
    { key: 'dienste', label: 'Dienste & Portal', icon: 'settings', group: 'Verwaltung', show: data.isITAdmin },
    { key: 'email', label: 'E-Mail', icon: 'send', group: 'Verwaltung', show: data.isITAdmin },
    { key: 'rechtliches', label: 'Rechtliches', icon: 'file', group: 'Verwaltung', show: data.isITAdmin },
    { key: 'datenschutz', label: 'Datenschutz', icon: 'shield', group: 'Verwaltung', show: data.isITAdmin },
    { key: 'sicherungen', label: 'Sicherungen', icon: 'folder', group: 'System', show: data.isITAdmin },
    { key: 'loeschfristen', label: 'Löschfristen', icon: 'clock', group: 'System', show: data.isITAdmin },
    { key: 'gefahrenzone', label: 'Gefahrenzone', icon: 'lock', group: 'System', show: data.isITAdmin, danger: true },
  ])
  const visible = $derived(sections.filter((s) => s.show))

  // Active section: alias route passes activeSection; else default 'profil'.
  // Guard against a member landing on an admin-only deep-link (they silently
  // fall back to Profil, matching the prototype's show-based filtering).
  let activeKey = $state<SectionKey>('profil')
  $effect(() => {
    const want = (activeSection ?? 'profil') as SectionKey
    activeKey = visible.some((s) => s.key === want) ? want : 'profil'
  })
  const cur = $derived(visible.find((s) => s.key === activeKey) ?? visible[0])

  // Group the nav by Konto / Verwaltung / System (insertion order preserved).
  const groups = $derived.by(() => {
    const out: { name: string; items: Section[] }[] = []
    for (const s of visible) {
      let g = out.find((x) => x.name === s.group)
      if (!g) {
        g = { name: s.group, items: [] }
        out.push(g)
      }
      g.items.push(s)
    }
    return out
  })

  const SUBTITLE: Record<SectionKey, string> = {
    profil: 'Ihr Konto, Anmeldung über Keycloak (SSO).',
    darstellung: 'Sprache, Schriftgröße, Farbsehen und Bewegung.',
    organisation: 'Name und Logo der Studierendenschaft.',
    dienste: 'Öffentliches Portal.',
    email: 'Postausgang für Benachrichtigungen.',
    rechtliches: 'Pflichttexte des öffentlichen Portals.',
    datenschutz: 'Verantwortliche Stelle und Löschkonzept.',
    sicherungen: 'Backups und Wiederherstellung.',
    loeschfristen: 'Automatische Aufbewahrungsfristen.',
    gefahrenzone: 'Unwiderrufliche Aktionen.',
  }

  function selectSection(k: SectionKey) {
    activeKey = k
    // Keep the deep-link URL in sync (shareable) without a hard nav.
    goto(`/settings/${k}`, { replaceState: true, noScroll: true, keepFocus: true })
  }

  // ---- profile card (unchanged from the old landing page) ----
  // ScopeKind lost its 'finance' member with the kernel carve — finance group
  // labels belong to the finance feature module, not to $lib/auth.
  function chipClass(kind: ScopeKind): '' | 'admin' {
    return kind === 'admin' ? 'admin' : ''
  }
  const initials = $derived(
    (data.user?.name ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?',
  )
  const scopes = $derived(scopeLabels(data.user?.groups ?? []))

  // compliance form state (lifted from compliance/+page.svelte) — datenschutz
  // panel. These are an intentional one-time snapshot of the loaded config: the
  // admin edits the fields locally and saves. `untrack` makes the deliberate,
  // non-reactive seed explicit so Svelte doesn't warn about a captured prop.
  let compVals = $state({ ...untrack(() => data.config?.compliance ?? {}) })
  let compDoc = $state(untrack(() => data.loeschkonzept ?? ''))
  let compSaving = $state(false)
  let compSaved = $state(false)
  let compErr = $state('')
  async function saveCompliance() {
    compSaving = true
    compSaved = false
    compErr = ''
    try {
      const res = await fetch('/api/settings/loeschkonzept', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(compVals),
      })
      const body = await res.json()
      if (!res.ok) compErr = body.error ?? 'Fehler beim Speichern'
      else {
        compDoc = body.data.document
        compSaved = true
      }
    } finally {
      compSaving = false
    }
  }
</script>

<div class="settings-wrap">
  <div class="page-head">
    <div>
      <div class="eyebrow">{$t('settings.title')}</div>
      <h1 class="page-title">{$t('settings.title')}</h1>
      <div class="page-sub">
        {data.isITAdmin
          ? 'Konto, Organisation und System verwalten.'
          : 'Ihr Konto und Ihre persönlichen Einstellungen.'}
      </div>
    </div>
  </div>

  <div class="set-layout">
    <nav class="set-nav" aria-label="Einstellungsbereiche">
      {#each groups as g (g.name)}
        <div class="set-nav-group">{g.name}</div>
        {#each g.items as s (s.key)}
          <button
            type="button"
            class="set-nav-item {s.danger ? 'danger' : ''} {activeKey === s.key ? 'on' : ''}"
            aria-current={activeKey === s.key ? 'page' : undefined}
            onclick={() => selectSection(s.key)}
          >
            <span class="ic"><Icon name={s.icon} size={16} /></span>
            <span>{s.label}</span>
          </button>
        {/each}
      {/each}
      {#if data.isITAdmin}
        <div class="set-nav-note">
          <b>Mitglieder</b>, <b>Gremien</b> und <b>Abstimmungen</b> verwalten Sie direkt über die
          Navigation — sie haben hier keine eigene Kachel mehr.
        </div>
      {/if}
    </nav>

    <div class="set-panel">
      <div class="set-panel-head">
        <h2>{cur.label}</h2>
        <p>{SUBTITLE[cur.key]}</p>
      </div>

      {#if activeKey === 'profil'}
        <!-- Profile card (the Konto › Profil content) -->
        <div class="card card-pad user-card">
          <div class="user-avatar">{initials}</div>
          <div class="user-body">
            <div class="display user-name">{data.user?.name ?? '—'}</div>
            <div class="mono user-email">{data.user?.email ?? '—'}</div>
            <div class="user-chips">
              {#each scopes as s (s.label)}
                <span class="scope-chip {chipClass(s.kind)}">{s.label}</span>
              {/each}
              {#if data.stepUpEnforced && data.mfaEnrolled === true}
                <span class="pill pill-success"><Icon name="shield" size={11} /> 2FA aktiv</span>
              {:else if data.stepUpEnforced && data.mfaEnrolled === false}
                <span class="pill"><Icon name="shield" size={11} /> 2FA nicht eingerichtet</span>
              {/if}
            </div>
          </div>
          {#if data.accountUrl}
            <a class="btn user-account-btn" href={data.accountUrl} target="_blank" rel="noopener noreferrer">
              Profil bearbeiten <Icon name="settings" size={13} />
            </a>
          {/if}
        </div>
        <div class="profil-note">
          Sprache der Oberfläche finden Sie unter
          <b>Darstellung &amp; Barrierefreiheit</b>.
        </div>
      {:else if activeKey === 'darstellung'}
        <TabAccessibility />
      {:else if activeKey === 'organisation' && data.config}
        <TabGeneral org={data.config.org} />
      {:else if activeKey === 'dienste' && data.config}
        <TabServices org={data.config.org} />
      {:else if activeKey === 'email' && data.config}
        <TabEmail smtp={data.config.smtp} />
      {:else if activeKey === 'rechtliches' && data.config}
        <TabLegal legal={data.config.legal} />
      {:else if activeKey === 'datenschutz' && data.config}
        <!-- compliance form + Löschkonzept preview (lifted from compliance/+page.svelte) -->
        <div class="space-y-5">
          <p class="text-sm text-ink-muted">
            Diese Felder fließen in das automatisch generierte Löschkonzept ein. Alle Werte sind
            optional — fehlende Werte werden im Dokument gekennzeichnet.
          </p>
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-1">
              <Label for="controller_name">Verantwortliche Stelle</Label>
              <Input id="controller_name" bind:value={compVals.controller_name} placeholder="StuRa Musteruni" />
            </div>
            <div class="space-y-1">
              <Label for="controller_address">Anschrift</Label>
              <Input id="controller_address" bind:value={compVals.controller_address} placeholder="Musterstraße 1, 12345 Musterstadt" />
            </div>
            <div class="space-y-1">
              <Label for="dpo_name">Datenschutzbeauftragte(r)</Label>
              <Input id="dpo_name" bind:value={compVals.dpo_name} placeholder="Max Muster" />
            </div>
            <div class="space-y-1">
              <Label for="dpo_email">E-Mail DSB</Label>
              <Input id="dpo_email" type="email" bind:value={compVals.dpo_email} placeholder="dpo@example.org" />
            </div>
          </div>
          <div class="space-y-1">
            <Label for="purpose_description">Zweck der Verarbeitung</Label>
            <textarea
              id="purpose_description"
              bind:value={compVals.purpose_description}
              rows={3}
              class="w-full rounded-md border bg-paper px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
              placeholder="Betrieb einer selbst gehosteten Plattform für studentische Verwaltung."
            ></textarea>
          </div>
          {#if compErr}<p class="text-sm text-rust">{compErr}</p>{/if}
          {#if compSaved}<p class="text-sm text-green-600">Gespeichert und Löschkonzept aktualisiert.</p>{/if}
          <div class="flex items-center gap-3">
            <Button onclick={saveCompliance} disabled={compSaving}>
              {compSaving ? 'Speichern…' : 'Speichern'}
            </Button>
            <a href="/settings/compliance/print" target="_blank" rel="noopener" class="text-sm text-accent hover:underline">
              Löschkonzept drucken →
            </a>
          </div>
          <div>
            <h3 class="text-sm font-semibold mb-3 text-ink-muted uppercase tracking-wide">Vorschau Löschkonzept</h3>
            <pre class="whitespace-pre-wrap text-xs font-mono leading-relaxed text-ink/80 overflow-auto max-h-96">{compDoc}</pre>
          </div>
        </div>
      {:else if activeKey === 'sicherungen' && data.config}
        <TabBackups backups={data.config.backups} />
      {:else if activeKey === 'loeschfristen' && data.config}
        <TabRetention retention={data.config.retention} />
      {:else if activeKey === 'gefahrenzone' && data.isITAdmin}
        <TabDangerZone />
      {/if}
    </div>
  </div>
</div>

<style>
  /* Profile-card + page-head rules carried over from the old landing page.
     Generic primitives (.card, .card-pad, .pill, .btn, .eyebrow, .mono,
     .display) come from app.css; the .set-* section layout lives in app.css
     so .dark auto-switches. */

  .settings-wrap {
    max-width: 1040px;
    margin: 0 auto;
  }

  .page-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 22px;
    gap: 20px;
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

  .user-card {
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }
  .user-avatar {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--accent-soft);
    color: var(--accent-ink);
    display: grid;
    place-items: center;
    font-family: var(--font-display);
    font-size: 26px;
    font-weight: 600;
  }
  .user-body {
    flex: 1;
    min-width: 220px;
  }
  .user-name {
    font-size: 20px;
    font-weight: 600;
  }
  .user-email {
    font-size: 12px;
    color: var(--ink-muted);
    margin-top: 2px;
  }
  .user-chips {
    display: flex;
    gap: 6px;
    margin-top: 10px;
    flex-wrap: wrap;
    align-items: center;
  }
  .user-account-btn {
    flex-shrink: 0;
  }

  .scope-chip {
    font-family: var(--font-mono);
    font-size: 9.5px;
    background: var(--surface-2);
    color: var(--ink-2);
    border: 1px solid var(--border);
    padding: 2px 7px;
    border-radius: 3px;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .scope-chip.admin {
    background: var(--rust-soft);
    color: var(--rust-ink);
    border-color: transparent;
  }

  .profil-note {
    font-size: 11.5px;
    color: var(--ink-muted);
    margin-top: 12px;
  }
  .profil-note b {
    color: var(--ink-2);
  }
</style>
