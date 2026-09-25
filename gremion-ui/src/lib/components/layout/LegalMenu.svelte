<script lang="ts">
  // Legal links and the AGPL section 13 source offer (TASK-208). Inline in the
  // expanded sidebar and in the drawer; in the icon rail they sit behind one
  // disclosure button ('Rechtliches'), because a 64 px column cannot hold them.
  import Icon from '$lib/components/ui/Icon.svelte'
  import { DEFAULT_NAV_LABELS, type NavLabels } from './nav-labels'
  import { SOURCE_OFFER_LABEL } from '$lib/source-offer'

  let {
    sourceUrl,
    idPrefix,
    onnavigate,
    labels = DEFAULT_NAV_LABELS
  }: { sourceUrl: string; idPrefix: string; onnavigate?: (href: string) => void; labels?: NavLabels } = $props()

  let open = $state(false)
  let button: HTMLButtonElement | undefined = $state()
  let wrap: HTMLElement | undefined = $state()

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      e.stopPropagation()
      open = false
      button?.focus()
    }
  }

  function onfocusout(e: FocusEvent) {
    if (open && wrap && !(e.relatedTarget instanceof Node && wrap.contains(e.relatedTarget))) open = false
  }

  const LINKS = [
    { href: '/legal/impressum', label: 'Impressum' },
    { href: '/legal/datenschutz', label: 'Datenschutz' },
    { href: '/legal/barrierefreiheit', label: 'Barrierefreiheit' }
  ]
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (Escape/focus-out close the rail disclosure; the wrapper is not a control) -->
<div class="sb-legal-wrap" bind:this={wrap} {onkeydown} {onfocusout}>
  <button
    bind:this={button}
    type="button"
    class="legal-btn nav-rail-only"
    aria-label={labels['nav.legal']}
    aria-expanded={open}
    aria-controls="{idPrefix}-legal"
    data-nav-label={labels['nav.legal']}
    onclick={() => (open = !open)}
  >
    <Icon name="scale" size={18} />
  </button>
  <ul class="legal-list sb-legal" class:open id="{idPrefix}-legal">
    {#each LINKS as l (l.href)}
      <li><a href={l.href} onclick={() => onnavigate?.(l.href)}>{l.label}</a></li>
    {/each}
    <li class="sb-source">
      <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{SOURCE_OFFER_LABEL}</a>
    </li>
  </ul>
</div>

<style>
  .sb-legal-wrap {
    border-top: 1px solid var(--border);
    padding: 6px 12px 8px;
    display: flex;
    justify-content: center;
  }
  .legal-btn {
    width: var(--nav-control, 44px);
    height: var(--nav-control, 44px);
    place-items: center;
    justify-content: center;
    align-items: center;
    border: none;
    background: transparent;
    color: var(--ink-muted);
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .legal-btn:hover {
    background: var(--surface-2);
    color: var(--ink);
  }
  .legal-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    column-gap: 10px;
  }
  .legal-list a {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 2px 2px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
    text-decoration: none;
    overflow-wrap: anywhere;
    transition: color var(--d-fast) var(--e-out);
  }
  .legal-list a:hover {
    color: var(--ink);
  }
  .sb-source {
    flex-basis: 100%;
    display: flex;
    justify-content: center;
  }
</style>
