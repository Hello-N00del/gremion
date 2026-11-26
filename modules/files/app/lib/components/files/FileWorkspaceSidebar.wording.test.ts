// German interface wording of the files page: the sidebar headings and the handoff card use German
// words, not the English "Workspaces" / "Tags" or a badge about an "external module".
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/svelte'
import FileWorkspaceSidebar from './FileWorkspaceSidebar.svelte'

describe('files page wording', () => {
  it('the sidebar headings are Bereiche and Schlagwörter', () => {
    const { container } = render(FileWorkspaceSidebar, { props: { workspaces: [], active: '', onSelect: () => {} } })
    const headings = Array.from(container.querySelectorAll('.eyebrow')).map((e) => e.textContent?.trim())
    expect(headings).toEqual(['Bereiche', 'Schlagwörter'])
  })

  it('the page has no "Externes Modul" badge and no leftover style for it', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const page = readFileSync(join(here, '../../../routes/files/+page.svelte'), 'utf8')
    expect(page).not.toMatch(/Externes Modul/i)
    expect(page).not.toContain('view-restriction')
  })
})
