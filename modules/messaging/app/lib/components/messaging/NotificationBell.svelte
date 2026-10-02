<script lang="ts">
  // The notification bell of the TopBar's `bell` slot part (TASK-205b; UX-071a.6). TopBar owns the wrapper
  // (data-topbar-slot="bell"): below 768 px it makes this button at least the shell control size (44 CSS px)
  // and keeps it. This component owns the button, its accessible name, the unread dot and the popover.
  //
  // Source of truth: the layout's `counts.unread`, the same Matrix unread total the 'Nachrichten' rail entry
  // reads (routes/+layout.server.ts). The aggregated feed of the source (finance approvals, elections,
  // protocols) needs a notifications API the kernel does not carry (shell port list: found -> TASK-011), so
  // the popover shows the chat source only and links to /messages. Opening it never marks anything read:
  // reading is explicit, in the room.
  import { page } from '$app/state'
  import { tick } from 'svelte'
  import Icon from '$lib/components/ui/Icon.svelte'

  const unread = $derived(Number((page.data as { counts?: { unread?: number } }).counts?.unread ?? 0))
  const hasUnread = $derived(unread > 0)

  let open = $state(false)
  let bellBtn = $state<HTMLButtonElement | null>(null)
  let pop = $state<HTMLDivElement | null>(null)

  async function toggle() {
    open = !open
    if (open) {
      await tick()
      pop?.focus()
    }
  }

  function close(returnFocus = false) {
    open = false
    if (returnFocus) bellBtn?.focus()
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      close(true)
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="ntf-wrap">
  <button
    type="button"
    class="icon-btn"
    bind:this={bellBtn}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={hasUnread ? 'Benachrichtigungen, Ungelesenes vorhanden' : 'Benachrichtigungen'}
    title="Benachrichtigungen"
    onclick={toggle}
  >
    <Icon name="bell" size={16} />
    {#if hasUnread}<span class="dot" aria-hidden="true"></span>{/if}
  </button>
  {#if open}
    <!-- Scrim: click-out closes (the same overlay idiom as the command palette). -->
    <div class="ntf-scrim" role="presentation" onclick={() => close()}></div>
    <div class="ntf-pop card" role="dialog" aria-label="Benachrichtigungen" tabindex="-1" bind:this={pop}>
      <div class="ntf-head"><strong>Benachrichtigungen</strong></div>
      {#if hasUnread}
        <a class="ntf-row unread" href="/messages" onclick={() => close()}>
          <span class="ntf-ico"><Icon name="chat" size={14} /></span>
          <span class="ntf-txt">
            <b>{unread === 1 ? '1 ungelesene Nachricht' : `${unread} ungelesene Nachrichten`}</b>
            <span>Matrix · Chat</span>
          </span>
          <span class="ntf-dot" aria-hidden="true"></span>
        </a>
      {:else}
        <div class="ntf-empty">Keine Benachrichtigungen.</div>
      {/if}
      <div class="ntf-foot">Gelesen wird im Raum selbst; hier wird nichts als gelesen markiert.</div>
    </div>
  {/if}
</div>

<style>
  .ntf-wrap {
    position: relative;
  }
  /* The dot anchors to the button (the canonical .icon-btn is position: relative); keyed on .ntf-wrap, not
     .icon-btn, because icon-btn-canonical.test.ts forbids any scoped .icon-btn rule. */
  .ntf-wrap .dot {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ember);
    box-shadow: 0 0 0 2px var(--surface);
  }
  .ntf-scrim {
    position: fixed;
    inset: 0;
    z-index: 110;
  }
  /* UX-071a.6: min(348px, 100vw - 32px), so the popover never leaves a 320 px viewport. */
  .ntf-pop {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    width: min(348px, 100vw - 32px);
    z-index: 120;
    padding: 0;
    box-shadow: var(--sh-3);
  }
  .ntf-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 11px 14px;
    border-bottom: 1px solid var(--border);
  }
  .ntf-head strong {
    font-family: var(--font-display);
    font-size: 13.5px;
  }
  .ntf-row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    text-decoration: none;
    color: inherit;
  }
  .ntf-row:hover {
    background: var(--surface-2);
  }
  .ntf-row.unread {
    background: var(--accent-faint);
  }
  .ntf-row.unread:hover {
    background: var(--accent-soft);
  }
  .ntf-ico {
    width: 26px;
    height: 26px;
    border-radius: 7px;
    display: grid;
    place-items: center;
    background: var(--surface-2);
    color: var(--ink-muted);
    flex-shrink: 0;
  }
  .ntf-txt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .ntf-txt b {
    font-size: 12.5px;
    font-weight: 600;
  }
  .ntf-txt span {
    font-size: 11.5px;
    color: var(--ink-muted);
    line-height: 1.4;
  }
  .ntf-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    flex-shrink: 0;
    margin-top: 5px;
  }
  .ntf-foot {
    padding: 9px 14px;
    font-size: 10.5px;
    color: var(--ink-faint);
    line-height: 1.45;
  }
  .ntf-empty {
    padding: 14px;
    font-size: 12px;
    color: var(--ink-muted);
  }
</style>
