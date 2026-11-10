// workflows.mjs - a small line scanner for the jobs of a GitHub workflow file. PURE: it takes text and returns jobs.
//
// There is no YAML library here on purpose. The code map must hold the same jobs in git mode (CI, where `yaml` may be
// installed) and in tree mode (the image, where it is not). The scanner reads the lines of the file and nothing else,
// so both modes give one result. It does not catch its own errors: a value that is not text, a file without jobs and
// garbage give no jobs, and the caller (extract.mjs) catches an error for each file, logs it and keeps the file node.
//
// What it finds, under the top-level `jobs:` key:
//   id           the job id, at indent 2
//   name         `name:` at indent 4, quotes removed; empty when the value holds `${{`
//   line         the line of the job id (1 based)
//   needs        `needs:` as a single value, an inline list or a block list
//   dockerfiles  every `dockerfile:` value in the job, also in an inline matrix map such as `{ name: x, dockerfile: a/Dockerfile }`,
//                and the literal path of `-f` or `--file` in a `docker build` or `docker buildx build` command of a `run:`,
//                taken from the `working-directory` of its own step (as for scripts); a directory that only a run knows gives none
//   scripts      repo scripts that `node`, `node --test`, `bash` or `sh` run (a test file is skipped)
//   runs         the same scripts, each paired with the working directory of its own step: { script, dir }
//                (dir is the `working-directory:` of the step, else the job default under `defaults:`, else '')
//   filters      the package names of `pnpm --filter <name>`
//   workingDirs  `working-directory:` values; `${{ matrix.<key> }}` stands for every literal value of `<key>` in the matrix of the job
//                (the matrix of the strategy of the job: its own keys and the keys of its include: items, not `exclude:`, not a deeper key)
// A value that holds an expression (`${{`) or a shell variable is never taken: the scanner cannot know its value.

import { posix } from 'node:path'

const MAX_LINE = 4000 // a longer line is cut before it is scanned, so no line can make the scan slow

