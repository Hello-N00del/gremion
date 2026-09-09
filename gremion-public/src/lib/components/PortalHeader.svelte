<script lang="ts">
  // PortalHeader — public-portal top bar (PR 5 T5.1.1).
  // Ported from the bundle's `.topbar` section. Faithful-but-functional:
  // editorial brand mark + horizontal nav + member-login CTA, skinned with
  // the production app.css token system (Outfit display, oklch tokens, .dark
  // auto-switch) rather than the prototype's clay/Fraunces literals.
  //
  // v12 apex topology adds the APEX STRIP above the topbar: an optional
  // back-route out of the portal and up to whatever site sits above it.
  import { base } from '$app/paths';

  interface NavLink {
    href: string;
    label: string;
  }

  let {
    institutionName = 'Studierendenrat',
    legislatureLabel = null,
    mainAppUrl = null,
    navLinks = [],
    currentPath = '/',
    apexHref = null,
    apexLabel = null,
    apexNote = null,
  }: {
    institutionName?: string;
    legislatureLabel?: string | null;
    mainAppUrl?: string | null;
    navLinks?: NavLink[];
    currentPath?: string;
    /**
     * v12 — where the apex strip points: the site ABOVE this portal (a landing
     * or marketing site at the origin root). Deliberately NOT `base`-prefixed —
     * `base` is where this portal is mounted underneath that site.
     *
     * Defaults to `null`, i.e. NO strip. The kernel is a standalone governance
     * portal with no marketing site above it, and a dangling link to a page
     * that does not exist is worse than no link. An instance that has one opts
     * in (PUBLIC_APEX_URL, see +layout.server.ts).
     */
    apexHref?: string | null;
    /**
     * Text of the strip — typically the operator's apex host. Required
     * companion to `apexHref`: with no label there is nothing to render, so the
     * strip stays hidden. Kept as free text rather than a hardcoded product
     * string so no instance's naming leaks into the kernel.
     */
    apexLabel?: string | null;
    /** Optional second segment after a dimmed separator, e.g. a short tagline. */
    apexNote?: string | null;
  } = $props();

  // On the public portal every nav link is an in-page anchor on the portal
  // root, so "active" simply means we are on the landing page. `currentPath` is
  // `$page.url.pathname`, which INCLUDES the base path, so compare against the
  // base itself rather than a bare '/' (under BASE_PATH=/portal the portal root
  // is `/portal`, and a proxy may or may not append the trailing slash).
  const onLanding = $derived(currentPath === base || currentPath === `${base}/`);
</script>

<!-- ── Apex strip (v12) ──────────────────────────────────────────────────────
     The chain runs both ways: a site above points down into the portal, and
     this points back up. Ink band, mono type. Renders ONLY when the instance
     configured BOTH a target and a label — an unconfigured kernel shows
     nothing at all and is byte-identical to the pre-v12 header. -->
{#if apexHref && apexLabel}
  <div class="border-b border-white/10 bg-ink">
    <div class="mx-auto max-w-7xl px-5">
      <a
        href={apexHref}
        class="group inline-flex items-center gap-2 py-2 font-mono text-[11px]
               tracking-[0.14em] text-white/55 uppercase transition-colors
               hover:text-white/90 focus-visible:text-white/90"
      >
        <span
          class="transition-transform duration-150 group-hover:-translate-x-0.5"
          aria-hidden="true">←</span
        >
        <span>{apexLabel}</span>
        {#if apexNote}
          <span class="text-white/25" aria-hidden="true">·</span>
          <span>{apexNote}</span>
        {/if}
      </a>
    </div>
  </div>
{/if}

<header class="border-b border-border bg-surface">
  <div class="mx-auto flex max-w-7xl items-center gap-8 px-5 py-4 lg:py-5">

    <!-- Brand mark + institution -->
    <a href="{base}/" class="flex shrink-0 items-center gap-3" aria-label="Startseite">
      <span
        class="relative grid h-9 w-9 place-items-center rounded-sm bg-ink font-display
               text-[17px] font-bold text-paper"
      >
        S
        <span
          class="absolute -bottom-[3px] -right-[3px] h-[9px] w-[9px] rounded-[2px] bg-ember"
          aria-hidden="true"
        ></span>
      </span>
      <span class="leading-tight">
        <span class="block font-display text-[19px] font-semibold tracking-tight text-ink">
          {institutionName}
        </span>
        <!-- No fallback: this used to default to a specific body type
             ('Studierendenschaft'), which mislabels every other kind of
             institution deploying the kernel. Unset renders nothing. -->
        {#if legislatureLabel}
          <span class="block font-mono text-[9.5px] tracking-[0.14em] text-ink-muted uppercase">
            {legislatureLabel}
          </span>
        {/if}
      </span>
    </a>

    <!-- Primary nav -->
    {#if navLinks.length > 0}
      <nav aria-label="Hauptnavigation" class="ml-auto hidden md:block">
        <ul class="flex items-center gap-6 text-[14px]">
          {#each navLinks as link (link.href)}
            {@const active = onLanding && link.href.endsWith('#übersicht')}
            <li>
              <a
                href={link.href}
                class="relative py-1.5 text-ink-2 transition-colors hover:text-ink
                       {active ? 'font-medium text-ink' : ''}"
                aria-current={active ? 'page' : undefined}
              >
                {link.label}
                {#if active}
                  <span
                    class="absolute -bottom-0.5 left-0 right-0 h-0.5 bg-ember"
                    aria-hidden="true"
                  ></span>
                {/if}
              </a>
            </li>
          {/each}
        </ul>
      </nav>
    {/if}

    <!-- Member-login CTA. Rendered only when the app URL is actually
         configured: the previous `?? '#'` fallback shipped a dead link on every
         deployment that had not set PUBLIC_MAIN_APP_URL. Same rule as the apex
         strip above — an unconfigured route renders nothing rather than a link
         that goes nowhere. `rel="noreferrer"` stays because in the kernel's
         default topology the app is a DIFFERENT host from the portal. -->
    {#if mainAppUrl}
      <a
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ink px-4 py-2
               font-mono text-[12px] font-medium tracking-wide text-paper transition-opacity
               hover:opacity-85 {navLinks.length > 0 ? '' : 'ml-auto'}"
        href={mainAppUrl}
        rel="noreferrer"
      >
        Login · Mitglieder
      </a>
    {/if}

  </div>
</header>
