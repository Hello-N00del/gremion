<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { t } from '$lib/i18n'
  import Icon from '$lib/components/ui/Icon.svelte'

  // (open-core carve) This tab formerly rendered feature-module toggles
  // (finance / elections) plus a "required modules" list (files / messages /
  // calendar / users) — all satellites removed by the open-core carve. The
  // governance kernel ships only the always-on core + governance modules
  // (non-toggleable), so there is nothing to toggle here; the tab now configures
  // the public portal URL only. A re-added feature module contributes its own
  // settings surface via a registered slot, not a hardcoded toggle here.
  export let org: { name: string; domain: string; logo_path: string | null }

  let portalDomain = org.domain
  let portalSaving = false
  let portalSaved = false
  let portalError = ''

  async function savePortalUrl() {
    const trimmed = portalDomain.trim()
    if (!trimmed) {
      portalError = $t('settings.services.portal.required')
      return
    }
    portalSaving = true
    portalSaved = false
    portalError = ''
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org: { domain: trimmed } }),
      })
      if (!res.ok) {
        const body = await res.json()
        portalError = body.error ?? $t('settings.services.saveError')
        return
      }
      portalSaved = true
      setTimeout(() => { portalSaved = false }, 3000)
    } catch {
      portalError = $t('settings.services.connError')
    } finally {
      portalSaving = false
    }
  }
</script>

<div class="space-y-6 py-4">
  <h2 class="text-base font-semibold text-ink">{$t('settings.services.title')}</h2>

  <!-- Public portal URL -->
  <section class="space-y-3 max-w-lg">
    <div>
      <h3 class="text-sm font-semibold text-ink">Öffentliches Portal</h3>
      <p class="text-xs text-ink-muted mt-0.5">
        Hostname des öffentlich erreichbaren StuRa-Portals.
        <strong class="font-semibold text-ink">Einzige Quelle</strong> für die öffentliche Domain (#168).
      </p>
    </div>
    <form
      class="space-y-3"
      onsubmit={(e) => { e.preventDefault(); savePortalUrl() }}
    >
      <div class="space-y-1.5">
        <Label for="portal-domain">Portal-URL</Label>
        <Input
          id="portal-domain"
          bind:value={portalDomain}
          placeholder="stura.example.de"
          maxlength={253}
        />
        <p class="text-xs text-ink-muted">Hostname ohne Schema (https:// wird automatisch ergänzt).</p>
      </div>

      {#if portalError}
        <p class="text-sm text-rust" role="alert">{portalError}</p>
      {/if}

      <div class="flex items-center gap-3">
        <Button type="submit" disabled={portalSaving}>
          {portalSaving ? $t('settings.general.saving') : $t('settings.general.save')}
        </Button>
        {#if portalSaved}
          <span class="flex items-center gap-1 text-sm text-green-600" role="status">
            <Icon name="check" size={16} />
            {$t('settings.general.saved')}
          </span>
        {/if}
      </div>
    </form>
  </section>
</div>
