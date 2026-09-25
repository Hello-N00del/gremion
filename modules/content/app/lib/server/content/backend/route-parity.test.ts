import { describe, it, expect } from 'vitest'
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const gremionUiRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..')

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

describe('content routes go through the backend seam', () => {
  it('no +server.ts/+page.server.ts under routes/api/content or routes/content imports content-db directly', () => {
    const roots = [
      join(gremionUiRoot, 'src', 'routes', 'api', 'content'),
      join(gremionUiRoot, 'src', 'routes', 'content'),
    ]
    const files: string[] = []
    for (const root of roots) {
      for (const abs of walk(root)) {
        const rel = relative(gremionUiRoot, abs).split('\\').join('/')
        if (rel.endsWith('+server.ts') || rel.endsWith('+page.server.ts')) {
          files.push(rel)
        }
      }
    }
    const offenders = files.filter(f =>
      /from ['"][^'"]*content\/content-db['"]/.test(readFileSync(join(gremionUiRoot, f), 'utf8'))
    )
    expect(offenders).toEqual([])
  })
})
