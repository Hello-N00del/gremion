<script lang="ts">
  import Icon from '$lib/components/ui/Icon.svelte'
  import { PLUGGABLE_MODULES } from '$lib/instance-status'

  // "Modul nicht aktiv" surface for a disabled-module deep link (403, message
  // 'module-disabled:<id>'). Names the module by its display label, never the raw
  // code; admins get a hint where to switch it on. Rendered standalone or inside
  // the app shell (see routes/+error.svelte).
  let { moduleId, isItAdmin = false }: { moduleId: string; isItAdmin?: boolean } = $props()

  // Display names for every module the layout gate can name (PLUGGABLE_MODULES only covers four of them).
  const LABELS: Record<string, string> = {
    files: 'Dateien',
    messages: 'Nachrichten',
    calendar: 'Kalender',
    users: 'Personen',
    finance: 'Finanzen',
    elections: 'Wahlen',
    votes: 'Abstimmungen',
    newsletter: 'Newsletter',
    handover: 'Übergabe',
    board: 'Aushang',
    content: 'Inhalte',
    vault: 'Tresor',
    vaultwarden: 'Passwortverwaltung',
  }
  const mod = $derived(PLUGGABLE_MODULES.find((m) => m.id === moduleId))
  const label = $derived(LABELS[moduleId] ?? mod?.label ?? 'Dieses Modul')
  const note = $derived(mod?.note ?? '')
</script>

<div class="mo-page" data-testid="module-off">
  <div class="mo-card">
    <div class="mo-status" aria-hidden="true">403</div>
    <h1 class="display mo-heading">Modul nicht aktiv</h1>
    <p class="mo-detail" lang="de">
      Das Modul <strong>{label}</strong> ist für diese Instanz abgeschaltet.
      Es erscheint nicht in der Navigation und belegt keine Rollen oder Realm-Gruppen.
    </p>
    {#if note}
      <div class="mo-context" lang="de">{note}</div>
    {/if}
    {#if isItAdmin}
      <div class="mo-context" lang="de">
        Hinweis für Administratoren: Unter Systemstatus &rarr; Module lässt sich das Modul wieder einschalten.
      </div>
    {/if}
    <div class="mo-actions">
      <a href="/dashboard" class="btn btn-primary"><Icon name="home" size={14} /> Zurück zur Übersicht</a>
      {#if isItAdmin}
        <a href="/systemstatus" class="btn" lang="de"><Icon name="activity" size={14} /> Module verwalten</a>
      {/if}
    </div>
  </div>
</div>

<style>
  .mo-page { display: flex; justify-content: center; padding: 80px 20px; }
  .mo-card { width: 100%; max-width: 460px; text-align: center; }
  .mo-status {
    font-family: var(--font-display);
    font-size: 84px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -0.04em;
    color: var(--ink-faint);
  }
  .mo-heading { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin-top: 4px; }
  .mo-detail { color: var(--ink-muted); font-size: 14px; margin-top: 8px; }
  .mo-context {
    margin: 16px auto 0;
    max-width: 380px;
    padding: 10px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .mo-actions { display: flex; gap: 10px; justify-content: center; margin-top: 22px; }
</style>
