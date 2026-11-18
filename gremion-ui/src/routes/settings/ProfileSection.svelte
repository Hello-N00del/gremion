<script lang="ts">
  // Settings > Profil, below the profile card: the member's own name, and the
  // three Keycloak account actions. Server side: routes/settings/+page.server.ts
  // (actions `profileName` and `accountAction`, logic in $lib/server/profile).
  // Plain form POSTs, so everything works with JavaScript off.
  import { page } from '$app/state'
  import { lang, t } from '$lib/i18n'

  type Profile = { firstName: string; lastName: string; email: string }
  type ActionResult = { action: 'UPDATE_PASSWORD' | 'CONFIGURE_TOTP' | 'UPDATE_EMAIL'; status: 'success' | 'cancelled' | 'error' }

  let {
    profile,
    emailActionAvailable,
    accountActionResult,
  }: { profile?: Profile | null; emailActionAvailable?: boolean; accountActionResult?: ActionResult | null } = $props()

  const nameForm = $derived(page.form?.profileName as
    | { saved?: true; error?: 'invalid' | 'chars' | 'not-saved' | 'forbidden'; errors?: { firstName?: 'invalid' | 'chars'; lastName?: 'invalid' | 'chars' }; values?: { firstName: string; lastName: string } }
    | undefined)
  const actionError = $derived(page.form?.accountAction?.error as 'invalid' | 'unavailable' | 'unavailable-now' | 'forbidden' | undefined)

  const resultText = $derived.by(() => {
    if (!accountActionResult) return null
    const { action, status } = accountActionResult
    const k = action === 'UPDATE_PASSWORD' ? 'password' : action === 'CONFIGURE_TOTP' ? 'totp' : 'email'
    if (status === 'success') return { ok: true, text: $t(`settings.profile.success.${k}`) }
    if (status === 'cancelled') return { ok: false, text: $t(`settings.profile.cancelled.${k}`) }
    return { ok: false, text: $t(`settings.profile.failed.${k}`) }
  })

  const ACTION_ERROR_KEY = {
    invalid: 'settings.profile.err.invalid',
    unavailable: 'settings.profile.err.unavailable',
    'unavailable-now': 'settings.profile.err.unavailableNow',
    forbidden: 'settings.profile.err.invalid',
  } as const
</script>

<section class="mt-6" lang={$lang} aria-labelledby="profil-name-h">
  <h3 id="profil-name-h" class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">{$t('settings.profile.name.h')}</h3>
  {#if profile}
    <p class="text-xs text-ink-muted mb-3">{$t('settings.profile.name.help')}</p>
    <form method="POST" action="/settings?/profileName" class="grid gap-3 sm:grid-cols-2 max-w-xl">
      <div>
        <label for="profil-firstName" class="block text-xs font-medium mb-1">{$t('settings.profile.firstName')}</label>
        <input
          id="profil-firstName"
          name="firstName"
          type="text"
          autocomplete="given-name"
          required
          maxlength="80"
          value={nameForm?.values?.firstName ?? profile.firstName}
          aria-invalid={nameForm?.errors?.firstName ? 'true' : undefined}
          class="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        />
      </div>
      <div>
        <label for="profil-lastName" class="block text-xs font-medium mb-1">{$t('settings.profile.lastName')}</label>
        <input
          id="profil-lastName"
          name="lastName"
          type="text"
          autocomplete="family-name"
          required
          maxlength="80"
          value={nameForm?.values?.lastName ?? profile.lastName}
          aria-invalid={nameForm?.errors?.lastName ? 'true' : undefined}
          class="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        />
      </div>
      <div class="sm:col-span-2">
        <button type="submit" class="btn">{$t('settings.profile.saveName')}</button>
      </div>
    </form>
    {#if nameForm?.saved}
      <p role="status" class="mt-3 text-xs text-ink-2">
        {$t('settings.profile.saved')}
      </p>
    {:else if nameForm?.error === 'chars' || nameForm?.errors?.firstName === 'chars' || nameForm?.errors?.lastName === 'chars'}
      <p role="alert" class="mt-3 text-xs text-rust-ink">
        {$t('settings.profile.chars.head')} &lt; &gt; &amp; &quot; $ % ! # ? § ; * ~ / \ | ^ = [ ] &#123; &#125; ( ).
        {$t('settings.profile.chars.tail')}
      </p>
    {:else if nameForm?.error === 'invalid'}
      <p role="alert" class="mt-3 text-xs text-rust-ink">
        {$t('settings.profile.invalid')}
      </p>
    {:else if nameForm?.error === 'not-saved'}
      <p role="alert" class="mt-3 text-xs text-rust-ink">{$t('settings.profile.notSaved')}</p>
    {:else if nameForm?.error === 'forbidden'}
      <p role="alert" class="mt-3 text-xs text-rust-ink">{$t('settings.profile.forbidden')}</p>
    {/if}
  {:else}
    <p class="text-xs text-ink-muted">{$t('settings.profile.loadFailed')}</p>
  {/if}
</section>

<section class="mt-8" lang={$lang} aria-labelledby="profil-login-h">
  <h3 id="profil-login-h" class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">{$t('settings.profile.login.h')}</h3>
  <p class="text-xs text-ink-muted mb-3">
    {$t('settings.profile.login.help')}
  </p>
  {#if resultText}
    <p role={resultText.ok ? 'status' : 'alert'} class="mb-3 text-xs {resultText.ok ? 'text-ink-2' : 'text-rust-ink'}">{resultText.text}</p>
  {/if}
  {#if actionError}
    <p role="alert" class="mb-3 text-xs text-rust-ink">{$t(ACTION_ERROR_KEY[actionError] ?? ACTION_ERROR_KEY.invalid)}</p>
  {/if}
  <div class="flex flex-wrap gap-2">
    <form method="POST" action="/settings?/accountAction">
      <button type="submit" name="action" value="password" class="btn">{$t('settings.profile.btn.password')}</button>
    </form>
    <form method="POST" action="/settings?/accountAction">
      <button type="submit" name="action" value="totp" class="btn">{$t('settings.profile.btn.totp')}</button>
    </form>
    {#if emailActionAvailable}
      <form method="POST" action="/settings?/accountAction">
        <button type="submit" name="action" value="email" class="btn">{$t('settings.profile.btn.email')}</button>
      </form>
    {/if}
  </div>
  <p class="mt-2 text-xs text-ink-muted">
    {$t('settings.profile.totpNote')}
  </p>
</section>
