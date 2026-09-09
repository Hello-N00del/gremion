<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import type { GremionConfig } from '$lib/server/config'

  const dispatch = createEventDispatcher<{ back: void }>()

  // t291-setup-brand-legal: the go-live gate. The Abschluss action stays
  // disabled until the Marke + Rechtstexte are ready (isGoLiveReady). Defaults
  // to `true` so any caller that does not pass it keeps the prior behaviour.
  export let goLiveReady = true

  let config: Omit<GremionConfig, 'wizard_steps'> | null = null
  let finishing = false
  let error = ''

  async function loadConfig() {
    try {
      const res = await fetch('/api/setup/config')
      if (res.ok) {
        const body = await res.json()
        config = body.data
      }
    } catch {
      // Non-fatal — summary just won't show
    }
  }

  loadConfig()

  async function finishSetup() {
    finishing = true
    error = ''
    try {
      const res = await fetch('/api/setup/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup_complete: true }),
      })
      if (!res.ok) {
        const body = await res.json()
        error = body.error ?? 'Fehler beim Abschliessen.'
        return
      }
      // Redirect to users page for inviting first members
      window.location.href = '/users'
    } catch {
      error = 'Verbindungsfehler.'
    } finally {
      finishing = false
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h2 class="text-xl font-semibold">Einrichtung abschliessen</h2>
    <p class="mt-1 text-sm text-ink-muted">
      Überprüfe die Konfiguration und schliesse die Einrichtung ab.
    </p>
  </div>

  {#if config}
    <dl class="divide-y rounded-lg border">
      <div class="flex items-center justify-between px-4 py-3">
        <dt class="text-sm font-medium text-ink-muted">Organisation</dt>
        <dd class="text-sm font-semibold">{config.org.name || '–'}</dd>
      </div>
      <div class="flex items-center justify-between px-4 py-3">
        <dt class="text-sm font-medium text-ink-muted">Domain</dt>
        <dd class="text-sm font-mono">{config.org.domain || '–'}</dd>
      </div>
      <div class="flex items-center justify-between px-4 py-3">
        <dt class="text-sm font-medium text-ink-muted">Admin-Konten</dt>
        <dd class="text-sm">
          {config.admin_accounts.it_admin_created && config.admin_accounts.council_admin_created
            ? '✓ IT-Admin & Rats-Admin erstellt'
            : '⚠ Nicht vollständig'}
        </dd>
      </div>
      <div class="flex items-center justify-between px-4 py-3">
        <dt class="text-sm font-medium text-ink-muted">E-Mail (SMTP)</dt>
        <dd class="text-sm">
          {config.smtp.configured
            ? `✓ ${config.smtp.host}:${config.smtp.port}`
            : '⚠ Nicht konfiguriert — Benachrichtigungen deaktiviert'}
        </dd>
      </div>
    </dl>
  {/if}

  {#if error}
    <p class="text-sm text-rust" role="alert">{error}</p>
  {/if}

  <div class="rounded-lg border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800" role="note">
    Nach dem Abschliessen ist der Setup-Assistent nicht mehr zugänglich.
  </div>

  {#if !goLiveReady}
    <p class="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-700" role="alert">
      Marke und alle drei Rechtstexte müssen hinterlegt sein, bevor die Einrichtung abgeschlossen werden kann.
      Bitte den Schritt „Marke &amp; Rechtstexte“ vervollständigen.
    </p>
  {/if}

  <div class="flex items-center justify-between">
    <Button variant="outline" onclick={() => dispatch('back')}>Zurück</Button>
    <Button onclick={finishSetup} disabled={finishing || !goLiveReady}>
      {finishing ? 'Abschliesse…' : 'Setup abschliessen'}
    </Button>
  </div>
</div>
