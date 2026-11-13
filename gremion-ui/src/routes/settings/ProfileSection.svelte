<script lang="ts">
  // Settings > Profil, below the profile card: the member's own name, and the
  // three Keycloak account actions. Server side: routes/settings/+page.server.ts
  // (actions `profileName` and `accountAction`, logic in $lib/server/profile).
  // Plain form POSTs, so everything works with JavaScript off.
  import { page } from '$app/state'

  type Profile = { firstName: string; lastName: string; email: string }
  type ActionResult = { action: 'UPDATE_PASSWORD' | 'CONFIGURE_TOTP' | 'UPDATE_EMAIL'; status: 'success' | 'cancelled' | 'error' }

  let {
    profile,
    emailActionAvailable,
    accountActionResult,
  }: { profile?: Profile | null; emailActionAvailable?: boolean; accountActionResult?: ActionResult | null } = $props()

  const nameForm = $derived(page.form?.profileName as
    | { saved?: true; error?: 'invalid' | 'not-saved' | 'forbidden'; errors?: { firstName?: string; lastName?: string }; values?: { firstName: string; lastName: string } }
    | undefined)
  const actionError = $derived(page.form?.accountAction?.error as 'invalid' | 'unavailable' | 'unavailable-now' | 'forbidden' | undefined)

  const ACTION_NAME: Record<ActionResult['action'], string> = {
    UPDATE_PASSWORD: 'Das Passwort',
    CONFIGURE_TOTP: 'Der Zwei-Faktor-Code',
    UPDATE_EMAIL: 'Die E-Mail-Adresse',
  }
  const SUCCESS: Record<ActionResult['action'], string> = {
    UPDATE_PASSWORD: 'Ihr Passwort wurde geändert.',
    CONFIGURE_TOTP: 'Der neue Zwei-Faktor-Code ist eingerichtet.',
    UPDATE_EMAIL: 'Die Änderung der E-Mail-Adresse wurde angestoßen. Falls eine Bestätigungs-E-Mail ankommt, öffnen Sie den Link darin, damit die neue Adresse gilt.',
  }
  const resultText = $derived.by(() => {
    if (!accountActionResult) return null
    const { action, status } = accountActionResult
    if (status === 'success') return { ok: true, text: SUCCESS[action] }
    if (status === 'cancelled') return { ok: false, text: `${ACTION_NAME[action]} wurde nicht geändert. Sie haben abgebrochen, Ihre Anmeldung bleibt bestehen.` }
    return { ok: false, text: `${ACTION_NAME[action]} konnte nicht geändert werden. Ihre Anmeldung bleibt bestehen, bitte versuchen Sie es erneut.` }
  })

  const ACTION_ERROR_TEXT = {
    invalid: 'Diese Aktion ist nicht möglich.',
    unavailable: 'Diese Aktion ist bei Ihnen nicht eingeschaltet.',
    'unavailable-now': 'Die Anmeldung konnte gerade nicht gestartet werden. Bitte versuchen Sie es später erneut.',
    forbidden: 'Diese Aktion ist nicht möglich.',
  } as const
</script>

<section class="mt-6" aria-labelledby="profil-name-h">
  <h3 id="profil-name-h" class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">Name</h3>
  {#if profile}
    <p class="text-xs text-ink-muted mb-3">So erscheinen Sie in Gremium, Nachrichten und Dateien.</p>
    <form method="POST" action="/settings?/profileName" class="grid gap-3 sm:grid-cols-2 max-w-xl">
      <div>
        <label for="profil-firstName" class="block text-xs font-medium mb-1">Vorname</label>
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
        <label for="profil-lastName" class="block text-xs font-medium mb-1">Nachname</label>
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
        <button type="submit" class="btn">Namen speichern</button>
      </div>
    </form>
    {#if nameForm?.saved}
      <p role="status" class="mt-3 text-xs text-ink-2">
        Gespeichert. In der Kopfzeile und in anderen Bereichen erscheint der neue Name nach Ihrer nächsten Anmeldung.
      </p>
    {:else if nameForm?.error === 'invalid'}
      <p role="alert" class="mt-3 text-xs text-rust-ink">
        Bitte geben Sie Vor- und Nachname ein, jeweils 1 bis 80 Zeichen ohne Steuerzeichen.
      </p>
    {:else if nameForm?.error === 'not-saved'}
      <p role="alert" class="mt-3 text-xs text-rust-ink">Der Name konnte gerade nicht gespeichert werden. Bitte versuchen Sie es später erneut.</p>
    {:else if nameForm?.error === 'forbidden'}
      <p role="alert" class="mt-3 text-xs text-rust-ink">Das Speichern ist nicht möglich.</p>
    {/if}
  {:else}
    <p class="text-xs text-ink-muted">Ihr Name kann gerade nicht geladen werden. Bitte laden Sie die Seite später neu.</p>
  {/if}
</section>

<section class="mt-8" aria-labelledby="profil-login-h">
  <h3 id="profil-login-h" class="text-sm font-semibold mb-1" style="font-family: var(--font-display);">Anmeldung</h3>
  <p class="text-xs text-ink-muted mb-3">
    Dafür melden Sie sich zur Sicherheit noch einmal an, mit Zwei-Faktor-Code, falls Sie einen eingerichtet haben.
    Danach kommen Sie hierher zurück.
  </p>
  {#if resultText}
    <p role={resultText.ok ? 'status' : 'alert'} class="mb-3 text-xs {resultText.ok ? 'text-ink-2' : 'text-rust-ink'}">{resultText.text}</p>
  {/if}
  {#if actionError}
    <p role="alert" class="mb-3 text-xs text-rust-ink">{ACTION_ERROR_TEXT[actionError] ?? ACTION_ERROR_TEXT.invalid}</p>
  {/if}
  <div class="flex flex-wrap gap-2">
    <form method="POST" action="/settings?/accountAction">
      <button type="submit" name="action" value="password" class="btn">Passwort ändern</button>
    </form>
    <form method="POST" action="/settings?/accountAction">
      <button type="submit" name="action" value="totp" class="btn">Zwei-Faktor-Code neu einrichten</button>
    </form>
    {#if emailActionAvailable}
      <form method="POST" action="/settings?/accountAction">
        <button type="submit" name="action" value="email" class="btn">E-Mail-Adresse ändern</button>
      </form>
    {/if}
  </div>
  <p class="mt-2 text-xs text-ink-muted">
    „Zwei-Faktor-Code neu einrichten“ fügt ein weiteres Gerät hinzu; bereits eingerichtete Geräte bleiben gültig.
  </p>
</section>
