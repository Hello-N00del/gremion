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
      // F1-FIX-10-K / K2#9: the reset is a server action. The server rebuilds
      // org, smtp, modules and backup retention from the real defaults (no module
      // ids here) and audits it; setup state and legal texts stay untouched.
      const res = await fetch('/api/settings/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: resetConfirmText }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
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

  // Data wipe: there is deliberately no button here. /api/settings/wipe answers
  // 501 (a wipe must be started from the server CLI), so the former dialog asked
  // for an admin password and then always failed (F1-FIX-10-K, K2#9).
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
          Dieser Vorgang kann nicht über die Oberfläche ausgelöst werden: er muss über die Server-CLI
          eingeleitet werden.
        </p>
      </div>
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

</div>
