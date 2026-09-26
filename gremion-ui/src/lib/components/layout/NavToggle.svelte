<script lang="ts">
  // Rail <-> expanded toggle (TASK-208, UX-071a AC-3). Its accessible name
  // stays 'Seitenleiste'; aria-expanded carries the state, and the description
  // says the choice is stored on this device. `expanded` is null until the
  // shell has hydrated and knows the state, so SSR never guesses it.
  import Icon from '$lib/components/ui/Icon.svelte'
  import { DEFAULT_NAV_LABELS, type NavLabels } from './nav-labels'

  let {
    expanded = null,
    ontoggle,
    labels = DEFAULT_NAV_LABELS
  }: { expanded?: boolean | null; ontoggle?: () => void; labels?: NavLabels } = $props()
</script>

<button
  type="button"
  class="nav-toggle"
  aria-label={labels['nav.sidebar']}
  aria-expanded={expanded === null ? undefined : expanded}
  aria-describedby="nav-toggle-desc"
  data-nav-label={labels['nav.sidebar']}
  onclick={() => ontoggle?.()}
>
  <Icon name="sidebar" size={18} />
</button>
<span id="nav-toggle-desc" hidden>{labels['nav.sidebar.saved']}</span>

<style>
  .nav-toggle {
    width: var(--nav-control);
    height: var(--nav-control);
    flex-shrink: 0;
    display: grid;
    place-items: center;
    border: none;
    background: transparent;
    color: var(--ink-2);
    border-radius: var(--r-sm);
    cursor: pointer;
    transition: background var(--d-fast) var(--e-out);
  }
  .nav-toggle:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
  .nav-toggle:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
</style>
