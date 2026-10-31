<script lang="ts">
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import ModuleOffWarning from '$lib/components/ModuleOffWarning.svelte'
  import ModuleSwitchNotice from '$lib/components/ModuleSwitchNotice.svelte'
  import { t } from '$lib/i18n'
  import { fillText } from '$lib/modules/fill-text'
  import type { ModuleDeletionPreview, ModuleOverview, ModuleOverviewItem } from '$lib/modules/switch-preview'

  // Karenz phase 1: the council admin's module switches. Switching a module ON is a request to the
  // platform (POST /api/settings/modules) that the host carries out; this page only reports what the
  // server says and polls while a request is pending. Nothing here reads as "switched" before the
  // request is applied. Switching OFF is shown but inert until phase 2 (overview.disableAvailable).
  let {
    pollMs = 5000,
    navigate = (url: string) => {
      window.location.assign(url)
    },
  }: { pollMs?: number; navigate?: (url: string) => void } = $props()

  const API = '/api/settings/modules'
  const STEP_UP = '/auth/step-up?returnTo=/settings/module'

  type Load = 'loading' | 'ready' | 'notConfigured' | 'error'
  let load = $state<Load>('loading')
  let overview = $state<ModuleOverview | null>(null)

  // The enable form with the DPIA fields (one module at a time).
  let dpiaFor = $state<string | null>(null)
  let dpiaAnswer = $state('')
  let dpiaRef = $state('')
  // A submit or preview in flight, and the last refusal text per module.
  let busyId = $state<string | null>(null)
  let errors = $state<Record<string, string>>({})
  // The switch-off warning (phase 2 reaches it; phase 1 renders the control inert).
  let warning = $state<{ preview: ModuleDeletionPreview; busy: boolean; error: string | null } | null>(null)

  const pending = $derived(overview?.modules.some((m) => m.pending.length > 0) ?? false)

  async function refresh(): Promise<void> {
    try {
      const res = await fetch(API)
      const body = await res.json().catch(() => null)
      if (res.status === 503 && body?.code === 'NOT_CONFIGURED') {
        load = 'notConfigured'
        return
      }
      if (!res.ok || !body?.success) {
        // A poll that fails keeps the last good list; only the first load turns into an error.
        if (overview === null) load = 'error'
        return
      }
      overview = body.data as ModuleOverview
      load = 'ready'
    } catch {
      if (overview === null) load = 'error'
    }
  }

  // First load in the browser (an effect never runs during SSR, which renders the loading state). untrack:
  // refresh() reads component state, and the load must run once, not whenever that state changes.
  $effect(() => {
    untrack(() => {
      void refresh()
    })
  })

  // Poll while any request is pending; the timer is gone as soon as nothing is.
  $effect(() => {
    if (!pending) return
    const id = setInterval(() => void refresh(), pollMs)
    return () => clearInterval(id)
  })

  function setError(moduleId: string, text: string | null) {
    const next = { ...errors }
    if (text === null) delete next[moduleId]
    else next[moduleId] = text
    errors = next
  }

  function openDpia(moduleId: string) {
    dpiaFor = moduleId
    dpiaAnswer = ''
    dpiaRef = ''
  }

  type Sent = { ok: true } | { ok: false; code: string; text: string }

  async function send(payload: Record<string, unknown>): Promise<Sent> {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}) as Record<string, unknown>)
      if (res.status === 201) return { ok: true }
      if (res.status === 401 && body?.error === 'STEP_UP_REQUIRED') return { ok: false, code: 'STEP_UP_REQUIRED', text: '' }
      return { ok: false, code: String(body?.code ?? 'ERROR'), text: String(body?.error ?? $t('settings.modules.error.generic')) }
    } catch {
      return { ok: false, code: 'NETWORK', text: $t('settings.modules.error.network') }
    }
  }

  async function enable(m: ModuleOverviewItem, dpia?: { requiresDpia: boolean; documentRef: string }) {
    busyId = m.moduleId
    setError(m.moduleId, null)
    const r = await send({ moduleId: m.moduleId, action: 'enable', ...(dpia ? { dpia } : {}) })
    busyId = null
    if (r.ok) {
      dpiaFor = null
      await refresh()
    } else if (r.code === 'STEP_UP_REQUIRED') {
      navigate(STEP_UP)
    } else if (r.code === 'DPIA_REQUIRED') {
      openDpia(m.moduleId)
    } else {
      setError(m.moduleId, r.text)
    }
  }

  function onEnable(m: ModuleOverviewItem) {
    if (!m.dpiaRecorded) openDpia(m.moduleId)
    else void enable(m)
  }

  function submitDpia(m: ModuleOverviewItem) {
    void enable(m, { requiresDpia: dpiaAnswer === 'yes', documentRef: dpiaRef.trim() })
  }

  async function onDisable(m: ModuleOverviewItem) {
    busyId = m.moduleId
    setError(m.moduleId, null)
    try {
      const res = await fetch(`${API}?preview=${encodeURIComponent(m.moduleId)}`)
      const body = await res.json().catch(() => null)
      if (!res.ok || !body?.success) {
        setError(m.moduleId, String(body?.error ?? $t('settings.modules.error.generic')))
        return
      }
      warning = { preview: body.data as ModuleDeletionPreview, busy: false, error: null }
    } catch {
      setError(m.moduleId, $t('settings.modules.error.network'))
    } finally {
      busyId = null
    }
  }

  async function confirmDisable(typed: string) {
    if (!warning) return
    const { moduleId } = warning.preview
    warning = { ...warning, busy: true, error: null }
    const r = await send({ moduleId, action: 'disable', confirm: typed })
    if (r.ok) {
      warning = null
      await refresh()
    } else if (r.code === 'STEP_UP_REQUIRED') {
      navigate(STEP_UP)
    } else {
      warning = { ...warning, busy: false, error: r.text }
    }
  }
