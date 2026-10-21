<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { PageData } from './$types'

  // Kernel /vault-extern launch page — inert-until-configured governance stub.
  // The kernel does not run or manage the vault: this page is a pure launcher
  // for an operator-provided, externally-run Vaultwarden instance (shared
  // council password vault, end-to-end encrypted). Until VAULTWARDEN_BASE_URL
  // is set, the page renders a disabled "Aktivierung ausstehend" state and
  // explains what the feature is and why it's off — never a dead end.
  let { data }: { data: PageData } = $props()
</script>

<PageTitle title="Passwort-Tresor" />

<div class="page-head">
  <div>
    <div class="eyebrow">Verwaltung · Passwort-Tresor</div>
    <h1 class="page-title">Passwort-Tresor</h1>
    <div class="page-sub">Extern gehosteter, Ende-zu-Ende-verschlüsselter Tresor für geteilte Zugangsdaten.</div>
  </div>
</div>

<div class="card vault-card" class:is-off={!data.configured}>
  <div class="vault-icon" class:is-off={!data.configured}>
    <Icon name={data.configured ? 'unlock' : 'lock'} size={22} />
  </div>

  <div class="vault-body">
    {#if data.configured}
      <div class="vault-status">
        <span class="pill pill-success"><Icon name="check" size={10} /> Aktiv</span>
      </div>
      <h2 class="vault-heading">Tresor bereit</h2>
      <p class="vault-desc">
        Der Passwort-Tresor läuft als eigenständiger, extern betriebener Dienst (Vaultwarden). Der Kernel
        selbst speichert keine Zugangsdaten — er verlinkt lediglich auf die konfigurierte Instanz. Melde
        dich dort mit deinem eigenen Tresor-Konto an.
      </p>
      <a
        class="btn btn-primary"
        href={data.vaultUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Icon name="external-link" size={14} /> Tresor öffnen
      </a>
    {:else}
      <div class="vault-status">
        <span class="pill"><Icon name="toggle-left" size={10} /> Aktivierung ausstehend</span>
      </div>
      <h2 class="vault-heading">Noch nicht aktiviert</h2>
      <p class="vault-desc">
        Der Passwort-Tresor (Vaultwarden) ist ein separat betriebener, Ende-zu-Ende-verschlüsselter Dienst
        für geteilte Zugangsdaten — z. B. Mail-Postfächer, Social-Media-Konten oder Verwaltungs-Logins, die
        mehrere Personen im Gremium benötigen. Der Kernel selbst hostet oder verwaltet keine Passwörter; er
        stellt hier lediglich den Startpunkt bereit, sobald eine Instanz verlinkt ist.
      </p>
      <div class="vault-hint">
        <Icon name="info" size={15} />
        <span>
          Aktivierung erfolgt durch das IT-Team über die Server-Konfiguration
          (<code class="mono">VAULTWARDEN_BASE_URL</code>). Diese Seite bleibt bis dahin inaktiv.
        </span>
      </div>
      <button type="button" class="btn" disabled>
        <Icon name="key" size={14} /> Tresor öffnen
      </button>
    {/if}
  </div>
</div>

<!-- #405 (design v11, prototype VaultExtern): the honest residuals of the
     external lane — stated up front, whether or not the launcher is live. -->
<div class="card vault-warn">
  <Icon name="info" size={15} />
  <span>
    <b>Bekanntes Residuum:</b> Collections werden <b>nicht</b> mit Keycloak-Gruppen synchronisiert
    (kein SCIM) — die Gremien-Zuordnung driftet bei jedem Mitgliederwechsel und ist manueller
    Übergabe-Schritt. Kein Anzeige-Protokoll für den Kernel. Vergessenes Master-Passwort ist
    unwiederbringlich.
  </span>
</div>

<style>
  .page-head {
    margin-bottom: 24px;
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

  .vault-card {
    display: flex;
    gap: 18px;
    align-items: flex-start;
    padding: 24px;
    max-width: 640px;
  }
  .vault-card.is-off {
    opacity: 0.92;
  }

  .vault-icon {
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    border-radius: var(--r-md);
    display: grid;
    place-items: center;
    background: var(--pine-soft, var(--surface-2));
    color: var(--pine);
  }
  .vault-icon.is-off {
    background: var(--surface-2);
    color: var(--ink-muted);
  }

  .vault-body {
    min-width: 0;
    flex: 1;
  }
  .vault-status {
    margin-bottom: 8px;
  }
  .vault-heading {
    font-family: var(--font-display);
    font-size: 18px;
    font-weight: 600;
    color: var(--ink);
    margin: 0 0 8px;
  }
  .vault-desc {
    font-size: 13.5px;
    color: var(--ink-2);
    line-height: 1.55;
    margin: 0 0 16px;
  }
  .vault-hint {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    margin-bottom: 16px;
    padding: 12px 14px;
    border-radius: var(--r-sm);
    background: var(--accent-faint);
    font-size: 12.5px;
    color: var(--ink-2);
    line-height: 1.5;
  }
  .vault-hint :global(svg) {
    color: var(--accent);
    flex-shrink: 0;
    margin-top: 1px;
  }

  /* Ember residuals card (prototype .vt-extern-warn) — warn = Mensch-Aufgabe:
     the drift IS a manual handover step, not a system error. */
  .vault-warn {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 14px 16px;
    max-width: 640px;
    margin-top: 12px;
    font-size: 12px;
    color: var(--ink-2);
    line-height: 1.55;
    background: var(--ember-soft);
    border-color: var(--ember);
  }
  .vault-warn :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
    color: var(--ember-ink);
  }
</style>
