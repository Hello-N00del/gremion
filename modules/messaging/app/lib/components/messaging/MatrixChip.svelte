<!-- The Matrix status chip of the TopBar's `chips` slot part (TASK-205b; was inline in the source TopBar).
     TopBar owns the wrapper (data-topbar-slot="chips", hidden below the rail breakpoint, where the same
     chip lives in the navigation drawer); this component owns what is drawn inside it. -->
<span class="mx-chip" title="Matrix synchronisiert">
  <span class="pulse" aria-hidden="true"></span> Matrix
</span>

<style>
  .mx-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 9px;
    border-radius: 100px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--ink-muted);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 500;
    background: var(--surface-2);
    border: 1px solid var(--border);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .pulse {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--pine);
    box-shadow: 0 0 0 2px var(--pine-soft);
  }
</style>
