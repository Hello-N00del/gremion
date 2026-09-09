<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Dialog, DialogHeader, DialogTitle } from '$lib/components/ui/dialog'

  // ── Config reset ──
  let resetDialogOpen = false
  let resetConfirmText = ''
  let resetting = false
  let resetError = ''
  let resetSuccess = ''

  async function confirmReset() {
    if (resetConfirmText !== 'ZURÜCKSETZEN') {
      resetError = 'Bitte "ZURÜCKSETZEN" eingeben.'
      return
    }
    resetting = true
    resetError = ''
    try {
      // Reset to defaults: clear org, smtp, modules (but keep setup_complete: true and legal)
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          org: { name: '', domain: '', logo_path: null },
          smtp: { configured: false, host: '', port: 587, from_address: '', from_name: '' },
          modules: { finance: true, elections: true },
          backups: { retention_days: 30 },
        }),
      })
      if (!res.ok) {
        const body = await res.json()
        resetError = body.error ?? 'Fehler beim Zurücksetzen.'
        return
      }
      resetSuccess = 'Konfiguration zurückgesetzt.'
      resetDialogOpen = false
      resetConfirmText = ''
    } catch {
      resetError = 'Verbindungsfehler.'
    } finally {
      resetting = false
    }
  }

  // ── Data wipe ──
  let wipeDialogOpen = false
  let wipePassword = ''
  let wiping = false
  let wipeError = ''

  async function confirmWipe() {
    if (!wipePassword) {
      wipeError = 'Passwort erforderlich.'
      return
    }
    wiping = true
    wipeError = ''
    try {
      const res = await fetch('/api/settings/wipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: wipePassword }),
      })
      const body = await res.json()
      wipeError = body.error ?? 'Nicht implementiert.'
    } catch {
      wipeError = 'Verbindungsfehler.'
    } finally {
      wiping = false
    }
  }
</script>

<div class="space-y-6 py-4">
  <h2 class="text-lg font-semibold text-rust">Gefahrenzone</h2>
  <p class="text-sm text-ink-muted">
    Aktionen in diesem Bereich sind potenziell nicht umkehrbar. Bitte mit Bedacht verwenden.
  </p>

  {#if resetSuccess}
    <div class="rounded border border-green-500/40 bg-green-50 px-4 py-3 text-sm text-green-800" role="status">
      {resetSuccess}
    </div>
  {/if}

  <div class="space-y-4 max-w-lg">
    <!-- Config reset card -->
    <div class="rounded-lg border border-border p-4 space-y-3">
      <div>
        <h3 class="text-sm font-semibold">Konfiguration zurücksetzen</h3>
        <p class="text-sm text-ink-muted mt-1">
          Setzt Organisations-, SMTP- und Modul-Einstellungen auf Standardwerte zurück.
          Benutzerdaten und Inhalte bleiben erhalten.
        </p>
      </div>
      <Button variant="outline" onclick={() => { resetDialogOpen = true; resetConfirmText = ''; resetError = '' }}>
        Konfiguration zurücksetzen
      </Button>
    </div>

    <!-- Data wipe card -->
    <div class="rounded-lg border border-rust/50 bg-rust-soft p-4 space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-rust-ink">Alle Daten löschen</h3>
        <p class="text-sm text-ink-muted mt-1">
          Löscht alle Daten unwiderruflich. Diese Aktion kann nicht rückgängig gemacht werden.
          In v1 muss dieser Vorgang über die Server-CLI eingeleitet werden.
        </p>
      </div>
      <Button variant="destructive" onclick={() => { wipeDialogOpen = true; wipePassword = ''; wipeError = '' }}>
        Alle Daten löschen
      </Button>
    </div>
  </div>

  <!-- Reset confirmation dialog -->
  <Dialog open={resetDialogOpen} onClose={() => resetDialogOpen = false}>
    <DialogHeader>
      <DialogTitle>Konfiguration zurücksetzen?</DialogTitle>
    </DialogHeader>
    <p class="mt-2 text-sm text-ink-muted">
      Gib <strong>ZURÜCKSETZEN</strong> ein, um zu bestätigen.
    </p>
    <div class="mt-3 space-y-1">
      <Label for="reset-confirm">Bestätigung</Label>
      <Input
        id="reset-confirm"
        bind:value={resetConfirmText}
        placeholder="ZURÜCKSETZEN"
        aria-label="Bestätigung: ZURÜCKSETZEN eingeben"
      />
    </div>
    {#if resetError}
      <p class="text-sm text-rust mt-2" role="alert">{resetError}</p>
    {/if}
    <div class="mt-4 flex justify-end gap-2">
      <Button variant="outline" onclick={() => resetDialogOpen = false}>Abbrechen</Button>
      <Button variant="destructive" disabled={resetting} onclick={confirmReset}>
        {resetting ? 'Zurücksetze…' : 'Zurücksetzen'}
      </Button>
    </div>
  </Dialog>

  <!-- Wipe confirmation dialog -->
  <Dialog open={wipeDialogOpen} onClose={() => wipeDialogOpen = false}>
    <DialogHeader>
      <DialogTitle class="text-rust">Alle Daten löschen?</DialogTitle>
    </DialogHeader>
    <div class="mt-2 rounded border border-rust/50 bg-rust-soft px-3 py-2 text-sm text-rust-ink" role="alert">
      Diese Aktion ist unwiderruflich. Alle Daten werden dauerhaft gelöscht.
    </div>
    <div class="mt-3 space-y-1">
      <Label for="wipe-password">Admin-Passwort</Label>
      <Input id="wipe-password" type="password" bind:value={wipePassword} autocomplete="current-password" />
    </div>
    {#if wipeError}
      <p class="text-sm text-ink-muted mt-2" role="alert">{wipeError}</p>
    {/if}
    <div class="mt-4 flex justify-end gap-2">
      <Button variant="outline" onclick={() => wipeDialogOpen = false}>Abbrechen</Button>
      <Button variant="destructive" disabled={wiping} onclick={confirmWipe}>
        {wiping ? 'Lösche…' : 'Alle Daten löschen'}
      </Button>
    </div>
  </Dialog>
</div>
