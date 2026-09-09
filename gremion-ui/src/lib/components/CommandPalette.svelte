<script lang="ts" module>
  // A flat, searchable command. `kind` drives the section grouping in the list.
  export type PaletteCommand =
    | { kind: 'page'; label: string; href: string; icon?: string; hint?: string }
    | { kind: 'action'; label: string; href: string; icon?: string; hint?: string }
</script>

<script lang="ts">
  import { goto } from '$app/navigation'
  import { tick } from 'svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { NavItem } from '$lib/components/layout/nav-schema'
  import { themeMode } from '$lib/stores/theme'

  // `nav` is the SAME role/PAGE_ACCESS-filtered tree the sidebar renders, so the
  // palette can never surface a page the user is not allowed to reach. `actions`
  // are likewise gated upstream (the caller only passes ones the role permits).
  let {
    open = $bindable(false),
    nav = []
  }: {
    open?: boolean
    nav?: NavItem[]
  } = $props()

  // Quick actions — institutional Sie-Form labels. Theme-toggle runs locally;
  // the rest navigate. New entries here automatically join the fuzzy index.
  // Carve note: the feature-module quick actions (Finanzantrag, Abstimmung,
  // Umfrage) rode with their now-carved-out modules; the governance-only kernel
  // ships just the theme toggle. Feature modules can re-register their own quick
  // actions when present.
  const actions: PaletteCommand[] = [
    { kind: 'action', label: 'Theme wechseln', href: '__theme', icon: 'moon', hint: 'Hell / Dunkel umschalten' }
  ]

  let query = $state('')
  let activeIndex = $state(0)
  let inputEl = $state<HTMLInputElement | null>(null)
  const listboxId = 'command-palette-listbox'

  // Flatten the filtered nav tree into page commands (leaf items only).
  function flattenNav(items: NavItem[]): PaletteCommand[] {
    const out: PaletteCommand[] = []
    for (const node of items) {
      if (node.kind === 'item') {
        out.push({ kind: 'page', label: node.label, href: node.href, icon: node.icon })
      } else if (node.kind === 'section') {
        out.push(...flattenNav(node.children))
      }
    }
    return out
  }

  let pages = $derived(flattenNav(nav))

  // Subsequence fuzzy match: every query char must appear in order. Case- and
  // diacritic-folded so "ubersicht" matches "Übersicht" and "fin" matches both
  // "Finanzen" and "Finanzantrag".
  function fold(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  }
  function fuzzyMatch(needle: string, haystack: string): boolean {
    if (!needle) return true
    const n = fold(needle)
    const h = fold(haystack)
    let i = 0
    for (const ch of h) {
      if (ch === n[i]) i++
      if (i === n.length) return true
    }
    return i === n.length
  }

  let filteredPages = $derived(pages.filter((c) => fuzzyMatch(query, c.label)))
  let filteredActions = $derived(
    actions.filter((c) => fuzzyMatch(query, c.label + ' ' + (c.hint ?? '')))
  )
  // Single flat list for keyboard navigation — pages first, then actions, in the
  // same visual order they render.
  let flatResults = $derived([...filteredPages, ...filteredActions])

  // Clamp the highlighted row whenever the result set shrinks.
  $effect(() => {
    if (activeIndex >= flatResults.length) activeIndex = Math.max(0, flatResults.length - 1)
  })

  // Focus + reset whenever the palette opens.
  $effect(() => {
    if (open) {
      query = ''
      activeIndex = 0
      tick().then(() => inputEl?.focus())
    }
  })

  function close() {
    open = false
  }

  async function run(cmd: PaletteCommand) {
    close()
    if (cmd.kind === 'action' && cmd.href === '__theme') {
      themeMode.set($themeMode === 'dark' ? 'light' : 'dark')
      return
    }
    await goto(cmd.href)
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (flatResults.length > 0) activeIndex = (activeIndex + 1) % flatResults.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (flatResults.length > 0)
        activeIndex = (activeIndex - 1 + flatResults.length) % flatResults.length
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = flatResults[activeIndex]
      if (cmd) run(cmd)
      return
    }
    if (e.key === 'Tab') {
      // Keep focus trapped on the single input — there are no other tabbables.
      e.preventDefault()
    }
  }

  // Index helpers so each rendered row knows its position in the flat list.
  function pageIndex(i: number): number {
    return i
  }
  function actionIndex(i: number): number {
    return filteredPages.length + i
  }
</script>

