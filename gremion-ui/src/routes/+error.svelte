<script lang="ts">
  import PageTitle from '$lib/components/PageTitle.svelte'
  import { page } from '$app/state'
  import Icon from '$lib/components/ui/Icon.svelte'
  import { resolveBrand } from '$lib/brand'
  import { PLUGGABLE_MODULES } from '$lib/instance-status'
  import { t } from '$lib/i18n'

  // Tenant brand (v4 re-audit slice 10) — from the layout payload, default-backed.
  const brand = $derived(resolveBrand(page.data.brand))

  // #290 (HANDOVER-v8 Part D): a disabled-module PAGE deep link is thrown as
  // error(403, 'module-disabled:<id>') by hooks.server.ts. Render the honest
  // "Modul nicht aktiv" surface (not a generic 403) naming the module + offering
  // "Module verwalten" (it-admin only — the systemstatus route is it-admin-gated).
  const moduleOff = $derived.by(() => {
    const msg = page.error?.message ?? ''
    if (page.status !== 403 || !msg.startsWith('module-disabled')) return null
    const id = msg.split(':')[1] ?? ''
    const mod = PLUGGABLE_MODULES.find((m) => m.id === id)
    return { id, label: mod?.label ?? 'Dieses Modul', note: mod?.note ?? '' }
  })

  // v5 Task 4.4 — 403 role context. The layout payload threads the session
  // (see +layout.server.ts), so the forbidden page can name who is logged in
  // and with which realm role ("Angemeldet als X · Rolle Y"). Highest role wins
  // for the label (the role set is hierarchical). Labels resolve through the
  // i18n store (#187) so the English locale no longer leaks German.
  const ROLE_RANK = ['it-admin', 'council-admin', 'finance', 'member', 'guest']

  const sessionUser = $derived(
    (page.data.session as { user?: { name?: string; roles?: string[] } } | null)?.user ?? null,
  )
  const roleLabel = $derived.by(() => {
    const roles = sessionUser?.roles ?? []
    const top = ROLE_RANK.find((r) => roles.includes(r))
    return top ? $t(`error.role.${top}`) : $t('error.role.guest')
  })
  const isItAdmin = $derived((sessionUser?.roles ?? []).includes('it-admin'))

  // v5 Task 4.4 — 500 reference id (server-generated in handleError).
  const errId = $derived((page.error as App.Error | null)?.errId ?? null)

  const detail = $derived.by(() => {
    if (page.status === 403) return $t('error.detail.403')
    if (page.status === 404) return $t('error.detail.404')
    if (page.status === 500) return $t('error.detail.500')
    return page.error?.message ?? $t('error.detail.unknown')
  })

  const heading = $derived(
    moduleOff
      ? 'Modul nicht aktiv'
      : page.status === 404
        ? $t('error.heading.404')
        : $t('error.heading.generic'),
  )

  function reload() {
    if (typeof location !== 'undefined') location.reload()
  }
</script>

<PageTitle title={`${page.status}`} />

<div class="error-page">
  <div class="error-card">
    <div class="error-status" aria-hidden="true">{page.status}</div>
    <div class="eyebrow">{brand.product} · {page.status}</div>
    <h1 class="display error-heading">{heading}</h1>

    {#if moduleOff}
      <p class="error-detail">
        Das Modul <strong>{moduleOff.label}</strong> ist für diese Instanz abgeschaltet.
        Es erscheint nicht in der Navigation und belegt keine Rollen oder Realm-Gruppen.
      </p>
      {#if moduleOff.note}
        <div class="error-context">{moduleOff.note}</div>
      {/if}
    {:else}
      <p class="error-detail">{detail}</p>

      {#if page.status === 403}
        {#if sessionUser}
          <div class="error-context">
            {$t('error.context.403.signedInAs')} <strong>{sessionUser.name}</strong> · {$t('error.context.403.role')} <strong>{roleLabel}</strong>.
            {$t('error.context.403.needHigher')}
          </div>
        {:else}
          <div class="error-context">
            {$t('error.context.403.anonymous')}
          </div>
        {/if}
      {:else if page.status === 500}
        <div class="error-context">
          {$t('error.context.500')}
          {#if errId}
            <div class="error-ref mono">{$t('error.context.500.ref')} <strong>{errId}</strong></div>
          {/if}
        </div>
      {/if}
    {/if}

    <div class="error-actions">
      <a href="/" class="btn btn-primary">
        <Icon name="home" size={14} /> {$t('error.action.home')}
      </a>
      {#if moduleOff}
        {#if isItAdmin}
          <a href="/systemstatus" class="btn">
            <Icon name="activity" size={14} /> Module verwalten
          </a>
        {/if}
      {:else if page.status === 500}
        <button type="button" class="btn" onclick={reload}>
          <Icon name="refresh" size={14} /> {$t('error.action.retry')}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .error-page {
    display: flex;
    justify-content: center;
    padding: 80px 20px;
  }
  .error-card {
    width: 100%;
    max-width: 460px;
    text-align: center;
  }
  .error-status {
    font-family: var(--font-display);
    font-size: 84px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: -0.04em;
    color: var(--ink-faint);
  }
  .eyebrow {
    margin-top: 14px;
  }
  .error-heading {
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-top: 4px;
  }
  .error-detail {
    color: var(--ink-muted);
    font-size: 14px;
    margin-top: 8px;
  }
  .error-context {
    margin: 16px auto 0;
    max-width: 380px;
    padding: 10px 14px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--r-sm);
    font-size: 12.5px;
    color: var(--ink-2);
  }
  .error-ref {
    margin-top: 8px;
    font-size: 12px;
    letter-spacing: 0.04em;
    color: var(--ink-muted);
  }
  .error-ref strong {
    color: var(--ink);
  }
  .error-actions {
    display: flex;
    gap: 10px;
    justify-content: center;
    margin-top: 22px;
  }
</style>