// A comment starts at a # that follows a space (or starts the text) and is not inside a quoted value. A quote only
// opens at the start of a token and only when it closes: an apostrophe in prose ("don't") is not a quote.
const stripComment = (s) => {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if ((c === '"' || c === "'") && (i === 0 || /[\s[,{:]/.test(s[i - 1]))) {
      const close = s.indexOf(c, i + 1)
      if (close > 0) { i = close; continue }
    }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd()
  }
  return s.trimEnd()
}
const unquote = (s) => {
  const t = s.trim()
  const m = /^"([^"]*)"|^'([^']*)'/.exec(t)
  return m ? (m[1] ?? m[2]) : t
}
const clean = (s) => s.trim().replace(/^\.\//, '').replace(/\/+$/, '')
// `${{ x }}` and `$VAR` both hold a `$`. A value with a `$` has a value that only the run of the job knows.
const hasExpression = (s) => s.includes('$')
const indentOf = (line) => line.length - line.trimStart().length
const isBlank = (line) => line.trim() === ''
const isComment = (line) => line.trimStart().startsWith('#')

const SCRIPT_CMD = /(?:^|[\s;&|(`'"])(node|bash|sh)(?=\s)/g
const SCRIPT_PATH = /^[A-Za-z0-9_@./-]+\.(?:mjs|cjs|js|mts|cts|ts|sh)$/
const SEPARATORS = new Set(['&&', '||', ';', '|', '>', '>>', '<', '<<', '&'])

/** The repo scripts that one line runs through node, bash or sh. */
function scriptsOfLine(line) {
  const out = []
  SCRIPT_CMD.lastIndex = 0
  let m
  while ((m = SCRIPT_CMD.exec(line))) {
    const tokens = line.slice(m.index + m[0].length).split(/\s+/).filter(Boolean)
    const several = m[1] === 'node' && tokens.includes('--test') // node --test takes many files
    for (const raw of tokens) {
      if (SEPARATORS.has(raw) || raw.startsWith('#')) break
      if (raw.startsWith('-')) continue // a flag
      const t = clean(unquote(raw.replace(/[;)&|]+$/, '')))
      if (t && !hasExpression(t) && SCRIPT_PATH.test(t) && !t.startsWith('/') && !t.startsWith('../') && !/\.(?:test|spec)\./.test(t)) out.push(t)
      if (!several) break // the first word that is not a flag is the script, or something that is not a script
    }
  }
  return out
}

// `docker build` and `docker buildx build`: a -f or --file path with no `$` is a Dockerfile of the job.
// It is read only from the `run:` of a step, and only where a command can start: at the start of a line, or after
// `;`, `&&`, `||`, `|`, `&`, `(`, a shell keyword, `sudo`, `time` or a variable assignment. A word that an `echo`
// prints is not a command. The path is a path from the working directory of the step (see finish() in parseJobs).
const FILE_PATH = /^[A-Za-z0-9_@./-]+$/
// A word is text with quoted parts; a separator is a word of its own, also when it is written next to a word.
const WORD_OR_SEPARATOR = /(?:"[^"]*"|'[^']*'|[^\s;&|<>("'])+|&&|\|\||[;&|<>(]/g
const IS_SEPARATOR = /^(?:&&|\|\||[;&|<>(])$/
const COMMAND_PREFIX = /^(?:sudo|time|if|then|else|elif|do|while|until|!|exec|command|[A-Za-z_][A-Za-z0-9_]*=.*)$/
const unquoteWord = (w) => w.replace(/["']/g, '')

/** The -f / --file values of the words of one docker build command (the words after `build`). */
function dockerFileValues(args, out) {
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]
    let v
    if (raw === '-f' || raw === '--file') v = args[++i]
    else {
      const m = /^(?:--file=|-f=?)(.+)$/.exec(raw)
      if (m) v = m[1]
    }
    if (v === undefined) continue
    const t = clean(unquoteWord(v).replace(/\)+$/, ''))
    if (t && t !== '-' && FILE_PATH.test(t) && !t.startsWith('/')) out.push(t)
  }
}
/** The Dockerfiles that one command line builds (a line that is already joined: no `\` at its end). */
function dockerfilesOfCommandLine(line) {
  const out = []
  const words = line.match(WORD_OR_SEPARATOR) ?? []
  const commands = [[]]
  for (const w of words) {
    if (IS_SEPARATOR.test(w)) commands.push([])
    else commands[commands.length - 1].push(w)
  }
  for (const cmd of commands) {
    let i = 0
    while (i < cmd.length && COMMAND_PREFIX.test(cmd[i])) i++
    if (cmd[i] !== 'docker') continue
    i++
    if (cmd[i] === 'buildx') i++
    if (cmd[i] === 'build') dockerFileValues(cmd.slice(i + 1), out)
  }
  return out
}
/**
 * The lines of a `run:` joined as the shell reads them: a line that ends in `\` goes on with the next line; for a
 * folded value (`run: >`) every line goes on with the next one.
 */
function dockerfilesOfRun(run) {
  const joined = []
  let cur = null
  for (const raw of run.lines) {
    const l = raw.trim()
    const goesOn = run.folded || l.endsWith('\\')
    const piece = !run.folded && l.endsWith('\\') ? l.slice(0, -1) : l
    cur = cur === null ? piece : `${cur} ${piece}`
    if (!goesOn) { joined.push(cur); cur = null }
  }
  if (cur !== null) joined.push(cur)
  const out = []
  for (const line of joined) for (const f of dockerfilesOfCommandLine(line)) if (!out.includes(f)) out.push(f)
  return out
}

// A matrix value is a plain word or path. `${{ matrix.key }}` in a working-directory stands for those values.
const MATRIX_REF = /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/
/** { dir } for a value that is known, { dir: '', tpl } for a value that holds one matrix expression and nothing else that is unknown. */
function dirOfValue(v) {
  if (!v || v === '.') return { dir: '' }
  const m = MATRIX_REF.exec(v)
  if (m) {
    const pre = v.slice(0, m.index), post = v.slice(m.index + m[0].length)
    if (!hasExpression(pre + post)) return { dir: '', tpl: { key: m[1], pre, post } }
  }
  return hasExpression(v) ? { dir: '', unknown: true } : { dir: v }
}

// ---- the matrix of a job: a small reader of the part of YAML that a matrix uses ----
// A matrix holds block maps and block lists, flow lists `[a, b]` and flow maps `{ k: v }` (also over several lines),
// and plain or quoted values. The reader never throws: text it does not know gives an empty value. It reads the
// matrix into maps and lists, and only then looks for a key. A key counts when it is a key of the matrix itself, or a
// key of an item of `include:`. A key in a deeper map, in another key, or in `exclude:` does not count.
const MAX_DEPTH = 8
const MAX_FLOW_LINES = 200
const KEY_START = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.@/-]+)\s*:(?=\s|$)/
const DASH_START = /^-(?:\s|$)/
const FLOW_SCALAR = /^(?:"[^"]*"|'[^']*'|(?:\$\{\{[^}]*\}\}|[^,\]}[{])*)/
const isBare = (o) => o !== null && typeof o === 'object' && !Array.isArray(o)

/** A value in flow style, read from the start of `s`: { node, rest }. */
function readFlow(s, depth = 0) {
  s = s.trimStart()
  if (depth > MAX_DEPTH || !s) return { node: '', rest: '' }
  if (s[0] === '[') {
    const items = []
    let rest = s.slice(1)
    for (;;) {
      rest = rest.trimStart()
      if (!rest) break
      if (rest[0] === ']') { rest = rest.slice(1); break }
      if (rest[0] === ',') { rest = rest.slice(1); continue }
      const r = readFlow(rest, depth + 1)
      if (r.rest.length >= rest.length) { rest = rest.slice(1); continue } // no progress: drop one character
      items.push(r.node)
      rest = r.rest
    }
    return { node: items, rest }
  }
  if (s[0] === '{') {
    const map = Object.create(null)
    let rest = s.slice(1)
    for (;;) {
      rest = rest.trimStart()
      if (!rest) break
      if (rest[0] === '}') { rest = rest.slice(1); break }
      if (rest[0] === ',') { rest = rest.slice(1); continue }
      const km = /^("[^"]*"|'[^']*'|[^\s,:{}[\]]+)\s*:(?:\s+|(?=[,}\]]|$))/.exec(rest)
      if (!km) { rest = rest.slice(1); continue }
      const r = readFlow(rest.slice(km[0].length), depth + 1)
      map[unquote(km[1])] = r.node
      rest = r.rest
    }
    return { node: map, rest }
  }
  const m = FLOW_SCALAR.exec(s)
  const len = m ? m[0].length : 0
  return { node: unquote(s.slice(0, len)).trim(), rest: s.slice(len) }
}
const unbalanced = (s) => {
  let depth = 0
  for (const c of s.replace(/"[^"]*"|'[^']*'/g, '')) {
    if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
  }
  return depth > 0
}
/** A value that starts on line `p` with `text`: a flow value goes on over the next lines until it is closed. Returns { node, next }. */
function readValue(L, p, text) {
  const t = text.trim()
  if (t[0] !== '[' && t[0] !== '{') return { node: unquote(t).trim(), next: p + 1 }
  let joined = t
  let q = p + 1
  while (unbalanced(joined) && q < L.length && q - p < MAX_FLOW_LINES) joined += ' ' + L[q++].text
  return { node: readFlow(joined).node, next: q }
}
/** A block node that starts on line `p` (lines are { ind, text }). Returns { node, next }; next is always more than p. */
function readBlock(L, p, depth = 0) {
  if (depth > MAX_DEPTH || p >= L.length) return { node: '', next: Math.max(p + 1, L.length) }
  const ind = L[p].ind
  if (DASH_START.test(L[p].text)) {
    const items = []
    while (p < L.length && L[p].ind === ind && DASH_START.test(L[p].text)) {
      const after = L[p].text.replace(/^-\s*/, '')
      const off = L[p].text.length - after.length
      if (!after) {
        p++
        if (p < L.length && L[p].ind > ind) { const r = readBlock(L, p, depth + 1); items.push(r.node); p = r.next } else items.push('')
      } else if (KEY_START.test(after)) {
        // a map that starts on the line of the dash: its other keys sit at the column of the first key
        const sub = [{ ind: ind + off, text: after }]
        let q = p + 1
        while (q < L.length && L[q].ind > ind) sub.push(L[q++])
        items.push(readBlock(sub, 0, depth + 1).node)
        p = q
      } else {
        const r = readValue(L, p, after)
        items.push(r.node)
        p = r.next
      }
    }
    return { node: items, next: p }
  }
  if (KEY_START.test(L[p].text)) {
    const map = Object.create(null)
    while (p < L.length && L[p].ind === ind) {
      const m = KEY_START.exec(L[p].text)
      if (!m) break
      const key = unquote(m[1])
      const value = L[p].text.slice(m[0].length)
      if (!value.trim()) {
        p++
        // the value is a block that sits deeper, or a list at the indent of the key
        if (p < L.length && (L[p].ind > ind || (L[p].ind === ind && DASH_START.test(L[p].text)))) { const r = readBlock(L, p, depth + 1); map[key] = r.node; p = r.next } else map[key] = ''
      } else {
        const r = readValue(L, p, value)
        map[key] = r.node
        p = r.next
      }
    }
    return { node: map, next: Math.max(p, 1) }
  }
  const r = readValue(L, p, L[p].text)
  return { node: r.node, next: r.next }
}
/** The matrix as a map of key to the literal values it has: { dir: ['a', 'b'] }. */
function matrixValues(rest, lines) {
  const vals = new Map()
  let node
  if (rest) node = readValue([{ ind: 0, text: rest }, ...lines], 0, rest).node
  else {
    node = ''
    for (let p = 0; p < lines.length; ) { const r = readBlock(lines, p); if (isBare(r.node)) { node = r.node; break } p = Math.max(r.next, p + 1) }
  }
  const add = (key, v) => {
    const list = Array.isArray(v) ? v : [v]
    for (const x of list) {
      if (typeof x !== 'string' || !x.trim()) continue
      if (!vals.has(key)) vals.set(key, [])
      vals.get(key).push(x.trim())
    }
  }
  if (isBare(node)) {
    for (const [key, v] of Object.entries(node)) {
      if (key === 'exclude') continue
      if (key === 'include') {
        for (const item of Array.isArray(v) ? v : []) if (isBare(item)) for (const [k, iv] of Object.entries(item)) add(k, iv)
      } else add(key, v)
    }
  }
  return vals
}

/** Every directory a matrix expression stands for. A key that has no literal value gives none. */
function expandDirs(mx, tpl) {
  const out = []
  for (const raw of mx.vals.get(tpl.key) ?? []) {
    const v = clean(tpl.pre + raw + tpl.post)
    if (v && v !== '.' && FILE_PATH.test(v) && !v.startsWith('/') && !v.startsWith('../') && !out.includes(v)) out.push(v)
  }
  return out
}


const push = (arr, v) => { if (v && !arr.includes(v)) arr.push(v) }

/**
 * @param {unknown} text the text of one workflow file
 * @returns {Array<{id:string,name:string,line:number,needs:string[],dockerfiles:string[],scripts:string[],runs:Array<{script:string,dir:string}>,filters:string[],workingDirs:string[]}>}
 */
export function parseJobs(text) {
  if (typeof text !== 'string') return []
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => (l.length > MAX_LINE ? l.slice(0, MAX_LINE) : l))
  let start = -1
  for (let i = 0; i < lines.length; i++) if (/^jobs:\s*(#.*)?$/.test(lines[i])) { start = i; break }
  if (start < 0) return []
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (!isBlank(lines[i]) && !isComment(lines[i]) && indentOf(lines[i]) === 0) { end = i; break }
  }

  const jobs = []
  let cur = null
  // What is read of the steps of the current job. `dir` of a step is undefined until the step has a working-directory.
  let st = null
  // `strat`: the job is inside its `strategy:` key; `stratChild` is the indent of the keys of the strategy. `run` is the
  // `run:` value of the current step while its lines are read. `mx` is the matrix: its lines, until the matrix ends, then its values.
  const fresh = () => ({ inSteps: false, stepInd: -1, step: null, jobDir: '', jobTpl: null, jobUnknown: false, tpls: [], runs: [], dockerRuns: [], run: null, strat: false, stratChild: -1, mx: { ind: -1, done: false, rest: '', lines: [], vals: new Map() } })
  const flushRun = () => {
    const run = st.run
    st.run = null
    if (run && st.step) for (const f of dockerfilesOfRun(run)) st.step.dockers.push(f)
  }
  const closeStep = () => {
    flushRun()
    if (!st.step) return
    for (const script of st.step.scripts) st.runs.push({ script, dir: st.step.dir, tpl: st.step.tpl })
    for (const file of st.step.dockers) st.dockerRuns.push({ file, dir: st.step.dir, tpl: st.step.tpl, unknown: st.step.unknown })
    st.step = null
  }
  const closeMatrix = () => {
    const mx = st.mx
    if (mx.ind < 0) return
    mx.vals = matrixValues(mx.rest, mx.lines)
    mx.ind = -1
    mx.lines = []
  }
  const finish = () => {
    if (!cur) return
    closeStep()
    closeMatrix()
    for (const tpl of st.tpls) for (const d of expandDirs(st.mx, tpl)) push(cur.workingDirs, d)
    const seen = new Set()
    for (const r of st.runs) {
      // A step directory wins; a step that names none has the job default. A matrix expression with no literal value gives no directory.
      const tpl = r.dir !== undefined || r.tpl ? r.tpl : st.jobTpl
      const dirs = tpl ? expandDirs(st.mx, tpl) : [r.dir ?? st.jobDir]
      for (const dir of dirs.length ? dirs : ['']) {
        const key = `${dir}\0${r.script}`
        if (seen.has(key)) continue
        seen.add(key)
        cur.runs.push({ script: r.script, dir })
      }
    }
    // The -f path of docker build is read from the working directory of its step. A directory that only a run knows
    // (an expression, a matrix key with no literal value) gives no Dockerfile: a path from an unknown place would be a wrong edge.
    for (const r of st.dockerRuns) {
      const own = r.dir !== undefined || r.tpl
      const tpl = own ? r.tpl : st.jobTpl
      if ((own ? r.unknown : st.jobUnknown) && !tpl) continue
      const dirs = tpl ? expandDirs(st.mx, tpl) : [r.dir ?? st.jobDir]
      for (const dir of dirs) {
        const p = posix.normalize(dir ? `${dir}/${r.file}` : r.file)
        if (p !== '.' && p !== '..' && !p.startsWith('../') && !p.startsWith('/')) push(cur.dockerfiles, p)
      }
    }
  }

  for (let i = start + 1; i < end; i++) {
    const line = lines[i]
    if (isBlank(line) || isComment(line)) continue
    const ind = indentOf(line)
    const idm = ind === 2 ? /^ {2}(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_][A-Za-z0-9_.-]*)):\s*(?:#.*)?$/.exec(line) : null
    if (idm) {
      finish()
      const id = idm[1] ?? idm[2] ?? idm[3]
      cur = jobs.some((j) => j.id === id) ? null : { id, name: '', line: i + 1, needs: [], dockerfiles: [], scripts: [], runs: [], filters: [], workingDirs: [] }
      st = fresh()
      if (cur) jobs.push(cur)
      continue
    }
    if (!cur) continue

    // The matrix of the job is the `matrix:` key of its `strategy:`, and nothing else. Its lines are kept until it ends,
    // and read then (matrixValues): its keys and values are used for `${{ matrix.<key> }}`.
    if (ind === 4) {
      if (/^ {4}strategy:/.test(line)) { st.strat = true; st.stratChild = -1 } else if (!line.trimStart().startsWith('-')) st.strat = false
    } else if (st.strat && ind > 4 && st.stratChild < 0) st.stratChild = ind
    const mx = st.mx
    if (mx.ind >= 0 && ind <= mx.ind) closeMatrix()
    if (mx.ind >= 0) mx.lines.push({ ind, text: stripComment(line).trim() })
    else if (st.strat && !mx.done && ind === st.stratChild) {
      const mm = /^\s*matrix:\s*(.*)$/.exec(stripComment(line))
      if (mm) { mx.ind = ind; mx.done = true; mx.rest = mm[1].trim() }
    }

    if (ind === 4) {
      // A key of the job ends the list of steps. A `- ` at this indent is a step when the list sits at the indent of its key.
      if (/^ {4}steps:\s*(?:#.*)?$/.test(line)) { closeStep(); st.inSteps = true; st.stepInd = -1 } else if (!line.trimStart().startsWith('-')) { closeStep(); st.inSteps = false }
      const nm = /^ {4}name:\s*(.*)$/.exec(line)
      if (nm) {
        const v = unquote(stripComment(nm[1]))
        cur.name = v.includes('${{') ? '' : v
        continue
      }
      const nd = /^ {4}needs:\s*(.*)$/.exec(line)
      if (nd) {
        let v = stripComment(nd[1])
        if (v.startsWith('[')) {
          // an inline list can continue on the next lines until its closing bracket
          let k = i
          while (!v.includes(']') && k + 1 < end) {
            k++
            if (isBlank(lines[k]) || isComment(lines[k])) continue
            v += ' ' + stripComment(lines[k].trim())
          }
          i = k
          for (const part of v.replace(/^\[/, '').replace(/\].*$/, '').split(',')) push(cur.needs, unquote(part))
        } else if (v) push(cur.needs, unquote(v))
        else {
          for (let k = i + 1; k < end; k++) {
            const l2 = lines[k]
            if (isBlank(l2) || isComment(l2)) continue
            const item = /^\s*-\s+(.*)$/.exec(l2)
            if (!item || indentOf(l2) < 4) break // YAML allows the list at the indent of its key
            push(cur.needs, unquote(stripComment(item[1])))
          }
        }
        continue
      }
    }

    // A step starts at a `- ` at the indent of the first item of the list. A deeper `- ` is a list inside a step.
    if (st.run && ind <= st.run.keyInd) flushRun()
    if (st.inSteps) {
      const sm = /^(\s*)-\s/.exec(line)
      if (sm && (st.stepInd < 0 || sm[1].length === st.stepInd)) {
        closeStep()
        st.stepInd = sm[1].length
        // keyInd: the column of the keys of the step (the first key sits on the line of the dash)
        st.step = { dir: undefined, scripts: [], dockers: [], unknown: false, keyInd: sm[1].length + 1 + indentOf(line.slice(sm[1].length + 1)) }
      }
    }

    const body = stripComment(line)
    // The `run:` of a step: its lines are the only place where a docker build is read. A `run:` is a key of the step itself.
    if (st.run) st.run.lines.push(body)
    else if (st.inSteps && st.step) {
      const rm = /^(\s*)(-\s+)?run:(?:\s+(.*))?$/.exec(body)
      if (rm && rm[1].length + (rm[2] ? rm[2].length : 0) === st.step.keyInd) {
        const v = (rm[3] ?? '').trim()
        const block = /^[|>][+-]?\d*$/.exec(v)
        const quoted = !block && /^"[^"]*"$|^'[^']*'$/.test(v)
        st.run = { keyInd: st.step.keyInd, folded: block ? v[0] === '>' : false, lines: block || !v ? [] : [quoted ? v.slice(1, -1) : v] }
      }
    }
    // A step name or a description is prose: it may say "run node x.mjs" without running anything.
    if (/^\s*(?:-\s+)?(?:name|description):/.test(body)) continue
    for (const m of body.matchAll(/(?:^|[\s,{-])dockerfile:\s*("[^"]*"|'[^']*'|[^\s,}]+)/g)) {
      const v = clean(unquote(m[1]))
      if (v && !hasExpression(v)) push(cur.dockerfiles, v)
    }
    const wd = /^\s*(?:-\s+)?working-directory:\s*(.+)$/.exec(body)
    if (wd) {
      const { dir, tpl, unknown } = dirOfValue(clean(unquote(wd[1])))
      // A value that only an expression knows gives no directory, and it also hides the job default: the step names its own.
      // A matrix expression stands for the literal values of its key in the matrix of the job (they are known at the end of the job).
      if (dir) push(cur.workingDirs, dir)
      if (tpl) st.tpls.push(tpl)
      if (st.inSteps && st.step) { st.step.dir = dir; st.step.tpl = tpl; st.step.unknown = !!unknown }
      else { st.jobDir = dir; st.jobTpl = tpl ?? null; st.jobUnknown = !!unknown }
    }
    for (const m of body.matchAll(/--filter[=\s]\s*("[^"]*"|'[^']*'|\S+)/g)) {
      const v = unquote(m[1]).replace(/^\.{3}/, '').replace(/\.{3}$/, '').replace(/^[!^]+/, '')
      if (v && !hasExpression(v) && !v.startsWith('.') && !v.startsWith('{')) push(cur.filters, v)
    }
    for (const s of scriptsOfLine(body)) {
      push(cur.scripts, s)
      if (st.inSteps && st.step) st.step.scripts.push(s)
      else st.runs.push({ script: s, dir: undefined })
    }
  }
  finish()
  return jobs
}
