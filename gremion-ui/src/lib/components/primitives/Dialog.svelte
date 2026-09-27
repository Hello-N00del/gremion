<script lang="ts">
  // primitives/Dialog: the WAI-ARIA APG modal dialog, as a thin Bits UI
  // wrapper (TRD-413, TASK-082). Bits UI supplies role="dialog",
  // aria-modal, aria-labelledby -> Title, aria-describedby -> Description,
  // the focus trap, Escape, focus return to the trigger and the <body> scroll
  // lock; this wrapper adds the #main-content lock (modal.ts parity) and the
  // component-tier token styling. Every accessible name and visible string is
  // a prop: nothing here is written in one language.
  import { Dialog } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { lockMainContent } from './scroll-lock'

  interface Props {
    /** Open state; bindable. */
    open?: boolean
    onOpenChange?: (open: boolean) => void
    /** Visible title; also the dialog's accessible name (aria-labelledby). */
    title: string
    /** Optional visible description (aria-describedby). */
    description?: string
    /** Accessible name of the icon-only close button. */
    closeLabel: string
    /** Text of a default trigger button. Omit it to supply `trigger` or to control `open` only. */
    triggerLabel?: string
    /** A custom trigger; spread `props` onto the element that opens the dialog. */
    trigger?: Snippet<[{ props: Record<string, unknown> }]>
    children?: Snippet
    footer?: Snippet
  }

  let {
    open = $bindable(false),
    onOpenChange,
    title,
    description,
    closeLabel,
    triggerLabel,
    trigger,
    children,
    footer,
  }: Props = $props()

  $effect(() => {
    if (!open) return
    return lockMainContent()
  })
</script>

<Dialog.Root bind:open {onOpenChange}>
  {#if trigger}
    <Dialog.Trigger>
      {#snippet child({ props })}
        {@render trigger({ props })}
      {/snippet}
    </Dialog.Trigger>
  {:else if triggerLabel}
    <Dialog.Trigger class="gp-dialog-trigger">{triggerLabel}</Dialog.Trigger>
  {/if}
  <Dialog.Portal>
    <Dialog.Overlay class="gp-dialog-overlay" />
    <Dialog.Content class="gp-dialog">
      <div class="gp-dialog-head">
        <Dialog.Title class="gp-dialog-title">{title}</Dialog.Title>
        <Dialog.Close class="gp-dialog-close" aria-label={closeLabel}>
          <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
          </svg>
        </Dialog.Close>
      </div>
      {#if description}
        <Dialog.Description class="gp-dialog-description">{description}</Dialog.Description>
      {/if}
      {@render children?.()}
      {#if footer}
        <div class="gp-dialog-footer">{@render footer()}</div>
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  /* Component-tier tokens only (--dialog-*); see packages/tokens. */
  :global(.gp-dialog-overlay) {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: var(--dialog-scrim);
  }
  :global(.gp-dialog) {
    position: fixed;
    left: 50%;
    top: 50%;
    z-index: 50;
    transform: translate(-50%, -50%);
    display: grid;
    gap: var(--dialog-gap);
    width: min(var(--dialog-width), calc(100vw - 2 * var(--dialog-padding)));
    max-height: calc(100dvh - 2 * var(--dialog-padding));
    overflow: auto;
    padding: var(--dialog-padding);
    color: var(--dialog-text);
    background: var(--dialog-background);
    border: 1px solid var(--dialog-border);
    border-radius: var(--dialog-radius);
    box-shadow: var(--dialog-shadow);
    transition: opacity var(--dialog-duration) var(--dialog-easing);
  }
  :global(.gp-dialog-head) {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--dialog-gap);
  }
  :global(.gp-dialog-title) {
    margin: 0;
    font: var(--dialog-title-font);
    letter-spacing: var(--dialog-title-font-tracking);
  }
  :global(.gp-dialog-description) {
    margin: 0;
    font: var(--dialog-description-font);
    letter-spacing: var(--dialog-description-font-tracking);
    color: var(--dialog-text-muted);
  }
  :global(.gp-dialog-close) {
    display: inline-grid;
    place-items: center;
    flex: none;
    min-width: var(--dialog-close-size);
    min-height: var(--dialog-close-size);
    color: inherit;
    background: transparent;
    border: 0;
    border-radius: var(--dialog-radius);
    cursor: pointer;
  }
  :global(.gp-dialog-close:focus-visible),
  :global(.gp-dialog-trigger:focus-visible) {
    outline: 2px solid var(--dialog-focus-ring);
    outline-offset: 2px;
  }
  :global(.gp-dialog-footer) {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--dialog-gap);
  }
</style>
