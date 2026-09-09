<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'

  type RetentionConfig = {
    access_logs_days: number
    app_logs_days: number
    security_logs_days: number
    security_nopii_logs_days: number
  }

  export let retention: RetentionConfig

  const CAPS: Record<keyof RetentionConfig, number> = {
    access_logs_days: 30,
    app_logs_days: 90,
    security_logs_days: 180,
    security_nopii_logs_days: 365,
  }

  const LABELS: Record<keyof RetentionConfig, { label: string; basis: string }> = {
    access_logs_days: {
      label: 'Zugriffsprotokolle (Tage)',
      basis: 'Max. 30 Tage (BayLDA, Art. 5 Abs. 1 lit. e DSGVO)',
    },
    app_logs_days: {
      label: 'Anwendungsprotokolle (Tage)',
      basis: 'Max. 90 Tage (Art. 5 Abs. 1 lit. e, Art. 6 Abs. 1 lit. f DSGVO)',
    },
    security_logs_days: {
      label: 'Sicherheits-/Auditprotokolle mit Personenbezug (Tage)',
      basis: 'Max. 180 Tage (BSI-Mindeststandard Protokollierung v2.1)',
    },
    security_nopii_logs_days: {
      label: 'Sicherheitsprotokolle ohne Personenbezug (Tage)',
      basis: 'Max. 365 Tage (BSI-Mindeststandard Ausnahmeregelung)',
    },
  }

  let values = { ...retention }
  let saving = false
  let saved = false
  let saveError = ''

  async function save() {
    saving = true
    saved = false
    saveError = ''
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retention: values }),
      })
      const body = await res.json()
      if (!res.ok) {
        saveError = body.error ?? 'Fehler beim Speichern'
      } else {
        saved = true
      }
    } finally {
      saving = false
    }
  }
</script>

<div class="space-y-6 pt-6">
  <p class="text-sm text-ink-muted">
    Löschfristen für Protokolldaten. Werte oberhalb der gesetzlichen Obergrenzen werden abgewiesen.
    Jede Änderung wird im Auditlog protokolliert.
  </p>

  {#each Object.entries(LABELS) as [key, { label, basis }]}
    {@const field = key as keyof RetentionConfig}
    {@const cap = CAPS[field]}
    {@const val = values[field]}
    <div class="space-y-1">
      <Label for={field}>{label}</Label>
      <Input
        id={field}
        type="number"
        min={1}
        max={cap}
        bind:value={values[field]}
        class={val > cap ? 'border-rust' : ''}
      />
      <p class="text-xs text-ink-muted">{basis}</p>
      {#if val > cap}
        <p class="text-xs text-rust">
          Wert überschreitet gesetzliche Obergrenze ({cap} Tage)
        </p>
      {/if}
    </div>
  {/each}

  {#if saveError}
    <p class="text-sm text-rust">{saveError}</p>
  {/if}
  {#if saved}
    <p class="text-sm text-green-600">Löschfristen gespeichert.</p>
  {/if}

  <Button onclick={save} disabled={saving}>
    {saving ? 'Speichern…' : 'Speichern'}
  </Button>
</div>