</script>

<div class="space-y-5 py-4" data-testid="tab-modules">
  <p class="text-sm text-ink-muted">{$t('settings.modules.intro')}</p>

  {#if load === 'loading'}
    <p class="text-sm text-ink-muted" role="status">{$t('settings.modules.loading')}</p>
  {:else if load === 'notConfigured'}
    <p role="alert" class="rounded-md border border-rust/50 bg-rust-soft px-3 py-2 text-sm text-rust-ink">
      {$t('settings.modules.notConfigured')}
    </p>
  {:else if load === 'error' || !overview}
    <p role="alert" class="rounded-md border border-rust/50 bg-rust-soft px-3 py-2 text-sm text-rust-ink">
      {$t('settings.modules.loadError')}
    </p>
  {:else}
    {#if overview.problem}
      <p class="text-sm text-ink-muted">{overview.problem}</p>
    {/if}

    <ul class="space-y-3" aria-label={$t('settings.modules.list')}>
      {#each overview.modules as m (m.moduleId)}
        {@const request = m.pending[0]}
        <li class="space-y-3 rounded-lg border border-border p-4" data-module={m.moduleId}>
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="space-y-1">
              <h3 class="text-sm font-semibold">{m.label}</h3>
              <p class="text-xs text-ink-muted">
                <span>{m.enabled ? $t('settings.modules.state.on') : $t('settings.modules.state.off')}</span>
                ·
                <span>{m.dpiaRecorded ? $t('settings.modules.dpia.recorded') : $t('settings.modules.dpia.missing')}</span>
              </p>
              {#if m.denied}
                <p class="text-xs text-rust-ink">{fillText($t('settings.modules.denied'), { reason: m.denied })}</p>
              {/if}
            </div>

            {#if !m.denied}
              {#if m.enabled}
                {#if overview.disableAvailable}
                  <Button variant="outline" disabled={!!request || busyId === m.moduleId} onclick={() => onDisable(m)}>
                    {$t('settings.modules.disable')}
                  </Button>
                {:else}
                  <Button variant="outline" disabled>{$t('settings.modules.disable.soon')}</Button>
                {/if}
              {:else}
                <Button disabled={!!request || busyId === m.moduleId} onclick={() => onEnable(m)}>
                  {busyId === m.moduleId ? $t('settings.modules.submitting') : $t('settings.modules.enable')}
                </Button>
              {/if}
            {/if}
          </div>

          {#if request}
            <ModuleSwitchNotice moduleLabel={m.label} action={request.action} state={request.state} />
          {:else if m.lastFailure}
            <ModuleSwitchNotice moduleLabel={m.label} action="enable" state="failed" outcome={m.lastFailure} />
          {/if}

          {#if errors[m.moduleId]}
            <p role="alert" class="text-sm font-medium text-rust">{errors[m.moduleId]}</p>
          {/if}

          {#if dpiaFor === m.moduleId}
            <form
              class="space-y-3 rounded-md border border-border bg-surface-2 p-3"
              onsubmit={(e) => {
                e.preventDefault()
                submitDpia(m)
              }}
            >
              <p class="text-sm font-medium">{fillText($t('settings.modules.dpia.legend'), { module: m.label })}</p>
              <p class="text-xs text-ink-muted">{$t('settings.modules.dpia.hint')}</p>
              <div class="space-y-1">
                <Label for={`dpia-answer-${m.moduleId}`}>{$t('settings.modules.dpia.required.label')}</Label>
                <select
                  id={`dpia-answer-${m.moduleId}`}
                  bind:value={dpiaAnswer}
                  class="h-10 w-full rounded-md border border-border bg-paper px-3 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <option value="">{$t('settings.modules.dpia.choose')}</option>
                  <option value="yes">{$t('settings.modules.dpia.yes')}</option>
                  <option value="no">{$t('settings.modules.dpia.no')}</option>
                </select>
              </div>
              <div class="space-y-1">
                <Label for={`dpia-ref-${m.moduleId}`}>{$t('settings.modules.dpia.ref.label')}</Label>
                <Input id={`dpia-ref-${m.moduleId}`} bind:value={dpiaRef} maxlength={500} autocomplete="off" />
              </div>
              <div class="flex justify-end gap-2">
                <Button type="button" variant="outline" onclick={() => (dpiaFor = null)}>{$t('settings.modules.dpia.cancel')}</Button>
                <Button type="submit" disabled={busyId === m.moduleId || dpiaAnswer === '' || dpiaRef.trim() === ''}>
                  {$t('settings.modules.dpia.submit')}
                </Button>
              </div>
            </form>
          {/if}

          {#if warning && warning.preview.moduleId === m.moduleId}
            <ModuleOffWarning
              preview={warning.preview}
              busy={warning.busy}
              error={warning.error}
              onconfirm={confirmDisable}
              oncancel={() => (warning = null)}
            />
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
