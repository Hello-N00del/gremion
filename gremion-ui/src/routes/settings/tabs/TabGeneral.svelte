<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { t } from '$lib/i18n'
  import Icon from '$lib/components/ui/Icon.svelte'

  export let org: { name: string; domain: string; logo_path: string | null }

  let name = org.name
  let saving = false
  let saved = false
  let error = ''

  async function save() {
    if (!name.trim()) {
      error = $t('settings.general.org.name.required')
      return
    }
    saving = true
    saved = false
    error = ''
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // #168: Organisation owns BRANDING only. The public domain is the single
        // responsibility of Dienste & Portal (TabServices.savePortalUrl); we pass
        // the current org.domain through unchanged so a name-only save never
        // clobbers the canonical value.
        body: JSON.stringify({ org: { name: name.trim(), domain: org.domain, logo_path: org.logo_path } }),
      })
      if (!res.ok) {
        const body = await res.json()
        error = body.error ?? $t('settings.general.saveError')
        return
      }
      saved = true
      setTimeout(() => { saved = false }, 3000)
    } catch {
      error = $t('settings.general.connError')
    } finally {
      saving = false
    }
  }
</script>

<div class="space-y-8 py-4">
  <!-- Organisation — branding only (#168) -->
  <section class="space-y-4 max-w-lg">
    <h2 class="text-base font-semibold text-ink">{$t('settings.org.branding.title')}</h2>
    <p class="text-xs text-ink-muted">{$t('settings.org.branding.sub')}</p>

    <form class="space-y-4" onsubmit={(e) => { e.preventDefault(); save() }}>
      <div class="space-y-1.5">
        <Label for="g-name">{$t('settings.general.org.name')}</Label>
        <Input id="g-name" bind:value={name} maxlength={200} />
      </div>

      {#if error}
        <p class="text-sm text-rust" role="alert">{error}</p>
      {/if}

      <div class="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? $t('settings.general.saving') : $t('settings.general.save')}
        </Button>
        {#if saved}
          <span class="flex items-center gap-1 text-sm text-green-600" role="status">
            <Icon name="check" size={16} />
            {$t('settings.general.saved')}
          </span>
        {/if}
      </div>
    </form>

    <!-- Cross-ref: the public domain is owned by Dienste & Portal (#168) -->
    <p class="flex items-start gap-2 rounded-lg bg-accent/5 px-3 py-2.5 text-xs text-ink-muted">
      <Icon name="info" size={15} class="mt-px shrink-0 text-accent" />
      <span>
        Die <strong class="font-semibold text-ink">öffentliche Domain</strong> wird unter
        <strong class="font-semibold text-ink">Dienste &amp; Portal</strong> verwaltet — nicht hier.
      </span>
    </p>
  </section>
</div>
