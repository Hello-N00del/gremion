<script lang="ts">
  import { signIn } from '@auth/sveltekit/client'
  import { onMount } from 'svelte'
  import PageTitle from '$lib/components/PageTitle.svelte'

  let { data } = $props()

  onMount(() => {
    // signIn's 3rd arg (authorizationParams) is forwarded to the Keycloak
    // authorize URL as query params. acr_values=loa2 requests LoA-2 (OTP /
    // TOTP step-up, enrolling TOTP if the user has none). max_age=300 forces
    // a fresh KC interaction even if the SSO session is recent.
    // FALLBACK (only if dress-rehearsal shows params are NOT forwarded):
    // replace with a redirect to a +server.ts that hand-builds the KC URL.
    signIn('keycloak', { callbackUrl: data.returnTo }, { acr_values: 'loa2', max_age: '300' })
  })
</script>

<PageTitle title="Zusätzliche Bestätigung" />

<main class="flex min-h-screen items-center justify-center bg-paper p-4">
  <div class="flex flex-col items-center gap-3" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span>
    <span class="text-sm text-ink-muted">Zusätzliche Bestätigung (2FA) …</span>
  </div>
</main>

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
