<script lang="ts">
  import { cn } from '$lib/utils'
  import { modal } from '$lib/actions/modal'
  import { setDialogContext } from './context'

  interface Props {
    open?: boolean
    onClose?: () => void
    class?: string
    /**
     * Accessible name fallback for title-less dialogs. Used when no DialogTitle
     * is rendered; when a title exists it labels the dialog via aria-labelledby.
     */
    'aria-label'?: string
    children?: import('svelte').Snippet
  }

  let {
    open = false,
    onClose,
    class: className = '',
    'aria-label': ariaLabel,
    children,
  }: Props = $props()

  // Stable per-instance id so DialogTitle can label the container via
  // aria-labelledby. $props.id() is SSR-safe and unique per component instance.
  const titleId = $props.id()
  // DialogTitle calls registerTitle() on mount; until then we fall back to aria-label.
  let hasTitle = $state(false)
  setDialogContext({ titleId, registerTitle: () => (hasTitle = true) })

  function handleKeydown(event: KeyboardEvent) {
    // stopPropagation: prevents keyboard events from leaking to parent handlers
    // Required due to known event leak in shadcn-svelte v4 Dialog (issue #10152)
    event.stopPropagation()
    if (event.key === 'Escape') onClose?.()
  }
</script>

{#if open}
  <button
    type="button"
    aria-label="Dialog schließen"
    class="fixed inset-0 z-40 bg-scrim backdrop-blur-xs border-0 cursor-default w-full"
    onclick={onClose}
    tabindex="-1"
  ></button>
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby={hasTitle ? titleId : undefined}
    aria-label={hasTitle ? undefined : ariaLabel}
    tabindex="-1"
    use:modal
    class={cn(
      'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-surface p-6 shadow-[var(--sh-3)] duration-200 sm:rounded-lg',
      className
    )}
    onkeydown={handleKeydown}
  >
    {@render children?.()}
  </div>
{/if}
