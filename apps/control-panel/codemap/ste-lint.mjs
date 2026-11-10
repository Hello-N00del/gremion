#!/usr/bin/env node
// ste-lint.mjs - a RULE CHECK for ste-text.json. It is NOT a certified ASD-STE100 checker.
// It does not hold the STE dictionary, so it cannot test approved words, noun clusters,
// article use, or whether a sentence has one topic. It tests a fixed list of mechanical rules.
//
// Rules:
//   LEN-D   descriptive sentence longer than 25 words
//   LEN-I   instruction sentence (howToRead) longer than 20 words
//   PARA    paragraph with more than 6 sentences
//   ING     word that ends in -ing (verb forms are banned; no noun exceptions)
//   PASSIVE form of "be" followed by a past participle
//   PERFECT "has/have/had" followed by a past participle
//   MODAL   would, could, should, might, may
//   PHRASAL common phrasal verb (verb + particle)
//   CONTRACT contraction or possessive 's
//   PUNCT   semicolon, parenthesis, slash in prose, or a colon inside a sentence
//   LATIN   e.g., i.e., etc., via, vs
//   COMMAS  more than 4 commas in one sentence (probably more than one topic)
//   NAME    capitalised word inside a sentence that is not in the glossary
//   TOKEN   code-like token (underscore, camelCase, dot-name) that is not in the glossary
//   COVER   area in graph.json with no text, or text for an unknown area
//   NODE    walkthrough step that matches no node: a { file, function } pair with no function node of that
//           file and name, or a nodeId that does not exist. A function step never holds a line number.
//   SHAPE   missing field, too few glossary terms, wrong number of walkthroughs, a step with no code reference
//
// Usage: node ste-lint.mjs [ste-text.json] [graph.json]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const textPath = process.argv[2] || path.join(here, 'ste-text.json')
const graphPath = process.argv[3] || path.join(here, 'graph.json')
const text = JSON.parse(fs.readFileSync(textPath, 'utf8'))
const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'))

const findings = []
const stats = { sentences: 0, words: 0, strings: 0, maxWords: 0 }
const add = (where, rule, msg, sentence) => findings.push({ where, rule, msg, sentence })

const glossaryKeys = new Set(Object.keys(text.glossary || {}).map((k) => k.toLowerCase()))
const glossaryWords = new Set()
for (const k of glossaryKeys) for (const w of k.split(/[\s]+/)) glossaryWords.add(w)

const PASS_IRREG = 'made|done|built|run|set|put|read|found|sent|kept|held|shown|known|given|taken|seen|written|stored|chosen|begun|broken|brought|bought|caught|drawn|driven|eaten|fallen|forgotten|gone|grown|hidden|lost|paid|said|sold|spoken|stolen|thrown|worn|won|left|let|cut|hit|shut'
const PASS_ADJ = new Set(['closed', 'open', 'based', 'red', 'need', 'seed', 'speed', 'embed', 'feed', 'bed', 'hundred', 'shared'])
const PASSIVE = new RegExp(`\\b(am|is|are|was|were|be|been|being)\\s+(?:not\\s+)?(?:\\w+ly\\s+)?(\\w+ed|${PASS_IRREG})\\b`, 'gi')
const PERFECT = new RegExp(`\\b(has|have|had)\\s+(?:not\\s+)?(?:\\w+ly\\s+)?(\\w+ed|${PASS_IRREG})\\b`, 'gi')
const MODAL = /\b(would|could|should|might|may)\b/gi
// "in", "on", "out", "up" etc. after these verbs are normal prepositions in many sentences.
// Only these pairs are phrasal verbs that STE avoids; everything else is left to a human.
const PHRASAL_PAIRS = /\b(set(s)?\s+up|turn(s|ed)?\s+(on|off|up|down|over|out)|log(s|ged)?\s+(in|out|on|off)|sign(s|ed)?\s+(in|out|up)|switch(es|ed)?\s+(on|off|over)|point(s|ed)?\s+out|carr(y|ies|ied)\s+out|find(s)?\s+out|look(s|ed)?\s+(up|out|over)|come(s)?\s+(back|up|out|in)|give(s)?\s+(up|away|out|back)|pick(s|ed)?\s+(up|out)|fill(s|ed)?\s+(in|out|up)|hand(s|ed)?\s+(over|in|out)|send(s)?\s+(out|back|in)|start(s|ed)?\s+(up|over)|shut(s)?\s+(down|off|up)|break(s)?\s+(down|up|in)|clean(s|ed)?\s+up|click(s|ed)?\s+on|depend(s|ed)?\s+on|rel(y|ies|ied)\s+on|bring(s)?\s+(up|back|in|out)|take(s)?\s+(over|out|off|back|up)|put(s)?\s+(away|back|off|on|up|out)|wipe(s|d)?\s+out|roll(s|ed)?\s+(back|out|over)|wrap(s|ped)?\s+up|pull(s|ed)?\s+(out|in|up|down)|go(es)?\s+(on|off|out|up|down|back)|get(s)?\s+(back|up|out|off|on|in|over|through)|pass(es|ed)?\s+(on|out|over)|keep(s)?\s+(on|up|out)|hold(s)?\s+(on|up|back|out)|cut(s)?\s+(off|out|down)|run(s)?\s+(out|off|down|over)|work(s|ed)?\s+out|show(s|ed)?\s+(up|off)|drop(s|ped)?\s+(off|out)|let(s)?\s+(go|out|in)|wake(s)?\s+up|use(s|d)?\s+up|print(s|ed)?\s+out|check(s|ed)?\s+(in|out)|read(s)?\s+(out|in|through)|write(s)?\s+(down|out|up))\b/gi
const CONTRACT = /\b\w+'(s|t|re|ve|ll|d|m)\b/gi
const LATIN = /\b(e\.g\.|i\.e\.|etc\.?|via|vs\.?|ie|eg)\b/gi
const ING_OK = new Set([])

