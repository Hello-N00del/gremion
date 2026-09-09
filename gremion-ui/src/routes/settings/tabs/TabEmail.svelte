<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { page } from '$app/stores'
  import { resolveBrand } from '$lib/brand'

  export let smtp: { configured: boolean; host: string; port: number; from_address: string; from_name: string }

  $: brand = resolveBrand($page.data.brand)

  let host = smtp.host
  let port = smtp.port
  let fromAddress = smtp.from_address
  let fromName = smtp.from_name
  // For test only — never saved
  let testUser = ''
  let testPassword = ''
  let testResult = ''
  let testError = ''
  // SECOND consumer of /api/setup/test-smtp. The guard's 400 carries a `hint`
  // naming the SMTP_TEST_ALLOW_PRIVATE opt-in; rendering it in the setup wizard
  // only leaves an operator who reaches SMTP through Settings dead-ending on a
  // bare refusal.
  let testHint = ''
  let testing = false
  let saving = false
  let saved = false
  let error = ''

  async function testEmail() {
    // Reset BEFORE the local-validation return, not after it: leaving the
    // previous attempt's hint on screen next to an unrelated
    // "Host … erforderlich" tells the operator to set a flag that has nothing
    // to do with the error being shown.
    testResult = ''
    testError = ''
    testHint = ''
    if (!host || !fromAddress) { testError = 'Host und Absender-Adresse sind erforderlich.'; return }
    testing = true
    try {
      const res = await fetch('/api/setup/test-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host,
          port: Number(port),
          user: testUser,
          password: testPassword,
          from_address: fromAddress,
          to_address: fromAddress,
        }),
      })
      const body = await res.json()
      if (body.success) {
        testResult = 'Test-E-Mail erfolgreich gesendet.'
      } else {
        testError = body.data?.error ?? body.error ?? 'Fehler beim Senden.'
        testHint = body.hint ?? ''
      }
    } catch {
      testError = 'Verbindungsfehler.'
    } finally {
      testing = false
    }
  }

  async function save() {
    saving = true
    saved = false
    error = ''
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smtp: {
            configured: !!host,
            host: host.trim(),
            port: Number(port),
            from_address: fromAddress.trim(),
            from_name: fromName.trim(),
          },
        }),
      })
      if (!res.ok) {
        const body = await res.json()
        error = body.error ?? 'Fehler beim Speichern.'
        return
      }
      saved = true
      setTimeout(() => { saved = false }, 3000)
    } catch {
      error = 'Verbindungsfehler.'
    } finally {
      saving = false
    }
  }
</script>

<div class="space-y-6 py-4">
  <h2 class="text-lg font-semibold">E-Mail (SMTP)</h2>

  <div class="rounded-lg border bg-surface-2/40 px-4 py-3 text-sm text-ink-muted">
    Das SMTP-Passwort wird nicht in den Einstellungen gespeichert. Es muss als Umgebungsvariable
    <code class="font-mono">EMAIL_HOST_PASSWORD</code> gesetzt werden.
  </div>

  <form class="space-y-4 max-w-lg" on:submit|preventDefault={save}>
    <div class="grid grid-cols-3 gap-3">
      <div class="col-span-2 space-y-1">
        <Label for="e-host">SMTP-Host</Label>
        <Input id="e-host" bind:value={host} placeholder="smtp.example.de" />
      </div>
      <div class="space-y-1">
        <Label for="e-port">Port</Label>
        <Input id="e-port" type="number" bind:value={port} min={1} max={65535} />
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="space-y-1">
        <Label for="e-from">Absender-Adresse</Label>
        <Input id="e-from" type="email" bind:value={fromAddress} placeholder="noreply@example.de" />
      </div>
      <div class="space-y-1">
        <Label for="e-name">Absender-Name</Label>
        <Input id="e-name" bind:value={fromName} placeholder={brand.product} />
      </div>
    </div>

    {#if error}
      <p class="text-sm text-rust" role="alert">{error}</p>
    {/if}

    <div class="flex items-center gap-3">
      <Button type="submit" disabled={saving}>{saving ? 'Speichere…' : 'Speichern'}</Button>
      {#if saved}
        <span class="text-sm text-green-600" role="status">Gespeichert ✓</span>
      {/if}
    </div>
  </form>

  <!-- SMTP test section -->
  <div class="rounded-lg border p-4 space-y-3 max-w-lg">
    <h3 class="text-sm font-semibold">Test-E-Mail senden</h3>
    <div class="grid grid-cols-2 gap-3">
      <div class="space-y-1">
        <Label for="e-test-user">SMTP-Benutzer (für Test)</Label>
        <Input id="e-test-user" bind:value={testUser} autocomplete="username" />
      </div>
      <div class="space-y-1">
        <Label for="e-test-pass">Passwort (für Test)</Label>
        <Input id="e-test-pass" type="password" bind:value={testPassword} autocomplete="current-password" />
      </div>
    </div>
    <Button variant="outline" onclick={testEmail} disabled={testing}>
      {testing ? 'Sende…' : 'Test-E-Mail senden'}
    </Button>
    {#if testResult}
      <p class="text-sm text-green-700" role="status">{testResult}</p>
    {/if}
    {#if testError}
      <!-- The hint is the remediation for the refusal, so it lives INSIDE the
           refusal's live region — announced with it, not silently beside it.
           Rendered as TEXT, never {@html}: the string comes from the server
           response body. -->
      <div role="alert" class="space-y-1">
        <p class="text-sm text-rust">{testError}</p>
        {#if testHint}
          <p class="text-xs text-ink-muted" data-testid="smtp-test-hint">{testHint}</p>
        {/if}
      </div>
    {/if}
  </div>
</div>
