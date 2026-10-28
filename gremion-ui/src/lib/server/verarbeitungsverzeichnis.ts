import type { GremionConfig } from './config'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import type { ModuleManifest } from '$lib/modules/types'

// TRD-162 / PRD-REG-004: record of processing activities (Verzeichnis von
// Verarbeitungstätigkeiten, GDPR Art. 30(1)). Same shape as the Löschkonzept
// generator: a pure function of the tenant's config, rebuilt on every call so
// enabling or disabling a module changes the document without any sync step.

export interface ProcessingActivity {
  moduleId: string
  activity: string
  purpose: string
  dataCategories: string[]
  dataSubjects: string[]
  recipients: string[]
  retention: string
  /** The module ships a processing declaration (false = placeholder row). */
  declared: boolean
  /** At least one field comes from a tenant admin override. */
  overridden: boolean
}

const NOT_RECORDED = '(nicht erfasst — bitte ergänzen)'

function isEnabled(m: ModuleManifest, config: GremionConfig): boolean {
  return !m.toggleable || (config.modules?.[m.id] ?? true) !== false
}

export function buildProcessingActivities(
  config: GremionConfig,
  manifests: readonly ModuleManifest[] = MODULE_MANIFESTS,
): ProcessingActivity[] {
  const overrides = config.compliance.processing_overrides ?? {}
  return manifests
    .filter((m) => isEnabled(m, config))
    .map((m) => {
      const p = m.processing
      const o = overrides[m.id]
      return {
        moduleId: m.id,
        activity: o?.activity ?? p?.activity ?? m.status?.label ?? m.id,
        purpose: o?.purpose ?? p?.purpose ?? NOT_RECORDED,
        dataCategories: o?.data_categories ?? p?.dataCategories ?? [],
        dataSubjects: o?.data_subjects ?? p?.dataSubjects ?? [],
        recipients: o?.recipients ?? p?.recipients ?? [],
        retention: o?.retention ?? p?.retention ?? NOT_RECORDED,
        declared: p !== undefined,
        overridden: o !== undefined && Object.keys(o).length > 0,
      }
    })
}

const list = (xs: string[]): string => (xs.length ? xs.join('; ') : NOT_RECORDED)
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function generateVerarbeitungsverzeichnis(
  config: GremionConfig,
  asOf: Date = new Date(),
  manifests: readonly ModuleManifest[] = MODULE_MANIFESTS,
): string {
  const { compliance } = config
  const dateStr = asOf.toISOString().slice(0, 10)
  const activities = buildProcessingActivities(config, manifests)

  const sections = activities
    .map(
      (a, i) => `### 2.${i + 1} ${a.activity}${a.overridden ? ' *(angepasst)*' : ''}

| Angabe (Art. 30 Abs. 1 DSGVO) | Inhalt |
|---|---|
| Zweck der Verarbeitung (lit. b) | ${cell(a.purpose)} |
| Kategorien betroffener Personen (lit. c) | ${cell(list(a.dataSubjects))} |
| Kategorien personenbezogener Daten (lit. c) | ${cell(list(a.dataCategories))} |
| Empfänger (lit. d) | ${cell(a.recipients.length ? a.recipients.join('; ') : 'keine über den Verantwortlichen hinaus')} |
| Löschfristen (lit. f) | ${cell(a.retention)} |
| Technische und organisatorische Maßnahmen (lit. g) | siehe Anlage TOM / Löschkonzept |
`,
    )
    .join('\n')

  return `# Verzeichnis von Verarbeitungstätigkeiten — ${compliance.controller_name || '(nicht konfiguriert)'}
*Stand: ${dateStr} | Vorbefüllt aus den aktivierten Modulen; durch die Administration anpassbar*

## 1. Verantwortliche Stelle (Art. 30 Abs. 1 lit. a DSGVO)

**Bezeichnung:** ${compliance.controller_name || '(nicht konfiguriert)'}
**Anschrift:** ${compliance.controller_address || '(nicht konfiguriert)'}
**Datenschutzbeauftragte(r):** ${compliance.dpo_name || '(nicht konfiguriert)'} — ${compliance.dpo_email || ''}

## 2. Verarbeitungstätigkeiten

${sections}
---
*Dieses Verzeichnis wird bei jeder Änderung der aktivierten Module neu erzeugt; Anpassungen der Administration bleiben erhalten.*
`
}
