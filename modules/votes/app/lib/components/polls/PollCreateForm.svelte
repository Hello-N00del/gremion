<script lang="ts">
  import { enhance } from '$app/forms'
  import { Alert } from '$lib/components/ui/alert'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  interface Props {
    action?: string
    formError?: string | null
    oncreate?: () => void
    oncancel?: () => void
  }

  let {
    action = '?/create',
    formError = null,
    oncreate,
    oncancel,
  }: Props = $props()

  let submitting = $state(false)
  let internalError = $state<string | null>(null)
  const displayError = $derived(internalError ?? formError)
</script>

<form
  method="POST"
  {action}
  use:enhance={() => {
    submitting = true
    internalError = null
    return async ({ update, result }) => {
      submitting = false
      if (result.type === 'failure') {
        const data = result.data as { error?: string } | undefined
        internalError = data?.error ?? 'Fehler beim Erstellen'
      } else if (result.type === 'error') {
        internalError = result.error?.message ?? 'Fehler beim Erstellen'
      } else {
        oncreate?.()
      }
      await update()
    }
  }}
  class="space-y-4 p-6"
>
  <h2 class="text-lg font-semibold">Neue Umfrage erstellen</h2>

  {#if displayError}
    <Alert variant="destructive">{displayError}</Alert>
  {/if}

  <div class="space-y-1">
    <Label for="title">Titel</Label>
    <Input id="title" name="title" required placeholder="Umfragetitel" />
  </div>

  <div class="space-y-1">
    <Label for="options">Optionen <span class="text-ink-muted text-xs">(eine pro Zeile, mind. 2)</span></Label>
    <textarea
      id="options"
      name="options"
      required
      rows="4"
      placeholder={"Option A\nOption B\nOption C"}
      class="w-full rounded-md border border-border-strong bg-paper px-3 py-2 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-accent resize-none"
    ></textarea>
  </div>

  <div class="flex items-center gap-2">
    <input id="anonymous" name="anonymous" type="checkbox" class="h-4 w-4 rounded border-border-strong" />
    <Label for="anonymous">Anonym</Label>
  </div>

  <div class="flex justify-end gap-2 pt-2">
    <Button type="button" variant="outline" onclick={() => oncancel?.()}>Abbrechen</Button>
    <Button type="submit" disabled={submitting}>
      {submitting ? 'Erstelle…' : 'Erstellen'}
    </Button>
  </div>
</form>
