// The code map: what the image build (apps/control-panel/codemap/image-step.sh) left in CODEMAP_DIR.
//
//   status.json    always there when the build step ran; ok:false says why there is no map
//   code-map.html  there only when status.ok is true
//
// Both file names are FIXED here: nothing from a request reaches a path. A missing, unreadable or malformed
// file never throws and never stops the panel: the page shows a notice and the log holds one line.
import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '$env/dynamic/private'

/** Where the runner stage copies the build output (Dockerfile: COPY --from=builder /codemap-out ./codemap). */
export const DEFAULT_DIR = '/app/codemap'
const STATUS_FILE = 'status.json'
const MAP_FILE = 'code-map.html'
const MAX_STATUS_BYTES = 1 << 20
const MAX_MAP_BYTES = 32 << 20

export interface StaleStep {
  walkthrough: string
  /** 1-based position in the written order. */
  step: number
  file?: string
  function?: string
  nodeId?: string
  text: string
}

export interface CodemapStatus {
  ok: boolean
  /** 40 lower-case hex characters, or "unknown". */
  commit: string
  generatedFor: string
  counts: { functions: number; connections: number }
  staleSteps: StaleStep[]
  staleAreas: string[]
  undescribedAreas: string[]
  reason: string | null
}

const dir = (): string => env.CODEMAP_DIR || DEFAULT_DIR

function unavailable(reason: string): CodemapStatus {
  return { ok: false, commit: 'unknown', generatedFor: 'unavailable', counts: { functions: 0, connections: 0 }, staleSteps: [], staleAreas: [], undescribedAreas: [], reason }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null)

function staleSteps(v: unknown): StaleStep[] | null {
  if (!Array.isArray(v)) return null
  const out: StaleStep[] = []
  for (const s of v) {
    if (!isRecord(s) || typeof s.walkthrough !== 'string' || typeof s.step !== 'number' || typeof s.text !== 'string') return null
    const e: StaleStep = { walkthrough: s.walkthrough, step: s.step, text: s.text }
    if (typeof s.file === 'string') e.file = s.file
    if (typeof s.function === 'string') e.function = s.function
    if (typeof s.nodeId === 'string') e.nodeId = s.nodeId
    out.push(e)
  }
  return out
}

/** Validates the parsed JSON; returns null for a shape that is not a status. */
function shape(v: unknown): CodemapStatus | null {
  if (!isRecord(v) || typeof v.ok !== 'boolean') return null
  const counts = isRecord(v.counts) ? v.counts : { functions: 0, connections: 0 }
  if (!isCount(counts.functions) || !isCount(counts.connections)) return null
  const steps = v.staleSteps === undefined ? [] : staleSteps(v.staleSteps)
  const areas = v.staleAreas === undefined ? [] : strings(v.staleAreas)
  const undescribed = v.undescribedAreas === undefined ? [] : strings(v.undescribedAreas)
  if (!steps || !areas || !undescribed) return null
  if (v.reason !== undefined && v.reason !== null && typeof v.reason !== 'string') return null
  const commit = typeof v.commit === 'string' && /^([0-9a-f]{40}|unknown)$/.test(v.commit) ? v.commit : 'unknown'
  const reason = v.ok ? null : typeof v.reason === 'string' && v.reason ? v.reason : 'Der Bau der Code-Karte hat keinen Grund angegeben.'
  return {
    ok: v.ok,
    commit,
    generatedFor: typeof v.generatedFor === 'string' ? v.generatedFor : 'unavailable',
    counts: { functions: counts.functions, connections: counts.connections },
    staleSteps: steps,
    staleAreas: areas,
    undescribedAreas: undescribed,
    reason,
  }
}

/** The status of the build, or ok:false with a reason. Never throws; logs once for a file it cannot use. */
export function readStatus(): CodemapStatus {
  const path = join(dir(), STATUS_FILE)
  let raw: string
  try {
    if (statSync(path).size > MAX_STATUS_BYTES) {
      console.error(`[control-panel] codemap: cannot read ${STATUS_FILE} (too large)`)
      return unavailable('Die Statusdatei der Code-Karte ist zu groß.')
    }
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'error'
    console.error(`[control-panel] codemap: cannot read ${STATUS_FILE} (${code})`)
    // only ENOENT says the file is absent; any other cause is reported as what it is
    return unavailable(code === 'ENOENT' ? 'Die Code-Karte ist in diesem Image nicht vorhanden (status.json fehlt).' : 'Die Statusdatei der Code-Karte konnte nicht gelesen werden.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    console.error(`[control-panel] codemap: ${STATUS_FILE} is not valid JSON`)
    return unavailable('Die Statusdatei der Code-Karte ist beschädigt.')
  }
  const s = shape(parsed)
  if (!s) {
    console.error(`[control-panel] codemap: ${STATUS_FILE} has an unexpected shape`)
    return unavailable('Die Statusdatei der Code-Karte hat ein unerwartetes Format.')
  }
  return s
}

export interface MapCheck {
  readable: boolean
  /** Why the page cannot be served (German, for the notice), or null when it can. */
  reason: string | null
}

/**
 * Whether the generated page can be served, for a status that says ok. It looks at the file (open, fstat, close)
 * and never reads its content. Logs one line when the page cannot be served: the fixed file name and an error
 * code or "too large", nothing else.
 */
export function checkMap(): MapCheck {
  const path = join(dir(), MAP_FILE)
  let fd: number | undefined
  let why: string | null = null
  let reason = ''
  try {
    fd = openSync(path, 'r')
    const st = fstatSync(fd)
    if (!st.isFile()) {
      why = 'not a file'
      reason = 'Die Seite der Code-Karte (code-map.html) konnte nicht gelesen werden.'
    } else if (st.size > MAX_MAP_BYTES) {
      why = 'too large'
      reason = 'Die Seite der Code-Karte (code-map.html) ist zu groß.'
    }
  } catch (err) {
    why = (err as NodeJS.ErrnoException)?.code ?? 'error'
    reason = why === 'ENOENT' ? 'Die Seite der Code-Karte (code-map.html) fehlt in diesem Image.' : 'Die Seite der Code-Karte (code-map.html) konnte nicht gelesen werden.'
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* nothing to do: the check has its answer */
      }
    }
  }
  if (why === null) return { readable: true, reason: null }
  console.error(`[control-panel] codemap: cannot use ${MAP_FILE} (${why})`)
  return { readable: false, reason }
}

/** The generated page, or null when it is not there or cannot be read. */
export function readMapHtml(): string | null {
  const path = join(dir(), MAP_FILE)
  try {
    if (statSync(path).size > MAX_MAP_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