const ACRONYM_OK = /^(L[0-5]|[A-Z]|[A-Z]{2,8})$/
const LANGUAGE_NAMES = new Set(['German', 'English'])

function words(s) {
  return s.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t))
}
function sentencesOf(para) {
  // Split after . ! ? when the next char starts a new sentence. A dot inside a name such as Auth.js stays.
  return para.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/).map((s) => s.trim()).filter(Boolean)
}

function checkSentence(where, sentence, limit, isTitle) {
  const w = words(sentence)
  stats.sentences++
  stats.words += w.length
  stats.maxWords = Math.max(stats.maxWords, w.length)
  if (!isTitle && w.length > limit) add(where, limit === 20 ? 'LEN-I' : 'LEN-D', `${w.length} words (limit ${limit})`, sentence)
  for (const m of sentence.matchAll(/\b([A-Za-z]{2,})ing\b/g)) {
    const word = m[0].toLowerCase()
    // A technical name is allowed when the glossary defines it (STE allows defined technical names).
    if (!ING_OK.has(word) && !glossaryWords.has(word)) add(where, 'ING', `"${m[0]}" ends in -ing`, sentence)
  }
  if (!isTitle) {
    for (const m of sentence.matchAll(PASSIVE)) {
      if (!PASS_ADJ.has(m[2].toLowerCase())) add(where, 'PASSIVE', `"${m[0]}" looks passive`, sentence)
    }
    for (const m of sentence.matchAll(PERFECT)) add(where, 'PERFECT', `"${m[0]}" is a perfect tense`, sentence)
    for (const m of sentence.matchAll(MODAL)) add(where, 'MODAL', `"${m[0]}" is not an STE modal`, sentence)
    for (const m of sentence.matchAll(PHRASAL_PAIRS)) add(where, 'PHRASAL', `"${m[0]}" looks like a phrasal verb`, sentence)
    for (const m of sentence.matchAll(CONTRACT)) add(where, 'CONTRACT', `"${m[0]}" contraction or possessive`, sentence)
    for (const m of sentence.matchAll(LATIN)) add(where, 'LATIN', `"${m[0]}" is not allowed`, sentence)
    if (/[;()]/.test(sentence)) add(where, 'PUNCT', 'semicolon or parenthesis', sentence)
    if (/:/.test(sentence.replace(/[.!?]$/, ''))) add(where, 'PUNCT', 'colon inside a sentence', sentence)
    const commas = (sentence.match(/,/g) || []).length
    if (commas > 4) add(where, 'COMMAS', `${commas} commas: maybe more than one topic`, sentence)
    // Proper names and code-like tokens must be in the glossary.
    const toks = sentence.split(/\s+/)
    toks.forEach((raw, idx) => {
      const t = raw.replace(/^[^A-Za-z0-9@/._-]+/, '').replace(/[^A-Za-z0-9]+$/, '')
      if (!t) return
      const low = t.toLowerCase()
      const inGloss = glossaryKeys.has(low) || glossaryWords.has(low)
      if (/[_]|[a-z][A-Z]/.test(t) || (/\.[a-z]/.test(t) && /[A-Za-z]\.[A-Za-z]/.test(t)) || /\//.test(t)) {
        if (!inGloss && !glossaryKeys.has(t.replace(/\.$/, '').toLowerCase())) add(where, 'TOKEN', `"${t}" looks like a code name`, sentence)
        return
      }
      if (idx > 0 && /^[A-Z]/.test(t) && !ACRONYM_OK.test(t) && !inGloss && !LANGUAGE_NAMES.has(t)) {
        const prev = toks[idx - 1]
        if (!/[.!?]$/.test(prev)) add(where, 'NAME', `"${t}" is a name that the glossary does not define`, sentence)
      }
      if (idx === 0 && /^[A-Z]{3,}$/.test(t) && !inGloss) add(where, 'NAME', `"${t}" is a name that the glossary does not define`, sentence)
    })
  }
}

