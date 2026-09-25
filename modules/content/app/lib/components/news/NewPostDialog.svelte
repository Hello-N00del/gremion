<script lang="ts">
  import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { t } from '$lib/i18n'

  interface Props {
    open: boolean
    busy?: boolean
    onClose: () => void
    /** Resolve with the trimmed title; parent performs the create request. */
    onSubmit: (title: string) => void
  }

  let { open, busy = false, onClose, onSubmit }: Props = $props()

  let title = $state('')

  // Reset the field whenever the dialog is (re)opened.
  $effect(() => {
    if (open) title = ''
  })

  function submit() {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    onSubmit(trimmed)
  }
</script>

<Dialog {open} {onClose}>
  <DialogHeader>
    <DialogTitle>{$t('news.create.title')}</DialogTitle>
  </DialogHeader>

  <form
    class="space-y-1.5 py-2"
    onsubmit={(e) => {
      e.preventDefault()
      submit()
    }}
  >
    <Label for="np-title">{$t('news.create.titleLabel')}</Label>
    <!-- svelte-ignore a11y_autofocus -->
    <Input
      id="np-title"
      bind:value={title}
      placeholder={$t('news.create.titlePlaceholder')}
      autofocus
      disabled={busy}
    />
  </form>

  <DialogFooter>
    <Button variant="outline" onclick={onClose} disabled={busy}>
      {$t('news.create.cancel')}
    </Button>
    <Button onclick={submit} disabled={!title.trim() || busy}>
      {busy ? $t('news.create.creating') : $t('news.create.submit')}
    </Button>
  </DialogFooter>
</Dialog>
