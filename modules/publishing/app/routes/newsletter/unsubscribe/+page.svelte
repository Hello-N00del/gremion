<script lang="ts">
  import { page } from '$app/stores'
  import { onMount } from 'svelte'

  let status: 'loading' | 'success' | 'error' = 'loading'
  let errorMessage = ''

  onMount(async () => {
    const token = $page.url.searchParams.get('token')
    if (!token) {
      status = 'error'
      errorMessage = 'Kein gültiger Token angegeben.'
      return
    }
    try {
      const res = await fetch(`/api/newsletter/unsubscribe?token=${encodeURIComponent(token)}`)
      if (res.ok) {
        status = 'success'
      } else {
        const data = await res.json()
        status = 'error'
        errorMessage = data.error ?? 'Ungültiger oder abgelaufener Link.'
      }
    } catch {
      status = 'error'
      errorMessage = 'Netzwerkfehler. Bitte versuche es erneut.'
    }
  })
</script>

<div class="flex min-h-screen items-center justify-center p-8">
  <div class="max-w-md w-full rounded-lg border p-8 text-center">
    {#if status === 'loading'}
      <p class="text-ink-muted">Wird verarbeitet…</p>
    {:else if status === 'success'}
      <h1 class="text-2xl font-semibold mb-4">Erfolgreich abgemeldet</h1>
      <p class="text-ink-muted">
        Du erhältst keine weiteren Newsletter mehr von uns.
      </p>
    {:else}
      <h1 class="text-2xl font-semibold mb-4">Fehler</h1>
      <p class="text-ink-muted">{errorMessage}</p>
    {/if}
  </div>
</div>
