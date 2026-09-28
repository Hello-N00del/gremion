// services/finance/src/exports/pdf.ts
// #383 Lane E3 — budget-statement PDF renderer (leaf side of getBudgetStatementPdf).
// Ported verbatim from the native oracle gremion-ui/.../finance/pdf/budget-statement.ts
// + the groupLinesIntoSections / toDtoEuroString helpers from
// gremion-ui/.../services/read/statement.ts + dto-map.ts.
//
// Like the native oracle, this emits an HTML document served under Content-Type:
// application/pdf — the surrounding stack has no headless HTML→PDF pipeline, so the
// HTML body IS the contract (a follow-up infra task swaps in a real renderer). Keeping
// the byte content IDENTICAL to the native means the ACL client passes it straight
// through and the observable bytes match across both modes.
import type { StatementLine } from '../store/index.js'

/** Legacy euro-string DTO field: internal cents (number) → '0.00'-style string.
 *  Mirror of dto-map.ts#toDtoEuroString. */
export function toEuroString(internal: number): string {
  return (internal / 100).toFixed(2)
}

export interface StatementSummary {
  plan: { id: number; name: string; state: string }
  sections: Array<{
    id: number
    name: string
    titel: Array<{ titel_nr: string; titel_name: string; ansatz: number; ist: number }>
  }>
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/** Group flat statement lines into sections for the PDF (mirror of
 *  read/statement.ts#groupLinesIntoSections). Section names are `Section <id>`. */
export function groupLinesIntoSections(lines: readonly StatementLine[]): StatementSummary['sections'] {
  const bySection = new Map<number, StatementLine[]>()
  for (const l of lines) {
    const arr = bySection.get(l.section_id) ?? []
    arr.push(l)
    bySection.set(l.section_id, arr)
  }
  return [...bySection.entries()].map(([sid, ls]) => ({
    id: sid,
    name: `Section ${sid}`,
    titel: ls.map((l) => ({
      titel_nr: l.titel_nr,
      titel_name: l.titel_name,
      ansatz: l.ansatz,
      ist: l.ist,
    })),
  }))
}

export function renderBudgetStatementHtml(stmt: StatementSummary): string {
  const sectionsHtml = stmt.sections
    .map((s) => {
      const rows = s.titel
        .map((t) => {
          const diff = t.ansatz - t.ist
          return `<tr>
        <td>${esc(t.titel_nr)}</td>
        <td>${esc(t.titel_name)}</td>
        <td class="num">${toEuroString(t.ansatz)}</td>
        <td class="num">${toEuroString(t.ist)}</td>
        <td class="num">${toEuroString(diff)}</td>
      </tr>`
        })
        .join('\n')
      return `<section><h2>${esc(s.name)}</h2>
      <table>
        <thead><tr>
          <th>Titel-Nr.</th><th>Bezeichnung</th>
          <th class="num">Ansatz</th><th class="num">Ist</th><th class="num">Diff</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Haushaltsabschluss — ${esc(stmt.plan.name)}</title>
  <style>
    body { font-family: serif; margin: 24mm; color: #111; }
    h1 { font-size: 18pt; margin: 0 0 8mm 0; }
    h2 { font-size: 13pt; margin: 6mm 0 2mm 0; }
    table { width: 100%; border-collapse: collapse; font-size: 10pt; }
    th, td { border-bottom: 1px solid #ccc; padding: 1mm 2mm; text-align: left; }
    th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  </style>
</head>
<body>
  <h1>${esc(stmt.plan.name)}</h1>
  <p>State: ${esc(stmt.plan.state)} · Plan-ID: ${stmt.plan.id}</p>
  ${sectionsHtml}
</body>
</html>`
}
