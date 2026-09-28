<script lang="ts">
  import type { PageData } from './$types'

  export let data: PageData
</script>

<div class="flex min-h-screen items-center justify-center p-8">
  <div class="max-w-md w-full rounded-lg border p-8 text-center">
    {#if data.status === 'ok'}
      <h1 class="text-2xl font-semibold mb-4">Erfolgreich abgemeldet</h1>
      <p class="text-ink-muted">Du erhältst keine weiteren E-Mails mehr von uns.</p>
    {:else if data.status === 'expired'}
      <h1 class="text-2xl font-semibold mb-4">Link abgelaufen</h1>
      <p class="text-ink-muted">Dieser Abmeldelink ist abgelaufen.</p>
    {:else}
      <h1 class="text-2xl font-semibold mb-4">Ungültiger Link</h1>
      <p class="text-ink-muted">Dieser Abmeldelink ist ungültig oder wurde bereits verwendet.</p>
    {/if}
  </div>
</div>
