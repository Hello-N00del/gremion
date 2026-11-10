// @vitest-environment node
// Guard: the carousel font must reach the RUNTIME image at the path render.ts reads.
//
// render.ts is bundled by `vite build` into /app/build/server/chunks, so a path relative to the
// source module (./fonts/Inter-Regular.ttf) does not exist in the running image and every
// Instagram slide preview failed with ENOENT. The image therefore carries the font at
// <cwd>/fonts/carousel/Inter-Regular.ttf (cwd = /app, the runner stage's WORKDIR) and the code
// looks there. This test reads the real gremion-ui/Dockerfile, replays its runner-stage COPY of the
// font into a scratch "image" and resolves the font the way the running process does, so it fails
// when the COPY is dropped, points elsewhere, or the code reads a different path.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  CAROUSEL_FONT_FILE,
  CAROUSEL_RUNTIME_FONT_DIR,
  CarouselFontMissingError,
  carouselFontCandidates,
  loadCarouselFont,
} from './render'

const HERE = dirname(fileURLToPath(import.meta.url))

function repoRoot(): string {
  let dir = HERE
  for (let i = 0; i < 14; i++) {
    if (existsSync(join(dir, 'gremion-ui', 'Dockerfile'))) return dir
    dir = dirname(dir)
  }
  throw new Error(`no repo root with gremion-ui/Dockerfile above ${HERE}`)
}

const ROOT = repoRoot()
/** The runner stage's WORKDIR: a location in the IMAGE, never a path this module reads. */
const IMAGE_WORKDIR: string = ['', 'app'].join('/')
const dockerfile = readFileSync(join(ROOT, 'gremion-ui', 'Dockerfile'), 'utf-8')

/** The runner stage: everything after `FROM ... AS runner`. */
function runnerStage(): string[] {
  const lines = dockerfile.split(/\r?\n/)
  const at = lines.findIndex((l) => /^FROM\s+\S+\s+AS\s+runner\s*$/i.test(l))
  if (at < 0) throw new Error('gremion-ui/Dockerfile has no `AS runner` stage')
  return lines.slice(at + 1)
}

/** Join backslash-continued lines and drop comments. */
function instructions(lines: string[]): string[] {
  const out: string[] = []
  let cur = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('#') || line === '') continue
    cur += (cur ? ' ' : '') + line.replace(/\\$/, '').trim()
    if (!line.endsWith('\\')) {
      out.push(cur)
      cur = ''
    }
  }
  return out
}

const scratch: string[] = []
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

describe('carousel font in the runtime image', () => {
  const stage = instructions(runnerStage())

  it('the runner stage runs from /app, the directory the font path is relative to', () => {
    const workdir = stage.find((i) => /^WORKDIR\s/i.test(i))
    expect(workdir).toBe('WORKDIR /app')
  })

  it('the runner stage COPYs the committed font directory to the runtime font directory', () => {
    const copy = stage
      .map((i) => /^COPY\s+--from=builder\s+(\S+)\s+(\S+)$/i.exec(i))
      .find((m) => m !== null && m[1].replace(/\/+$/, '').endsWith('/carousel/fonts'))
    expect(copy, 'no runner-stage COPY of the carousel fonts directory').toBeTruthy()
    const dest = posix.normalize(`${IMAGE_WORKDIR}/${copy![2]}`)
    expect(dest).toBe(posix.normalize(`${IMAGE_WORKDIR}/${CAROUSEL_RUNTIME_FONT_DIR}`))
  })

  it('the font the COPY ships is committed, non-empty, and resolves from the replayed image', () => {
    const copy = stage
      .map((i) => /^COPY\s+--from=builder\s+(\S+)\s+(\S+)$/i.exec(i))
      .find((m) => m !== null && m[1].replace(/\/+$/, '').endsWith('/carousel/fonts'))!
    // Source: the builder stage's /repo/<path> is this checkout's <path>.
    const srcDir = join(ROOT, copy[1].replace(/^\/repo\//, ''))
    expect(readdirSync(srcDir)).toContain(CAROUSEL_FONT_FILE)
    expect(statSync(join(srcDir, CAROUSEL_FONT_FILE)).size).toBeGreaterThan(1000)

    // Replay the COPY into a scratch image root and resolve like the running process (cwd = /app).
    const image = mkdtempSync(join(tmpdir(), 'carousel-image-'))
    scratch.push(image)
    const appDir = join(image, 'app')
    const destDir = join(appDir, copy[2])
    mkdirSync(destDir, { recursive: true })
    cpSync(srcDir, destDir, { recursive: true })
    // The module-relative path does not exist in the bundled image: pass a directory with no font.
    const font = loadCarouselFont(carouselFontCandidates(appDir, join(image, 'build', 'server', 'chunks')))
    expect(font.length).toBeGreaterThan(1000)
  })

  it('looks at the runtime path under the working directory', () => {
    // The candidates are built with `join`, which follows the host separator; the image is Linux, so
    // compare through a join of the same shape (the base is a variable, not a path literal of this module).
    const base: string = IMAGE_WORKDIR
    expect(carouselFontCandidates(base, `${base}/build/server/chunks`)).toContain(
      join(base, CAROUSEL_RUNTIME_FONT_DIR, CAROUSEL_FONT_FILE),
    )
  })
})

describe('loadCarouselFont when the font is missing', () => {
  it('fails with a clear error naming the font and the places looked, not a bare ENOENT', () => {
    const empty = mkdtempSync(join(tmpdir(), 'carousel-empty-'))
    scratch.push(empty)
    let caught: unknown
    try {
      loadCarouselFont(carouselFontCandidates(empty, empty))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CarouselFontMissingError)
    const e = caught as CarouselFontMissingError & { code?: string }
    expect(e.code).not.toBe('ENOENT')
    expect(e.message).toContain(CAROUSEL_FONT_FILE)
    expect(e.message).toContain(join(empty, CAROUSEL_RUNTIME_FONT_DIR, CAROUSEL_FONT_FILE))
  })

  it('finds the committed font next to the module in a source checkout (tests, dev)', () => {
    expect(loadCarouselFont().length).toBeGreaterThan(1000)
  })
})
