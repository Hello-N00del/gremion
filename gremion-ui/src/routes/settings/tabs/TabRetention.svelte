<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { OPERATOR_DECISION_DE, RETENTION_CAPS, RETENTION_CAVEATS } from '$lib/retention-tiers'

  type RetentionConfig = {
    access_logs_days: number
    app_logs_days: number
    security_logs_days: number
    security_nopii_logs_days: number
  }

  export let retention: RetentionConfig

  // [D R29-I6]: the limits come from the one tier registry the server also uses.
  const CAPS: Record<keyof RetentionConfig, number> = RETENTION_CAPS

  const basisFor = (field: keyof RetentionConfig) =>
    `Max. ${CAPS[field]} Tage (Betreiber-Obergrenze 30 Tage für jede Protokollklasse, ${OPERATOR_DECISION_DE}; Art. 5 Abs. 1 lit. e DSGVO)`

  const LABELS: Record<keyof RetentionConfig, { label: string; basis: string }> = {
    access_logs_days: {
      label: 'Zugriffsprotokolle (Tage)',
      basis: basisFor('access_logs_days'),
    },
    app_logs_days: {
      label: 'Anwendungsprotokolle (Tage)',
      basis: basisFor('app_logs_days'),
    },
    security_logs_days: {
      label: 'Sicherheits-/Auditprotokolle mit Personenbezug (Tage)',
      basis: basisFor('security_logs_days'),
    },
    security_nopii_logs_days: {
      label: 'Sicherheitsprotokolle ohne Personenbezug (Tage)',
      basis: basisFor('security_nopii_logs_days'),
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
    Löschfristen für Protokolldaten. Werte oberhalb der Obergrenzen werden abgewiesen.
    Jede Änderung wird im Auditlog protokolliert.
    Derzeit setzt die Anwendung nur die Frist für Sicherheits-/Auditprotokolle mit Personenbezug
    selbst durch (tägliche Löschung). Die übrigen Fristen werden gespeichert, aber nicht automatisch
    angewendet; der Hinweis unter dem jeweiligen Feld nennt, was diese Protokolle heute begrenzt.
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
      {#if RETENTION_CAVEATS[field]}
        <p class="text-xs text-ink-muted">{RETENTION_CAVEATS[field]}</p>
      {/if}
      {#if val > cap}
        <p class="text-xs text-rust">
          Wert überschreitet die Obergrenze ({cap} Tage)
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
