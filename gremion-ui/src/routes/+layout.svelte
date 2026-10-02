<script lang="ts">
  import AppShell from '$lib/components/layout/AppShell.svelte'
  import '../app.css'
  // #177: self-hosted fonts — no third-party Google Fonts dependency (GDPR) and
  // no blocked-by-CSP external request. Weights mirror the families declared in
  // app.css (--font-display "Archivo Narrow" / --font-body "Inter" /
  // --font-mono "JetBrains Mono"). The static @fontsource packages register the
  // plain family names, so app.css needs no change.
  import '@fontsource/archivo-narrow/400.css'
  import '@fontsource/archivo-narrow/400-italic.css'
  import '@fontsource/archivo-narrow/500.css'
  import '@fontsource/archivo-narrow/600.css'
  import '@fontsource/archivo-narrow/700.css'
  import '@fontsource/inter/300.css'
  import '@fontsource/inter/400.css'
  import '@fontsource/inter/500.css'
  import '@fontsource/inter/600.css'
  import '@fontsource/jetbrains-mono/400.css'
  import '@fontsource/jetbrains-mono/500.css'
  import type { LayoutData } from './$types'
  import type { SessionUser } from '$lib/auth/types'
  import type { Snippet } from 'svelte'
  import type { TopbarModuleSlot } from '$lib/components/layout/topbar-slot'
  import type { ModuleLayoutSlot } from '$lib/modules/layout-slot'
  import { browser } from '$app/environment'
  import { page } from '$app/stores'
  import { afterNavigate, onNavigate } from '$app/navigation'
  import { onMount } from 'svelte'
  import { initTheme } from '$lib/stores/theme'
  import { lang } from '$lib/i18n'
  import { contentLocaleFor, syncDocumentLang, uiLocaleOf } from '$lib/i18n/content-locale'

  // Apply persisted appearance/accessibility prefs (theme, colorblind,
  // font size, reduced motion) on load so they take effect app-wide.
  onMount(initTheme)

  // R26-TRAIN4-FIX (WCAG 3.1.1): a client-side navigation gets no new <html>
  // from the server, so set its lang to the next page's content language here,
  // before that page renders, and again for the page that actually landed (a
  // redirect or a failed navigation ends somewhere else). Pages that are not
  // translated are German; translated ones follow the person. See
  // content-locale.ts.
  onNavigate(({ to }) => {
    if (to) syncDocumentLang(document.documentElement, to.route.id)
  })
  afterNavigate(({ to }) => {
    if (to) syncDocumentLang(document.documentElement, to.route.id)
  })

  let {
    data,
    children
  }: {
    data: LayoutData
    children: Snippet
  } = $props()

  let user = $derived(data.session?.user as SessionUser | undefined)
  let roles = $derived(user?.roles ?? [])
  let userName = $derived(user?.name ?? '')
  let groups = $derived((user as { groups?: string[] } | undefined)?.groups ?? [])
  // TASK-205b: the chrome the module halves contribute (the messaging module's Matrix chip, live-call
  // indicator, notification bell and call picture-in-picture). Each built module ships one
  // `lib/modules/slots/<id>.slot.ts`; this glob is the interim composition seam (layout-slot.ts) that
  // TASK-125's registry replaces. A module that is not built has no file and so no chrome here.
  const moduleSlots = Object.values(
    import.meta.glob<{ default: ModuleLayoutSlot }>('../lib/modules/slots/*.slot.ts', { eager: true })
  ).map((m) => m.default)
  const chipSlots = moduleSlots.flatMap((s) => (s.chips ? [s.chips] : []))
  const liveCallSlots = moduleSlots.flatMap((s) => (s.liveCall ? [s.liveCall] : []))
  const bellSlots = moduleSlots.flatMap((s) => (s.bell ? [s.bell] : []))
  const overlaySlots = moduleSlots.flatMap((s) => (s.overlay ? [s.overlay] : []))
  // Only the parts some module provides are handed to the TopBar, so it renders no empty wrapper.
  const topbarModules: TopbarModuleSlot | undefined =
    chipSlots.length || liveCallSlots.length || bellSlots.length
      ? {
          chips: chipSlots.length ? chips : undefined,
          liveCall: liveCallSlots.length ? liveCall : undefined,
          bell: bellSlots.length ? bell : undefined
        }
      : undefined

  let nav = $derived(data.nav)
  let counts = $derived(data.counts ?? { approvals: 0, liveVotes: 0, unread: 0 })
  let activeHref = $derived($page.url.pathname)

  // The language the current page is written in; the shell chrome speaks it
  // too, so a page declared lang="de" carries no English chrome. The shell
  // stays mounted across client-side navigation, hence a reactive prop. On the
  // server $lang is already the request's content locale (i18n-handle.ts), and
  // contentLocaleFor is idempotent over it; in the browser the person's locale
  // is read back from <html> (data-ui-locale, else lang).
  let pageLocale = $derived(
    contentLocaleFor($page.route.id, browser ? uiLocaleOf(document.documentElement) : $lang)
  )

  // Don't show shell on auth/legal pages
  let isShellRoute = $derived(
    !$page.url.pathname.startsWith('/auth') &&
    !$page.url.pathname.startsWith('/legal') &&
    !$page.url.pathname.startsWith('/setup')
  )
</script>

<!-- Skip-to-content link — WCAG 2.4.1 / BITV 2.0 -->
<!-- #287: the skip-link is a focusable accent affordance. bg-primary/
     text-primary-foreground were dangling shadcn aliases (undefined @theme vars →
     transparent); mapped to the prototype accent tokens. -->
<!-- R26-TRAIN4-FIX r3: German text, so marked German on an English page too (WCAG 3.1.2). -->
<a
  lang="de"
  href="#main-content"
  class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50
         focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-paper"
>
  Zum Inhalt springen
</a>

{#snippet chips()}
  {#each chipSlots as Chip, i (i)}<Chip />{/each}
{/snippet}
{#snippet liveCall()}
  {#each liveCallSlots as Live, i (i)}<Live />{/each}
{/snippet}
{#snippet bell()}
  {#each bellSlots as Bell, i (i)}<Bell />{/each}
{/snippet}

{#if isShellRoute && user}
  <AppShell {nav} {counts} {activeHref} {roles} {userName} {groups} brand={data.brand} sourceUrl={data.sourceUrl} locale={pageLocale} {topbarModules} {children} />
  {#each overlaySlots as Overlay, i (i)}<Overlay {user} />{/each}
{:else}
  {@render children()}
{/if}
