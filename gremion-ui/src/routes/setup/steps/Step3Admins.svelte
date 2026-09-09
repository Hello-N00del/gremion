<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  const dispatch = createEventDispatcher<{ advance: { itAdminEmail: string }; back: void }>()

  let itEmail = ''
  let itPassword = ''
  let councilEmail = ''
  let councilPassword = ''
  let saving = false
  let error = ''
  let success = false

  async function createAccounts() {
    if (!itEmail || !itPassword || !councilEmail || !councilPassword) {
      error = 'Alle Felder sind erforderlich.'
      return
    }
    if (itEmail === councilEmail) {
      error = 'IT-Admin und Rats-Admin müssen unterschiedliche E-Mail-Adressen haben.'
      return
    }
    error = ''
    saving = true
    try {
      const res = await fetch('/api/setup/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itAdmin: { email: itEmail, password: itPassword },
          councilAdmin: { email: councilEmail, password: councilPassword },
        }),
      })
      const body = await res.json()
      if (!res.ok) {
        error = body.error ?? 'Fehler beim Erstellen der Accounts.'
        return
      }
      success = true
      await fetch('/api/setup/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_accounts: { it_admin_created: true, council_admin_created: true },
          wizard_steps: { admin_accounts: 'complete' },
        }),
      })
      dispatch('advance', { itAdminEmail: itEmail })
    } catch {
      error = 'Verbindungsfehler.'
    } finally {
      saving = false
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h2 class="text-xl font-semibold">Admin-Konten erstellen</h2>
    <p class="mt-1 text-sm text-ink-muted">
      Erstellt den ersten IT-Admin und den ersten Rats-Admin in Keycloak.
      Passwörter werden direkt an Keycloak übergeben und nicht gespeichert.
    </p>
  </div>

  {#if success}
    <div class="rounded border border-green-500/40 bg-green-50 px-4 py-3 text-sm text-green-800" role="status">
      Konten erfolgreich erstellt.
    </div>
  {/if}

  <form class="space-y-5" on:submit|preventDefault={createAccounts}>
    <fieldset class="space-y-3 rounded-lg border p-4">
      <legend class="px-1 text-sm font-semibold">IT-Admin</legend>
      <div class="space-y-1">
        <Label for="it-email">E-Mail-Adresse *</Label>
        <Input id="it-email" type="email" bind:value={itEmail} required aria-required="true" />
      </div>
      <div class="space-y-1">
        <Label for="it-password">Passwort *</Label>
        <Input id="it-password" type="password" bind:value={itPassword} required minlength={8} aria-required="true" />
        <p class="text-xs text-ink-muted">Mindestens 8 Zeichen</p>
      </div>
    </fieldset>

    <fieldset class="space-y-3 rounded-lg border p-4">
      <legend class="px-1 text-sm font-semibold">Rats-Admin</legend>
      <div class="space-y-1">
        <Label for="council-email">E-Mail-Adresse *</Label>
        <Input id="council-email" type="email" bind:value={councilEmail} required aria-required="true" />
      </div>
      <div class="space-y-1">
        <Label for="council-password">Passwort *</Label>
        <Input id="council-password" type="password" bind:value={councilPassword} required minlength={8} aria-required="true" />
      </div>
    </fieldset>

    {#if error}
      <p class="text-sm text-rust" role="alert">{error}</p>
    {/if}

    <div class="flex items-center justify-between">
      <Button type="button" variant="outline" onclick={() => dispatch('back')}>Zurück</Button>
      <Button type="submit" disabled={saving || success}>
        {saving ? 'Erstelle Konten…' : success ? 'Erstellt ✓' : 'Konten erstellen & weiter'}
      </Button>
    </div>
  </form>
</div>
