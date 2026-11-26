<script lang="ts" module>
  // A flat, searchable command. `kind` drives the section grouping in the list.
  export type PaletteCommand =
    | { kind: 'page'; label: string; href: string; icon?: string; hint?: string; lang?: string }
    | { kind: 'action'; label: string; href: string; icon?: string; hint?: string; lang?: string }
    // Server search hits (/api/search): minutes, calendar events, units and people.
    | { kind: 'result'; group: ResultGroup; id: string; label: string; href: string; icon?: string; hint?: string; lang?: string }

  export type ResultGroup = 'minutes' | 'events' | 'units' | 'people'
  /** One hit as /api/search answers it. */
  export interface SearchHit {
    id: string
    label: string
    hint: string | null
    href: string
  }
</script>

<script lang="ts">
  import { goto } from '$app/navigation'
  import { tick } from 'svelte'
  import Icon from '$lib/components/ui/Icon.svelte'
  import type { NavItem } from '$lib/components/layout/nav-schema'
  import { themeMode } from '$lib/stores/theme'
  import { t } from '$lib/i18n'

  // `nav` is the SAME role/PAGE_ACCESS-filtered tree the sidebar renders, so the
  // palette can never surface a page the user is not allowed to reach. `actions`
  // are likewise gated upstream (the caller only passes ones the role permits).
  let {
    open = $bindable(false),
    nav = [],
    lang
  }: {
    open?: boolean
    nav?: NavItem[]
    /** The language of the dialog when it differs from the page's (WCAG 3.1.2); unset: the page's. */
    lang?: string
  } = $props()

  // Quick actions — institutional Sie-Form labels. Theme-toggle runs locally;
  // the rest navigate. New entries here automatically join the fuzzy index.
  // Carve note: the feature-module quick actions (Finanzantrag, Abstimmung,
  // Umfrage) rode with their now-carved-out modules; the governance-only kernel
  // ships just the theme toggle. Feature modules can re-register their own quick
  // actions when present.
  let actions: PaletteCommand[] = $derived([
    { kind: 'action', label: $t('palette.action.theme'), href: '__theme', icon: 'moon', hint: $t('palette.action.themeHint') }
  ])

  let query = $state('')
  let activeIndex = $state(0)
  let remote = $state<Record<ResultGroup, SearchHit[]>>(emptyRemote())
  let searching = $state(false)
  let inputEl = $state<HTMLInputElement | null>(null)
  const listboxId = 'command-palette-listbox'

  // The server search starts at two characters (the endpoint answers empty below that) and waits for a
  // pause in the typing. Each new query cancels the one before, so a slow older answer can never replace a
  // newer one. A failed search leaves the page matches alone.
  const SEARCH_MIN_LENGTH = 2
  const SEARCH_DEBOUNCE_MS = 200
  const GROUPS: { group: ResultGroup; icon: string; titleKey: string }[] = [
    { group: 'minutes', icon: 'file', titleKey: 'palette.section.minutes' },
    { group: 'events', icon: 'calendar', titleKey: 'palette.section.events' },
    { group: 'units', icon: 'users', titleKey: 'palette.section.units' },
    { group: 'people', icon: 'badge', titleKey: 'palette.section.people' }
  ]

  function emptyRemote(): Record<ResultGroup, SearchHit[]> {
    return { minutes: [], events: [], units: [], people: [] }
  }

  function readHits(value: unknown): SearchHit[] {
    if (!Array.isArray(value)) return []
    return value.filter(
      (h): h is SearchHit =>
        !!h && typeof h.id === 'string' && typeof h.label === 'string' && typeof h.href === 'string'
    )
  }

  $effect(() => {
    const q = query.replace(/\s+/g, ' ').trim()
    if (!open || q.length < SEARCH_MIN_LENGTH) {
      remote = emptyRemote()
      searching = false
      return
    }
    const ctrl = new AbortController()
    searching = true
    const timer = setTimeout(async () => {
      let next = emptyRemote()
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: ctrl.signal,
          headers: { accept: 'application/json' }
        })
        if (res.ok) {
          const data = (await res.json())?.data ?? {}
          next = {
            minutes: readHits(data.minutes),
            events: readHits(data.events),
            units: readHits(data.units),
            people: readHits(data.people)
          }
        }
      } catch {
        // Aborted or unreachable: the page matches stay as they are.
      }
      if (ctrl.signal.aborted) return
      remote = next
      searching = false
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  })

  // Flatten the filtered nav tree into page commands (leaf items only).
  function flattenNav(items: NavItem[]): PaletteCommand[] {
    const out: PaletteCommand[] = []
    for (const node of items) {
      if (node.kind === 'item') {
        out.push({ kind: 'page', label: node.label, href: node.href, icon: node.icon, lang: node.lang })
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
  // The found items, in the order their sections render.
  let foundItems = $derived(
    GROUPS.flatMap(({ group, icon }) =>
      remote[group].map((h): PaletteCommand => ({ kind: 'result', group, id: h.id, label: h.label, href: h.href, icon, hint: h.hint ?? undefined }))
    )
  )
  // Single flat list for keyboard navigation — pages first, then actions, then the
  // found items, in the same visual order they render.
  let flatResults = $derived([...filteredPages, ...filteredActions, ...foundItems])

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
  // The flat index of the first found item of a group.
  function groupStart(group: ResultGroup): number {
    let n = filteredPages.length + filteredActions.length
    for (const g of GROUPS) {
      if (g.group === group) break
      n += remote[g.group].length
    }
    return n
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
      {lang}
      aria-label={$t('palette.title')}
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
          placeholder={$t('palette.search')}
          aria-label={$t('palette.search')}
          aria-controls={listboxId}
          aria-activedescendant={flatResults.length > 0 ? `cp-opt-${activeIndex}` : undefined}
          autocomplete="off"
          spellcheck="false"
        />
        <kbd class="cp-esc">ESC</kbd>
      </div>

      <div class="cp-results" id={listboxId} role="listbox" aria-label={$t('palette.results')}>
        {#if flatResults.length === 0 && !searching}
          <div class="cp-empty">{$t('palette.noMatches.before')}{query}{$t('palette.noMatches.after')}</div>
        {/if}

        {#if filteredPages.length > 0}
          <div class="cp-section">{$t('palette.section.pages')}</div>
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
              <span class="cp-label" lang={cmd.lang}>{cmd.label}</span>
              <span class="cp-path">{cmd.href}</span>
            </div>
          {/each}
        {/if}

        {#if filteredActions.length > 0}
          <div class="cp-section">{$t('palette.section.actions')}</div>
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
              <span class="cp-label" lang={cmd.lang}>{cmd.label}</span>
              {#if cmd.hint}<span class="cp-hint">{cmd.hint}</span>{/if}
            </div>
          {/each}
        {/if}

        {#each GROUPS as g (g.group)}
          {#if remote[g.group].length > 0}
            <div class="cp-section">{$t(g.titleKey)}</div>
            {#each remote[g.group] as hit, i (hit.id)}
              {@const idx = groupStart(g.group) + i}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                id="cp-opt-{idx}"
                class="cp-row"
                class:active={idx === activeIndex}
                role="option"
                aria-selected={idx === activeIndex}
                tabindex="-1"
                onclick={() => run({ kind: 'result', group: g.group, id: hit.id, label: hit.label, href: hit.href })}
                onmousemove={() => (activeIndex = idx)}
              >
                <Icon name={g.icon} size={15} aria-hidden="true" />
                <span class="cp-label">{hit.label}</span>
                {#if hit.hint}<span class="cp-hint">{hit.hint}</span>{/if}
              </div>
            {/each}
          {/if}
        {/each}
      </div>

      <div class="cp-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> {$t('palette.hint.navigate')}</span>
        <span><kbd>↵</kbd> {$t('palette.hint.open')}</span>
        <span><kbd>ESC</kbd> {$t('palette.hint.close')}</span>
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
  .cp-empty {
    padding: 8px 10px;
    font-size: 12.5px;
    color: var(--ink-faint);
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
