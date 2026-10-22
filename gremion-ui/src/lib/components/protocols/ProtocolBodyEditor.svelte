<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { textToBodyHtml, bodyHtmlToText, isPlainBody } from '$lib/governance/protocol-body-text'

  // R33b: the in-app protocol body (protocols.body_html) for installs without
  // the files module / without a Collabora ODT. Plain text: blank line =
  // new paragraph. Saved through the existing PATCH while the protocol is a
  // draft; the server sanitizes on write.
  let { protocolId, bodyHtml }: { protocolId: string; bodyHtml: string | null } = $props()

  let text = $state(bodyHtmlToText(bodyHtml ?? ''))
  const flattens = !isPlainBody(bodyHtml)
  let saving = $state(false)
  let status = $state<'idle' | 'saved' | 'error'>('idle')

  async function save() {
    saving = true
    status = 'idle'
    try {
      const res = await fetch(`/api/protocols/${protocolId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bodyHtml: textToBodyHtml(text) }),
      })
      status = res.ok ? 'saved' : 'error'
    } catch {
      status = 'error'
    } finally {
      saving = false
    }
  }
</script>

<div class="space-y-2">
  <label for="protokolltext" class="block text-sm font-medium">Protokolltext</label>
  <p id="protokolltext-hint" class="text-xs text-ink-muted">
    Eine Leerzeile beginnt einen neuen Absatz.{#if flattens} Der vorhandene Text enthält Formatierungen; beim Speichern bleibt nur reiner Text erhalten.{/if}
  </p>
  <textarea
    id="protokolltext"
    class="w-full min-h-64 rounded-md border bg-surface p-3 text-sm"
    aria-describedby="protokolltext-hint"
    bind:value={text}
    oninput={() => (status = 'idle')}
  ></textarea>
  <div class="flex items-center gap-3">
    <Button size="sm" onclick={save} disabled={saving}>{saving ? 'Speichern …' : 'Protokolltext speichern'}</Button>
    <span role="status" class="text-sm">
      {#if status === 'saved'}Gespeichert.{:else if status === 'error'}Speichern fehlgeschlagen.{/if}
    </span>
  </div>
</div>
