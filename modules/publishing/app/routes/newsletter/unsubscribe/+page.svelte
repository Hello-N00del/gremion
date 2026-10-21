<script lang="ts">
  import { page } from '$app/stores'

  // The mailed link lands here. Mail-security scanners and prefetchers GET every
  // link in a message, so opening this page must not touch the single-use token:
  // nothing is requested on load. The recipient's click POSTs the token (in a
  // JSON body, not in the URL) to /api/newsletter/unsubscribe.
  let phase: 'confirm' | 'busy' | 'success' | 'error' = 'confirm'
  let errorMessage = ''

  $: token = $page.url.searchParams.get('token') ?? ''

  function messageFor(status: number): string {
    if (status === 410) return 'Dieser Abmeldelink ist abgelaufen.'
    if (status === 429) return 'Zu viele Versuche. Bitte versuche es später erneut.'
    if (status === 503) return 'Die Abmeldung ist gerade nicht verfügbar. Bitte versuche es später erneut.'
    return 'Ungültiger oder bereits verwendeter Link.'
  }

  async function confirm() {
    if (!token || phase === 'busy') return
    phase = 'busy'
    try {
      const res = await fetch('/api/newsletter/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (res.ok) {
        phase = 'success'
      } else {
        errorMessage = messageFor(res.status)
        phase = 'error'
      }
    } catch {
      errorMessage = 'Netzwerkfehler. Bitte versuche es erneut.'
      phase = 'error'
    }
  }
</script>

<div class="flex min-h-screen items-center justify-center p-8">
  <div class="max-w-md w-full rounded-lg border p-8 text-center">
    {#if !token}
      <h1 class="text-2xl font-semibold mb-4">Fehler</h1>
      <p class="text-ink-muted">Kein gültiger Token angegeben.</p>
    {:else if phase === 'success'}
      <h1 class="text-2xl font-semibold mb-4">Erfolgreich abgemeldet</h1>
      <p class="text-ink-muted">
        Du erhältst keine weiteren Newsletter mehr von uns.
      </p>
    {:else if phase === 'error'}
      <h1 class="text-2xl font-semibold mb-4">Fehler</h1>
      <p class="text-ink-muted">{errorMessage}</p>
    {:else}
      <h1 class="text-2xl font-semibold mb-4">Vom Newsletter abmelden?</h1>
      <p class="text-ink-muted mb-6">Du erhältst danach keine weiteren Newsletter mehr von uns.</p>
      <form on:submit|preventDefault={confirm}>
        <button type="submit" class="rounded-md border px-4 py-2 font-medium" disabled={phase === 'busy'}>
          Abmeldung bestätigen
        </button>
      </form>
    {/if}
  </div>
</div>
