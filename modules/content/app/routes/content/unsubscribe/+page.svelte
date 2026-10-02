<script lang="ts">
  import type { ActionData, PageData } from './$types'

  export let data: PageData
  export let form: ActionData

  // K5#19: the GET only shows a confirmation; the POST below consumes the token.
  $: status = form?.status ?? data.status
</script>

<div class="flex min-h-screen items-center justify-center p-8">
  <div class="max-w-md w-full rounded-lg border p-8 text-center">
    {#if status === 'confirm'}
      <h1 class="text-2xl font-semibold mb-4">Vom Verteiler abmelden?</h1>
      <p class="text-ink-muted mb-6">Bestätige, dass du keine weiteren E-Mails mehr von uns erhalten möchtest.</p>
      <form method="POST">
        <input type="hidden" name="token" value={data.token} />
        <button type="submit" class="rounded-md border px-4 py-2 font-medium">Abmelden</button>
      </form>
    {:else if status === 'ok'}
      <h1 class="text-2xl font-semibold mb-4">Erfolgreich abgemeldet</h1>
      <p class="text-ink-muted">Du erhältst keine weiteren E-Mails mehr von uns.</p>
    {:else if status === 'expired'}
      <h1 class="text-2xl font-semibold mb-4">Link abgelaufen</h1>
      <p class="text-ink-muted">Dieser Abmeldelink ist abgelaufen.</p>
    {:else}
      <h1 class="text-2xl font-semibold mb-4">Ungültiger Link</h1>
      <p class="text-ink-muted">Dieser Abmeldelink ist ungültig oder wurde bereits verwendet.</p>
    {/if}
  </div>
</div>
