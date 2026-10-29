<script lang="ts">
  import { signIn } from '@auth/sveltekit/client'
  import { onMount } from 'svelte'
  import PageTitle from '$lib/components/PageTitle.svelte'

  let { data } = $props()

  onMount(() => {
    // The user was refused for lack of a second factor: re-running the step-up
    // would be refused again, so show the notice and stop.
    if (data.secondFactorMissing) return
    // signIn's 3rd arg (authorizationParams) is forwarded to the Keycloak
    // authorize URL as query params. acr_values=loa2 requests LoA-2 (the OTP
    // step-up). The realm flow is OTP-or-deny: a user WITHOUT an OTP credential
    // is refused, nothing is enrolled here (docs/auth.md). max_age=300 forces
    // a fresh KC interaction even if the SSO session is recent.
    // FALLBACK (only if dress-rehearsal shows params are NOT forwarded):
    // replace with a redirect to a +server.ts that hand-builds the KC URL.
    signIn('keycloak', { callbackUrl: data.returnTo }, { acr_values: 'loa2', max_age: '300' })
  })
</script>

<PageTitle title="Zusätzliche Bestätigung" />

{#if data.secondFactorMissing}
  <main class="flex min-h-screen items-center justify-center bg-paper p-4">
    <div class="w-full max-w-sm rounded-lg border border-border bg-surface p-6 text-center shadow-xs">
      <h1 class="text-base font-semibold text-ink">Zweiter Faktor erforderlich</h1>
      <p class="mt-2 text-sm text-ink-muted">
        Für diese Bestätigung brauchen Sie einen zweiten Faktor (Authenticator-App). Bei Ihrem Konto ist noch keiner
        eingerichtet, deshalb wurde die Bestätigung abgelehnt.
      </p>
      <p class="mt-2 text-sm text-ink-muted">
        Richten Sie ihn zuerst in Ihrem Konto unter „Anmeldung“ ein und versuchen Sie es danach erneut.
      </p>
      {#if data.accountUrl}
        <a href={data.accountUrl} class="mt-5 inline-flex items-center justify-center text-sm font-medium text-ink hover:underline">
          Konto öffnen
        </a>
      {/if}
      <a href={data.returnTo} class="mt-3 block text-sm text-ink-muted hover:underline">Zurück</a>
    </div>
  </main>
{:else}
  <main class="flex min-h-screen items-center justify-center bg-paper p-4">
    <div class="flex flex-col items-center gap-3" role="status" aria-live="polite">
      <span class="spinner" aria-hidden="true"></span>
      <span class="text-sm text-ink-muted">Zusätzliche Bestätigung (2FA) …</span>
    </div>
  </main>
{/if}

<style>
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
