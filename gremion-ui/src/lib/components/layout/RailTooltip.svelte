<script lang="ts">
  // Icon-rail tooltip (TASK-208, UX-071a AC-5; WCAG 1.4.13). While the column
  // is a rail, keyboard focus or hover on an element carrying data-nav-label
  // shows that label beside it; Escape hides it without moving focus. The
  // tooltip is aria-hidden: the element's accessible name already carries the
  // label, so it is never announced twice. Fixed positioning keeps it clear of
  // the column's overflow clipping.
  let { container, enabled = false }: { container?: HTMLElement; enabled?: boolean } = $props()

  let text = $state('')
  let top = $state(0)
  let left = $state(0)
  let visible = $state(false)
  let overTip = false
  let anchor: HTMLElement | null = null

  function labelled(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>('[data-nav-label]') : null
  }

  function show(el: HTMLElement) {
    if (!enabled) return
    const r = el.getBoundingClientRect()
    anchor = el
    text = el.dataset.navLabel ?? ''
    top = r.top + r.height / 2
    left = r.right + 8
    visible = text !== ''
  }

  function hide() {
    visible = false
    anchor = null
  }

  // An effect, not onMount: the column's bind:this lands after this child mounts.
  $effect(() => {
    const el = container
    if (!el) return
    const onFocusIn = (e: FocusEvent) => {
      const t = labelled(e.target)
      if (t) show(t)
    }
    const onFocusOut = (e: FocusEvent) => {
      if (!labelled(e.relatedTarget)) hide()
    }
    const onOver = (e: MouseEvent) => {
      const t = labelled(e.target)
      if (t && t !== anchor) show(t)
    }
    const onLeave = () => {
      // Leaving the column towards the tooltip keeps it (1.4.13 hoverable).
      setTimeout(() => {
        if (!overTip && !(document.activeElement && labelled(document.activeElement) && el.contains(document.activeElement))) hide()
      }, 0)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && visible) hide()
    }
    // A fixed tooltip does not follow its anchor: hide it when things move,
    // and when focus goes anywhere outside the column (a hover tip must not
    // sit over the control a keyboard user just reached).
    const onMove = () => hide()
    const onDocFocus = (e: FocusEvent) => {
      if (!(e.target instanceof Node && el.contains(e.target))) hide()
    }
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    el.addEventListener('mouseover', onOver)
    el.addEventListener('mouseleave', onLeave)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    document.addEventListener('focusin', onDocFocus)
    return () => {
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
      el.removeEventListener('mouseover', onOver)
      el.removeEventListener('mouseleave', onLeave)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      document.removeEventListener('focusin', onDocFocus)
    }
  })

  $effect(() => {
    if (!enabled) hide()
  })
</script>

{#if visible && enabled}
  <div
    class="rail-tip"
    aria-hidden="true"
    style:top="{top}px"
    style:left="{left}px"
    onmouseenter={() => (overTip = true)}
    onmouseleave={() => {
      overTip = false
      hide()
    }}
  >
    {text}
  </div>
{/if}

<style>
  .rail-tip {
    position: fixed;
    z-index: 70;
    transform: translateY(-50%);
    padding: 5px 9px;
    border-radius: var(--r-sm);
    background: var(--ink);
    color: var(--paper);
    font-size: 12.5px;
    line-height: 1.3;
    white-space: nowrap;
    box-shadow: var(--sh-2);
  }
</style>
