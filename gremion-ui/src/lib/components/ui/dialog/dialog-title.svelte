<script lang="ts">
  import { cn } from '$lib/utils'
  import { getDialogContext } from './context'

  interface Props {
    class?: string
    /** Override the heading id. Defaults to the parent Dialog's generated titleId. */
    id?: string
    children?: import('svelte').Snippet
  }

  let { class: className = '', id, children }: Props = $props()

  // Pull the id from the parent Dialog so it matches aria-labelledby, and tell the
  // Dialog a title exists. Falls back gracefully if used outside a Dialog.
  const ctx = getDialogContext()
  const headingId = $derived(id ?? ctx?.titleId)
  ctx?.registerTitle()
</script>

<h2 id={headingId} class={cn('text-lg font-semibold leading-none tracking-tight', className)}>
  {@render children?.()}
</h2>
