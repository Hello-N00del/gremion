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
//                and the literal path of `-f` or `--file` in a `docker build` or `docker buildx build` command
//   scripts      repo scripts that `node`, `node --test`, `bash` or `sh` run (a test file is skipped)
//   runs         the same scripts, each paired with the working directory of its own step: { script, dir }
//                (dir is the `working-directory:` of the step, else the job default under `defaults:`, else '')
//   filters      the package names of `pnpm --filter <name>`
//   workingDirs  `working-directory:` values; `${{ matrix.<key> }}` stands for every literal value of `<key>` in the matrix of the job
// A value that holds an expression (`${{`) or a shell variable is never taken: the scanner cannot know its value.

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
const SCRIPT_PATH = /^[A-Za-z0-9_@.\/-]+\.(?:mjs|cjs|js|mts|cts|ts|sh)$/
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
const DOCKER_BUILD = /(?:^|[\s;&|(`'"])docker\s+(?:buildx\s+)?build(?=\s|$)/g
const FILE_PATH = /^[A-Za-z0-9_@.\/-]+$/
/** Reads the -f / --file values of the words of one docker command into `out`. Returns false when a separator ends the command. */
function dockerFilesOfTokens(tokens, out) {
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]
    if (SEPARATORS.has(raw) || raw.startsWith('#')) return false
    let v
    if (raw === '-f' || raw === '--file') v = tokens[++i]
    else { const m = /^(?:-f|--file)=(.*)$/.exec(raw); if (m) v = m[1] }
    if (v === undefined) continue
    const t = clean(unquote(v.replace(/[;)&|]+$/, '')))
    if (t && t !== '-' && FILE_PATH.test(t) && !t.startsWith('/') && !t.startsWith('../')) out.push(t)
  }
  return true
}
/** The Dockerfiles that one line builds. `continued` says that the line goes on a command of the line before (a backslash). */
function dockerfilesOfLine(line, continued) {
  const out = []
  let open = false
  if (continued) open = dockerFilesOfTokens(line.split(/\s+/).filter(Boolean), out)
  DOCKER_BUILD.lastIndex = 0
  let m
  let last = -1
  while ((m = DOCKER_BUILD.exec(line))) {
    last = m.index + m[0].length
    open = dockerFilesOfTokens(line.slice(last).split(/\s+/).filter(Boolean), out)
  }
  return { files: out, continues: open && /\\s*$/.test(line) }
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
  return { dir: hasExpression(v) ? '' : v }
}
const KEY_VALUE = /(?:^|[\s,{[])([A-Za-z0-9_-]+):(?:\s+|$)("[^"]*"|'[^']*'|\[[^\]{}:]*\]|[^\s,}\]]+)?/g
const addValue = (mx, key, raw) => {
  const v = unquote(raw).trim()
  if (!v) return
  if (!mx.vals.has(key)) mx.vals.set(key, [])
  mx.vals.get(key).push(v)
}
/** Takes the keys and values of one line of the matrix of a job. */
function collectMatrixLine(mx, text, ind) {
  const trimmed = text.trim()
  if (mx.listKey !== null) {
    const item = /^-\s+(.*)$/.exec(trimmed)
    if (item && ind >= mx.listInd && !/:(?:\s|$)/.test(item[1])) { addValue(mx, mx.listKey, item[1]); return }
    mx.listKey = null
  }
  KEY_VALUE.lastIndex = 0
  for (const m of text.matchAll(KEY_VALUE)) {
    const key = m[1], val = m[2]
    if (val === undefined) { if (m.index + m[0].length >= text.trimEnd().length) { mx.listKey = key; mx.listInd = ind } continue }
    if (val.startsWith('[') && val.endsWith(']') && val.length > 1) for (const part of val.slice(1, -1).split(',')) addValue(mx, key, part)
    else addValue(mx, key, val)
  }
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
  const fresh = () => ({ inSteps: false, stepInd: -1, step: null, jobDir: '', jobTpl: null, tpls: [], dockerCont: false, runs: [], mx: { ind: -1, excl: -1, listKey: null, listInd: 0, vals: new Map() } })
  const closeStep = () => {
    if (!st.step) return
    for (const script of st.step.scripts) st.runs.push({ script, dir: st.step.dir, tpl: st.step.tpl })
    st.step = null
  }
  const finish = () => {
    if (!cur) return
    closeStep()
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

    // The matrix of the job: its keys and values, read for `${{ matrix.<key> }}`. `exclude:` entries are not values that run.
    const mx = st.mx
    if (mx.ind >= 0 && ind <= mx.ind) { mx.ind = -1; mx.excl = -1; mx.listKey = null }
    if (mx.excl >= 0 && ind <= mx.excl) mx.excl = -1
    if (mx.ind < 0 && ind > 4) {
      const mm = /^\s*matrix:\s*(.*)$/.exec(stripComment(line))
      if (mm) { mx.ind = ind; collectMatrixLine(mx, mm[1], ind + 2) }
    } else if (mx.ind >= 0 && mx.excl < 0) {
      const text = stripComment(line)
      if (/^\s*exclude:/.test(text)) mx.excl = ind
      else collectMatrixLine(mx, text, ind)
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
    if (st.inSteps) {
      const sm = /^(\s*)-\s/.exec(line)
      if (sm && (st.stepInd < 0 || sm[1].length === st.stepInd)) {
        closeStep()
        st.stepInd = sm[1].length
        st.step = { dir: undefined, scripts: [] }
      }
    }

    const body = stripComment(line)
    // A step name or a description is prose: it may say "run node x.mjs" without running anything.
    if (/^\s*(?:-\s+)?(?:name|description):/.test(body)) continue
    {
      const d = dockerfilesOfLine(body, st.dockerCont)
      st.dockerCont = d.continues
      for (const f of d.files) push(cur.dockerfiles, f)
    }
    for (const m of body.matchAll(/(?:^|[\s,{-])dockerfile:\s*("[^"]*"|'[^']*'|[^\s,}]+)/g)) {
      const v = clean(unquote(m[1]))
      if (v && !hasExpression(v)) push(cur.dockerfiles, v)
    }
    const wd = /^\s*(?:-\s+)?working-directory:\s*(.+)$/.exec(body)
    if (wd) {
      const { dir, tpl } = dirOfValue(clean(unquote(wd[1])))
      // A value that only an expression knows gives no directory, and it also hides the job default: the step names its own.
      // A matrix expression stands for the literal values of its key in the matrix of the job (they are known at the end of the job).
      if (dir) push(cur.workingDirs, dir)
      if (tpl) st.tpls.push(tpl)
      if (st.inSteps && st.step) { st.step.dir = dir; st.step.tpl = tpl }
      else { st.jobDir = dir; st.jobTpl = tpl ?? null }
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
