<script lang="ts">
  import { AUDIT_LOG_RECORD_DE, OPERATOR_DECISION_DE, RETENTION_DEFAULTS, RETENTION_CAVEATS, type RetentionField } from '$lib/retention-tiers'

  // TASK-033-a (Q6): the deletion windows are fixed by the retention registry and
  // are not editable here. The numbers shown are the log-store windows (the one tier module the
  // server also reads), not a stored setting. The audit table has no window: it is a governance
  // record that no timer deletes (RC-GOV-CHAIN).
  const LABELS: Record<RetentionField, string> = {
    access_logs_days: 'Zugriffsprotokolle',
    app_logs_days: 'Anwendungsprotokolle',
    security_logs_days: 'Sicherheitsprotokolle mit Personenbezug',
    security_nopii_logs_days: 'Sicherheitsprotokolle ohne Personenbezug',
  }
</script>

<div class="space-y-6 pt-6">
  <p class="text-sm text-ink-muted">
    Löschfristen für Protokolldaten. Die Fristen sind fest vorgegeben und können nicht geändert werden;
    kein Protokoll wird länger als 30 Tage aufbewahrt ({OPERATOR_DECISION_DE}; Art. 5 Abs. 1 lit. e DSGVO).
    {AUDIT_LOG_RECORD_DE} Bei den Protokollen nennt der Hinweis unter der jeweiligen Frist, was sie heute begrenzt.
  </p>

  <dl class="space-y-4">
    {#each Object.entries(LABELS) as [key, label]}
      {@const field = key as RetentionField}
      <div class="space-y-1" data-retention-field={field}>
        <dt class="text-sm font-medium">{label}</dt>
        <dd class="text-sm">{RETENTION_DEFAULTS[field]} Tage</dd>
        {#if RETENTION_CAVEATS[field]}
          <dd class="text-xs text-ink-muted">{RETENTION_CAVEATS[field]}</dd>
        {/if}
      </div>
    {/each}
  </dl>
</div>
