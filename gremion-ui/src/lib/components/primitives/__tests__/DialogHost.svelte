<script lang="ts">
  // Test host for primitives/Dialog.svelte: a trigger, a focusable body and an
  // optional nested (stacked) dialog. Strings come from props, as in the app.
  import Dialog from '../Dialog.svelte'

  interface Props {
    title: string
    description?: string
    closeLabel: string
    triggerLabel: string
    confirmLabel: string
    nested?: { title: string; closeLabel: string; triggerLabel: string } | null
  }
  let { title, description, closeLabel, triggerLabel, confirmLabel, nested = null }: Props = $props()
</script>

<main id="main-content" style="overflow: auto">
  <button type="button">before</button>
  <Dialog {title} {description} {closeLabel} {triggerLabel}>
    <label>Name <input name="n" /></label>
    <button type="button">{confirmLabel}</button>
    {#if nested}
      <Dialog title={nested.title} closeLabel={nested.closeLabel} triggerLabel={nested.triggerLabel}>
        <button type="button">inner action</button>
      </Dialog>
    {/if}
  </Dialog>
</main>
