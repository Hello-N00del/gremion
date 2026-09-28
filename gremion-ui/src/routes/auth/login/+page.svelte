<script lang="ts">
  import { signIn } from '@auth/sveltekit/client'
  import { page } from '$app/state'
  import { onMount } from 'svelte'
  import { t } from '$lib/i18n'
  import PageTitle from '$lib/components/PageTitle.svelte'
  import { LEGAL_HREFS } from '$lib/legal-links'

  // CONFORMANCE §1 / HANDOVER P1: the real login form is the Keycloak login
  // THEME (docker/keycloak/themes/gremion/login/). This SvelteKit page is no
  // longer an interstitial card — it just bounces straight to Keycloak, except
  // for two terminal notices that must NOT auto-redirect.
  function getSafeCallbackUrl(): string {
    const raw = page.url.searchParams.get('callbackUrl') ?? '/'
    // Open-redirect guard: only same-origin absolute paths, never protocol-relative.
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw
    return '/'
  }

  const callbackUrl = getSafeCallbackUrl()
  // ?error=forbidden — the access guard bounced an authenticated user off a
  // page their role can't reach. Re-logging-in won't help, so show a notice
  // instead of looping them back through Keycloak.
  const forbidden = $derived(page.url.searchParams.get('error') === 'forbidden')
  // ?loggedOut=1 — the user just signed out. Don't immediately bounce them
  // back into Keycloak (that would look like the logout never happened).
  const loggedOut = $derived(page.url.searchParams.has('loggedOut'))

  onMount(() => {
    if (!forbidden && !loggedOut) {
      signIn('keycloak', { callbackUrl })
    }
  })
</script>

<PageTitle />

{#if forbidden}
  <main class="flex min-h-screen items-center justify-center bg-paper p-4">
    <div class="w-full max-w-sm rounded-lg border border-border bg-surface p-6 text-center shadow-xs">
      <h1 class="text-base font-semibold text-ink">{$t('auth.login.forbidden.title')}</h1>
      <p class="mt-2 text-sm text-ink-muted">{$t('auth.login.forbidden.body')}</p>
      <a
        href="/"
        class="mt-5 inline-flex items-center justify-center text-sm font-medium text-ink hover:underline"
      >
        {$t('auth.login.forbidden.back')}
      </a>
    </div>
  </main>
{:else if loggedOut}
  <main class="flex min-h-screen items-center justify-center bg-paper p-4">
    <div class="w-full max-w-sm rounded-lg border border-border bg-surface p-6 text-center shadow-xs">
      <h1 class="text-base font-semibold text-ink">{$t('auth.login.loggedOut.title')}</h1>
      <p class="mt-2 text-sm text-ink-muted">{$t('auth.login.loggedOut.body')}</p>
      <button
        type="button"
        onclick={() => signIn('keycloak', { callbackUrl })}
        class="mt-5 inline-flex items-center justify-center text-sm font-medium text-ink hover:underline"
      >
        {$t('auth.login.loggedOut.again')}
      </button>
    </div>
  </main>
{:else}
  <main class="flex min-h-screen items-center justify-center bg-paper p-4">
    <div class="flex flex-col items-center gap-3" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <span class="text-sm text-ink-muted">{$t('auth.login.redirecting')}</span>
    </div>
  </main>
{/if}

<!-- R27-SIGNIN-LEGAL-K: section 5 DDG (Impressum) + Art. 13 GDPR (privacy
     notice at the point of data collection) + BITV 2.0 / EN 301 549
     (accessibility statement reachable from every page). A `<footer>` at the
     document root (not nested in the `<main>` above) keeps its implicit
     `contentinfo` landmark role. It renders in every branch above, including
     the default redirect branch, so it is present in the server-rendered
     HTML an anonymous visitor (or a URL-rating crawler that does not run JS)
     sees before onMount's signIn() call navigates the browser away. -->
<footer class="signin-legal">
  <a href={LEGAL_HREFS.impressum}>{$t('auth.login.legal.impressum')}</a>
  <a href={LEGAL_HREFS.datenschutz}>{$t('auth.login.legal.datenschutz')}</a>
  <a href={LEGAL_HREFS.barrierefreiheit}>{$t('auth.login.legal.barrierefreiheit')}</a>
</footer>

<style>
  .signin-legal {
    position: fixed;
    inset-inline: 0;
    bottom: 0;
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    column-gap: 16px;
    padding: 8px 16px calc(8px + env(safe-area-inset-bottom, 0px));
  }
  .signin-legal a {
    display: inline-flex;
    align-items: center;
    min-height: 24px;
    padding: 2px 4px;
    font-size: 12px;
    color: var(--ink-muted);
    text-decoration: none;
  }
  .signin-legal a:hover {
    color: var(--ink);
    text-decoration: underline;
  }
  .spinner {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid var(--border, currentColor);
    border-top-color: var(--accent, currentColor);
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 1.6s;
    }
  }
</style>
