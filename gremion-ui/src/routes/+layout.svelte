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
  import { page } from '$app/stores'
  import { onMount } from 'svelte'
  import { initTheme } from '$lib/stores/theme'

  // Apply persisted appearance/accessibility prefs (theme, colorblind,
  // font size, reduced motion) on load so they take effect app-wide.
  onMount(initTheme)

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
  let nav = $derived(data.nav)
  let counts = $derived(data.counts ?? { approvals: 0, liveVotes: 0, unread: 0 })
  let activeHref = $derived($page.url.pathname)

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
<a
  href="#main-content"
  class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50
         focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-paper"
>
  Zum Inhalt springen
</a>

{#if isShellRoute && user}
  <AppShell {nav} {counts} {activeHref} {roles} {userName} {groups} brand={data.brand} sourceUrl={data.sourceUrl} {children} />
{:else}
  {@render children()}
{/if}
