<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { page } from '$app/stores'
  import { resolveBrand } from '$lib/brand'

  export let smtp: { configured: boolean; host: string; port: number; from_address: string; from_name: string }
  export let itAdminEmail: string

  $: brand = resolveBrand($page.data.brand)

  const dispatch = createEventDispatcher<{ advance: void; back: void }>()

  let host = smtp.host ?? ''
  let port = smtp.port ?? 587
  let user = ''
  let password = ''
  let fromAddress = smtp.from_address ?? ''
  let fromName = smtp.from_name ?? ''
  let testResult = ''
  let testError = ''
  // /api/setup/test-smtp refuses non-public targets. Its 400 body carries a
  // `hint` naming the SMTP_TEST_ALLOW_PRIVATE opt-in; without showing it, an
  // operator pointing at an internal relay sees a bare refusal with nothing to
  // act on. The second consumer, routes/settings/tabs/TabEmail.svelte, does
  // the same.
  let testHint = ''
  let testing = false
  let saving = false
  let error = ''
  let skippedWithWarning = false

  async function sendTestEmail() {
    // Reset BEFORE the local-validation return, not after it: otherwise a stale
    // refusal hint stays on screen next to an unrelated "Host … erforderlich".
    testResult = ''
    testError = ''
    testHint = ''
    if (!host || !fromAddress) {
      testError = 'Host und Absender-Adresse sind erforderlich.'
      return
    }
    testing = true
    try {
      const res = await fetch('/api/setup/test-smtp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host,
          port: Number(port),
          user,
          password,
          from_address: fromAddress,
          to_address: itAdminEmail || fromAddress,
        }),
      })
      const body = await res.json()
      if (body.success) {
        testResult = 'Verbindung erfolgreich – Test-E-Mail gesendet.'
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

  async function saveAndAdvance(skipEmail = false) {
    saving = true
    error = ''
    try {
      const res = await fetch('/api/setup/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          smtp: {
            configured: !skipEmail && !!host,
            host: host.trim(),
            port: Number(port),
            from_address: fromAddress.trim(),
            from_name: fromName.trim(),
            // NOTE: SMTP password is NOT stored in config — must be set in environment variables
          },
          wizard_steps: { smtp: 'complete' },
        }),
      })
      if (!res.ok) {
        const body = await res.json()
        error = body.error ?? 'Fehler beim Speichern.'
        return
      }
      if (skipEmail) skippedWithWarning = true
      dispatch('advance')
    } catch {
      error = 'Verbindungsfehler.'
    } finally {
      saving = false
    }
  }
</script>

<div class="space-y-6">
  <div>
    <h2 class="text-xl font-semibold">E-Mail (SMTP)</h2>
    <p class="mt-1 text-sm text-ink-muted">
      Konfiguriert den ausgehenden E-Mail-Server für Benachrichtigungen.
      Das SMTP-Passwort wird nicht gespeichert – es muss als Umgebungsvariable gesetzt werden.
    </p>
  </div>

  <form class="space-y-4" on:submit|preventDefault={() => saveAndAdvance(false)}>
    <div class="grid grid-cols-3 gap-3">
      <div class="col-span-2 space-y-1">
        <Label for="smtp-host">SMTP-Host *</Label>
        <Input id="smtp-host" bind:value={host} placeholder="smtp.example.de" aria-required="true" />
      </div>
      <div class="space-y-1">
        <Label for="smtp-port">Port</Label>
        <Input id="smtp-port" type="number" bind:value={port} min={1} max={65535} />
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="space-y-1">
        <Label for="smtp-user">Benutzername</Label>
        <Input id="smtp-user" bind:value={user} autocomplete="username" />
      </div>
      <div class="space-y-1">
        <Label for="smtp-password">Passwort (nur für Test)</Label>
        <Input id="smtp-password" type="password" bind:value={password} autocomplete="current-password" />
        <p class="text-xs text-ink-muted">Wird nicht gespeichert</p>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <div class="space-y-1">
        <Label for="smtp-from">Absender-Adresse *</Label>
        <Input id="smtp-from" type="email" bind:value={fromAddress} placeholder="noreply@example.de" aria-required="true" />
      </div>
      <div class="space-y-1">
        <Label for="smtp-name">Absender-Name</Label>
        <Input id="smtp-name" bind:value={fromName} placeholder={brand.product} />
      </div>
    </div>

    <!-- SMTP test -->
    <div class="rounded-lg border bg-surface-2/30 p-4 space-y-2">
      <div class="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onclick={sendTestEmail} disabled={testing}>
          {testing ? 'Sende…' : 'Test-E-Mail senden'}
        </Button>
        {#if itAdminEmail}
          <span class="text-xs text-ink-muted">Empfänger: {itAdminEmail}</span>
        {/if}
      </div>
      {#if testResult}
        <p class="text-sm text-green-700" role="status">{testResult}</p>
      {/if}
      {#if testError}
        <!-- The hint is the remediation for the refusal, so it lives INSIDE the
             refusal's live region — in a sibling <p> assistive tech never
             announces it. Rendered as TEXT, never {@html}: the string comes
             from the server response body. -->
        <div role="alert" class="space-y-1">
          <p class="text-sm text-rust">{testError}</p>
          {#if testHint}
            <p class="text-xs text-ink-muted" data-testid="smtp-test-hint">{testHint}</p>
          {/if}
        </div>
      {/if}
    </div>

    {#if error}
      <p class="text-sm text-rust" role="alert">{error}</p>
    {/if}

    <div class="flex items-center justify-between pt-2">
      <Button type="button" variant="outline" onclick={() => dispatch('back')}>Zurück</Button>
      <div class="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={saving}
          onclick={() => saveAndAdvance(true)}
        >
          Überspringen
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? 'Speichere…' : 'Weiter'}
        </Button>
      </div>
    </div>

    {#if skippedWithWarning}
      <p class="text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-3 py-2" role="alert">
        E-Mail nicht konfiguriert. Systembenachrichtigungen sind deaktiviert bis SMTP eingerichtet ist.
      </p>
    {/if}
  </form>
</div>
