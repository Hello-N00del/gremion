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
//   dockerfiles  every `dockerfile:` value in the job, also in an inline matrix map such as `{ name: x, dockerfile: a/Dockerfile }`
//   scripts      repo scripts that `node`, `node --test`, `bash` or `sh` run (a test file is skipped)
//   runs         the same scripts, each paired with the working directory of its own step: { script, dir }
//                (dir is the `working-directory:` of the step, else the job default under `defaults:`, else '')
//   filters      the package names of `pnpm --filter <name>`
//   workingDirs  `working-directory:` values
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
  const fresh = () => ({ inSteps: false, stepInd: -1, step: null, jobDir: '', runs: [] })
  const closeStep = () => {
    if (!st.step) return
    for (const script of st.step.scripts) st.runs.push({ script, dir: st.step.dir })
    st.step = null
  }
  const finish = () => {
    if (!cur) return
    closeStep()
    const seen = new Set()
    for (const r of st.runs) {
      const dir = r.dir ?? st.jobDir
      const key = `${dir}\0${r.script}`
      if (seen.has(key)) continue
      seen.add(key)
      cur.runs.push({ script: r.script, dir })
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
    for (const m of body.matchAll(/(?:^|[\s,{-])dockerfile:\s*("[^"]*"|'[^']*'|[^\s,}]+)/g)) {
      const v = clean(unquote(m[1]))
      if (v && !hasExpression(v)) push(cur.dockerfiles, v)
    }
    const wd = /^\s*(?:-\s+)?working-directory:\s*(.+)$/.exec(body)
    if (wd) {
      const v = clean(unquote(wd[1]))
      // A value that only an expression knows gives no directory, and it also hides the job default: the step names its own.
      const dir = !v || v === '.' || hasExpression(v) ? '' : v
      if (dir) push(cur.workingDirs, dir)
      if (st.inSteps && st.step) st.step.dir = dir
      else st.jobDir = dir
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