{#if open}
  <!-- Overlay: click-out closes. -->
  <div class="cp-overlay" role="presentation" onclick={close}>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      class="cp-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Befehlspalette"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={onKeydown}
    >
      <div class="cp-input-row">
        <Icon name="search" size={16} aria-hidden="true" />
        <input
          bind:this={inputEl}
          bind:value={query}
          class="cp-input"
          type="text"
          placeholder="Suche … Antrag, Datei, Person"
          aria-label="Suche … Antrag, Datei, Person"
          aria-controls={listboxId}
          aria-activedescendant={flatResults.length > 0 ? `cp-opt-${activeIndex}` : undefined}
          autocomplete="off"
          spellcheck="false"
        />
        <kbd class="cp-esc">ESC</kbd>
      </div>

      <div class="cp-results" id={listboxId} role="listbox" aria-label="Ergebnisse">
        {#if flatResults.length === 0}
          <div class="cp-empty">Keine Treffer für „{query}“</div>
        {/if}

        {#if filteredPages.length > 0}
          <div class="cp-section">Seiten</div>
          {#each filteredPages as cmd, i (cmd.href)}
            {@const idx = pageIndex(i)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id="cp-opt-{idx}"
              class="cp-row"
              class:active={idx === activeIndex}
              role="option"
              aria-selected={idx === activeIndex}
              tabindex="-1"
              onclick={() => run(cmd)}
              onmousemove={() => (activeIndex = idx)}
            >
              {#if cmd.icon}<Icon name={cmd.icon} size={15} aria-hidden="true" />{/if}
              <span class="cp-label">{cmd.label}</span>
              <span class="cp-path">{cmd.href}</span>
            </div>
          {/each}
        {/if}

        {#if filteredActions.length > 0}
          <div class="cp-section">Aktionen</div>
          {#each filteredActions as cmd, i (cmd.label)}
            {@const idx = actionIndex(i)}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              id="cp-opt-{idx}"
              class="cp-row"
              class:active={idx === activeIndex}
              role="option"
              aria-selected={idx === activeIndex}
              tabindex="-1"
              onclick={() => run(cmd)}
              onmousemove={() => (activeIndex = idx)}
            >
              {#if cmd.icon}<Icon name={cmd.icon} size={15} aria-hidden="true" />{/if}
              <span class="cp-label">{cmd.label}</span>
              {#if cmd.hint}<span class="cp-hint">{cmd.hint}</span>{/if}
            </div>
          {/each}
        {/if}

        <!-- Stub: people/file search is not wired yet (no unified search API). -->
        <div class="cp-section">Personen &amp; Dateien</div>
        <div class="cp-stub">Personen — folgt</div>
      </div>

      <div class="cp-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigieren</span>
        <span><kbd>↵</kbd> Öffnen</span>
        <span><kbd>ESC</kbd> Schließen</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .cp-overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    background: color-mix(in srgb, var(--ink) 32%, transparent);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
  }
  .cp-panel {
    width: min(560px, calc(100vw - 32px));
    max-height: 60vh;
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--border-strong);
    border-radius: var(--r-md);
    box-shadow: var(--sh-3);
    overflow: hidden;
  }
  .cp-input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    color: var(--ink-muted);
  }
  .cp-input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    font-family: var(--font-body);
    font-size: 14.5px;
    color: var(--ink);
  }
  .cp-input::placeholder {
    color: var(--ink-faint);
  }
  .cp-esc {
    font-family: var(--font-mono);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--ink-muted);
  }
  .cp-results {
    overflow-y: auto;
    padding: 6px;
  }
  .cp-section {
    padding: 10px 10px 5px;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ink-faint);
    font-weight: 500;
  }
  .cp-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--r-sm);
    color: var(--ink-2);
    cursor: pointer;
    font-size: 13.5px;
  }
  .cp-row.active {
    background: var(--accent-faint);
    color: var(--ink);
  }
  .cp-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cp-path,
  .cp-hint {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--ink-faint);
    flex-shrink: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cp-empty,
  .cp-stub {
    padding: 8px 10px;
    font-size: 12.5px;
    color: var(--ink-faint);
  }
  .cp-stub {
    font-style: italic;
  }
  .cp-foot {
    display: flex;
    gap: 16px;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    background: var(--surface-2);
    font-size: 11px;
    color: var(--ink-muted);
  }
  .cp-foot kbd {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 1px 4px;
    margin-right: 2px;
    border-radius: 3px;
    background: var(--surface);
    border: 1px solid var(--border);
  }
</style>