function checkParagraph(where, para, limit, isTitle = false) {
  if (typeof para !== 'string' || !para.trim()) return add(where, 'SHAPE', 'empty or not a string', String(para))
  stats.strings++
  const ss = sentencesOf(para)
  if (!isTitle && ss.length > 6) add(where, 'PARA', `${ss.length} sentences in one paragraph (limit 6)`, para.slice(0, 80))
  for (const s of ss) checkSentence(where, s, limit, isTitle)
}

// ---- shape ----
for (const k of ['intro', 'howToRead', 'layers', 'areas', 'glossary', 'walkthroughs']) if (!(k in text)) add(k, 'SHAPE', 'missing top-level field', '')

;(text.intro || []).forEach((p, i) => checkParagraph(`intro[${i}]`, p, 25))
;(text.howToRead || []).forEach((p, i) => checkParagraph(`howToRead[${i}]`, p, 20))
for (const L of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) {
  const l = text.layers?.[L]
  if (!l) { add(`layers.${L}`, 'SHAPE', 'missing layer', ''); continue }
  checkParagraph(`layers.${L}.title`, l.title, 25, true)
  checkParagraph(`layers.${L}.text`, l.text, 25)
}

// ---- areas ----
const areaIds = new Set(graph.nodes.filter((n) => n.kind === 'area').map((n) => n.id))
for (const id of areaIds) if (!text.areas?.[id]) add(`areas`, 'COVER', `no text for ${id}`, '')
for (const id of Object.keys(text.areas || {})) {
  if (!areaIds.has(id)) { add(`areas`, 'COVER', `text for unknown area ${id}`, ''); continue }
  const a = text.areas[id]
  checkParagraph(`areas.${id}.title`, a.title, 25, true)
  for (const f of ['what', 'why', 'leadsTo']) checkParagraph(`areas.${id}.${f}`, a[f], 25)
}

// ---- glossary ----
const gl = text.glossary || {}
if (Object.keys(gl).length < 40) add('glossary', 'SHAPE', `only ${Object.keys(gl).length} terms (need 40)`, '')
for (const [k, v] of Object.entries(gl)) checkParagraph(`glossary.${k}`, v, 25)
const needed = ['server', 'container', 'database', 'table', 'function', 'kernel', 'vertical', 'tenant', 'module', 'route', 'page', 'token']
for (const k of needed) if (!glossaryKeys.has(k)) add('glossary', 'SHAPE', `required term missing: ${k}`, '')

// ---- walkthroughs ----
const nodeIds = new Set(graph.nodes.map((n) => n.id))
const fnKeys = new Set(graph.nodes.filter((n) => n.kind === 'function').map((n) => n.file + '#' + n.name))
const wts = text.walkthroughs || []
if (wts.length !== 6) add('walkthroughs', 'SHAPE', `${wts.length} walkthroughs (need 6)`, '')
let stepCount = 0
wts.forEach((w, i) => {
  checkParagraph(`walkthroughs[${i}].title`, w.title, 25, true)
  if (!Array.isArray(w.steps) || w.steps.length < 5) add(`walkthroughs[${i}]`, 'SHAPE', 'fewer than 5 steps', '')
  ;(w.steps || []).forEach((s, j) => {
    stepCount++
    checkParagraph(`walkthroughs[${i}].steps[${j}].text`, s.text, 25)
    const at = `walkthroughs[${i}].steps[${j}]`
    if (typeof s.file === 'string' && typeof s.function === 'string') {
      if (!fnKeys.has(s.file + '#' + s.function)) add(at, 'NODE', `no function ${s.function} in ${s.file} in graph.json`, '')
    } else if (typeof s.nodeId === 'string') {
      if (s.nodeId.startsWith('fn:')) add(at, 'SHAPE', 'a function step must use file and function, not a nodeId with a line number', '')
      else if (!nodeIds.has(s.nodeId)) add(at, 'NODE', `nodeId not in graph.json: ${s.nodeId}`, '')
    } else add(at, 'SHAPE', 'step has neither file and function nor nodeId', '')
  })
})

// ---- report ----
const byRule = {}
for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1
const shown = Number(process.env.STE_SHOW || 400)
for (const f of findings.slice(0, shown)) console.log(`${f.rule}\t${f.where}\t${f.msg}${f.sentence ? '\n\t> ' + f.sentence.slice(0, 160) : ''}`)
if (findings.length > shown) console.log(`... ${findings.length - shown} more findings not shown (set STE_SHOW)`)
console.log('---')
console.log(`checked: ${stats.strings} text fields, ${stats.sentences} sentences, ${stats.words} words, longest sentence ${stats.maxWords} words`)
console.log(`areas: ${Object.keys(text.areas || {}).length} of ${areaIds.size}; glossary terms: ${Object.keys(gl).length}; walkthroughs: ${wts.length}; steps: ${stepCount}`)
console.log(`findings: ${findings.length}${findings.length ? ' ' + JSON.stringify(byRule) : ''}`)
console.log('NOTE: this is a rule check, not a certified ASD-STE100 checker. It cannot test the approved dictionary, articles or one topic for each sentence.')
console.log(findings.length ? 'RESULT: FAIL' : 'RESULT: PASS')
process.exit(findings.length ? 1 : 0)
