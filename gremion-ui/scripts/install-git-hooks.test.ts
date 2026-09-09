// gremion-ui/scripts/install-git-hooks.test.ts
// Guard for the pre-commit boundary lint.
//
// The defect class this file exists to prevent: a hook that is present,
// executable, and enforces nothing. It has two shapes, and the kernel base
// carried both:
//
//   1. the WRAPPER `install-git-hooks.mjs` generates wraps its delegation in
//      `if [ -f … ]; then … fi`, so a worktree without the versioned hook
//      falls through SILENTLY and commits unguarded;
//   2. the versioned delegate `scripts/hooks/pre-commit` `exit 0`s whenever it
//      cannot run — no repo root, no lint script, and (the common one) no
//      `gremion-ui/node_modules`, i.e. in every fresh agent worktree.
//
// Both are replaced by fail-closed branches that block the commit with an
// instruction; `git commit --no-verify` remains the single VISIBLE bypass.
//
// The installer's own post-condition is the third half of the same problem:
//
//     the directory written == `git rev-parse --git-path hooks`
//
// A hook outside that directory is installed-looking and enforcing nothing, so
// the installer asks git the one question it alone can answer and REFUSES when
// the answer disagrees.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Established pattern: a test imports a scripts/*.mjs module directly
// (precedent: src/lib/server/boundary/install-git-hooks.test.ts).
import { installHooks, MARKER_BEGIN, MARKER_END } from './install-git-hooks.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const gremionUiRoot = join(scriptsDir, '..')
const repoRoot = join(gremionUiRoot, '..')
const versionedHook = join(scriptsDir, 'hooks/pre-commit')
const installerCli = join(scriptsDir, 'install-git-hooks.mjs')
const isWindows = process.platform === 'win32'

/** A foreign hook of the shape that makes appending fatal: it ends in `exit 0`,
 *  so anything appended after it is unreachable. husky's classic shim and most
 *  hand-written hooks look like this. */
const FOREIGN_HOOK = '#!/bin/sh\necho "[foreign] ok"\nexit 0\n'

/** The kernel's PRE-FIX managed block (f2d7751), verbatim — kept ONLY as a
 *  negative control. Its `[ -f … ]; then … fi` shape is the fall-through: a
 *  worktree without the delegate commits unguarded and nothing says so. */
const DEAD_TOLERANT_BLOCK = [
  MARKER_BEGIN,
  '# Managed by gremion-ui/scripts/install-git-hooks.mjs — do not edit between markers.',
  'if GREMION_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -f "$GREMION_ROOT/gremion-ui/scripts/hooks/pre-commit" ]; then',
  '  sh "$GREMION_ROOT/gremion-ui/scripts/hooks/pre-commit" "$@" || exit $?',
  'fi',
  MARKER_END,
].join('\n')

/** Pull the repo-relative hook path the managed block delegates to. The
 *  fail-closed form is `[ ! -f … ]`; the `!` is asserted separately so a revert
 *  to the fall-through `[ -f … ]` cannot pass this file. */
function referencedHookPath(hookText: string): string {
  const m = /\[ (?:! )?-f "\$GREMION_ROOT\/([^"]+)" \]/.exec(hookText)
  if (!m) throw new Error(`managed block has no [ -f "$GREMION_ROOT/…" ] guard:\n${hookText}`)
  return m[1]
}

/**
 * Lines that would let a hook skip silently. Anchoring on a closed list of
 * separators (`^`, `||`, `;`, `&&`, `then`) still misses `else exit 0`, a
 * `*) exit 0 ;;` case arm and `exit  0` with two spaces — all realistic
 * reintroductions of the same defect. Match the STATEMENT instead of
 * enumerating what may precede it: the hardened hook and the generated wrapper
 * use only `exit 1` and `exit $status`, so nothing legitimate trips it.
 */
function bareExitZeroLines(text: string): { line: number; text: string }[] {
  return text
    .split('\n')
    .map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter(({ text: t }) => !t.startsWith('#') && /\bexit\s+0\b/.test(t))
}

/** Number of files `boundary-lint.ts` reported checking, or null if the run
 *  never got as far as printing its OK line. `0 file(s) checked` is a PASSING
 *  lint that inspected nothing — the canonical vacuous green. */
function lintFilesChecked(output: string): number | null {
  const m = /\[boundary-lint\] OK \((\d+) file\(s\) checked/.exec(output)
  return m ? Number(m[1]) : null
}

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}

/**
 * Remove the node_modules link a throwaway repo may carry — and ONLY if it
 * really is a link. `rmSync(recursive)` on a directory junction would walk into
 * the REAL gremion-ui/node_modules and delete this checkout's dependencies, so
 * the type is verified first and anything unexpected throws instead of being
 * swallowed.
 *
 * Portability: on win32 a junction is a DIRECTORY reparse point and is removed
 * with rmdir; on POSIX rmdir(2) against a symlink returns ENOTDIR, so the link
 * must be removed with unlink(2).
 */
function unlinkJunction(link: string): void {
  let stats: Stats
  try {
    stats = lstatSync(link)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  if (!stats.isSymbolicLink()) {
    throw new Error(
      `refusing to remove ${link}: expected a symlink/junction, found a real ${stats.isDirectory() ? 'directory' : 'file'}`,
    )
  }
  try {
    if (isWindows) rmdirSync(link)
    else unlinkSync(link)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
}

afterEach(() => {
  const failures: unknown[] = []
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!
    try {
      unlinkJunction(join(d, 'gremion-ui/node_modules'))
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch (err) {
      failures.push(new Error(`temp-dir cleanup failed for ${d}`, { cause: err }))
    }
  }
  // Every dir gets an attempt, then the first real failure surfaces — a
  // swallowed cleanup error is how a destructive rm would go unnoticed.
  if (failures.length > 0) throw failures[0]
})

type RepoOpts = { nodeModules?: boolean; lint?: boolean; versionedHook?: boolean }

/**
 * A throwaway git repo carrying the pieces the hook actually needs: the
 * versioned hook, the lint entrypoint + its engine, and gremion-ui's
 * node_modules (a junction — no install). Nothing here touches this checkout.
 */
function throwawayRepo(
  { nodeModules = true, lint = true, versionedHook: withHook = true }: RepoOpts = {},
): string {
  const repo = tempDir('kmirror-repo-')
  mkdirSync(join(repo, 'gremion-ui/scripts/hooks'), { recursive: true })
  mkdirSync(join(repo, 'gremion-ui/src/lib/server'), { recursive: true })
  vcs(repo, ['init', '-q', '.'])
  vcs(repo, ['config', 'user.email', 'kmirror@example.invalid'])
  vcs(repo, ['config', 'user.name', 'KMIRROR Guard'])
  cpSync(join(gremionUiRoot, 'package.json'), join(repo, 'gremion-ui/package.json'))
  if (withHook) cpSync(versionedHook, join(repo, 'gremion-ui/scripts/hooks/pre-commit'))
  cpSync(join(scriptsDir, 'contracts-gate.ts'), join(repo, 'gremion-ui/scripts/contracts-gate.ts'))
  cpSync(
    join(gremionUiRoot, 'src/lib/server/boundary'),
    join(repo, 'gremion-ui/src/lib/server/boundary'),
    { recursive: true },
  )
  if (lint) {
    cpSync(join(scriptsDir, 'boundary-lint.ts'), join(repo, 'gremion-ui/scripts/boundary-lint.ts'))
  }
  if (nodeModules) {
    symlinkSync(
      join(gremionUiRoot, 'node_modules'),
      join(repo, 'gremion-ui/node_modules'),
      'junction',
    )
  }
  return repo
}

/**
 * Test-harness artifact, not a hook defect: running this suite THROUGH
 * `pnpm exec` prepends pnpm's own `.tools/@pnpm+exe/<v>/bin` to PATH, and the
 * POSIX `pnpm` file in there is not executable by the `sh` git runs hooks
 * under ("pnpm: line 1: This: command not found"). A developer committing from
 * a normal shell never has that entry. Drop it so the hook resolves the same
 * pnpm a real commit would. Split on path.delimiter, not a hard-coded ';' —
 * the hard-coded form silently no-ops on POSIX, where PATH is ':'-separated.
 */
function hookEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const cleaned = (process.env[key] ?? '')
    .split(delimiter)
    .filter((p) => !/[\\/]\.tools[\\/]@pnpm\+exe[\\/]/i.test(p))
    .join(delimiter)
  return { ...process.env, [key]: cleaned, ...extra }
}

function vcs(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', env: hookEnv(extraEnv) })
}

function runInstallerCli(cwd: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [installerCli, ...args], {
    cwd,
    encoding: 'utf8',
    env: hookEnv(extraEnv),
  })
}

/** git wants forward slashes in config values on Windows. */
const posix = (p: string) => p.split('\\').join('/')

/**
 * Compare two paths the way the filesystem does. On Windows `mkdtempSync`
 * hands back an 8.3 SHORT path (`C:\Users\RUNNER~1\…`) while a child process's
 * own `process.cwd()` reports the LONG one, so a raw string compare between
 * "what the test asked for" and "what the installer resolved" is a false
 * negative. realpath collapses both, and the case fold matches NTFS.
 */
function normPath(p: string): string {
  let n = resolve(p)
  try {
    n = realpathSync.native(n)
  } catch {
    // The directory may not exist yet — fall back to the lexical form.
  }
  n = n.split('\\').join('/').replace(/\/+$/, '')
  return isWindows ? n.toLowerCase() : n
}

/** The directory git will actually read hooks from in `cwd`. This — not the
 *  common dir, not core.hooksPath, not `--hooks-dir` — is the one question
 *  that decides whether an installed hook ever runs. */
function hooksPathOf(cwd: string, extraEnv: NodeJS.ProcessEnv = {}): string {
  const r = vcs(cwd, ['rev-parse', '--git-path', 'hooks'], extraEnv)
  expect(r.status, `git rev-parse --git-path hooks failed: ${r.stderr}`).toBe(0)
  return resolve(cwd, r.stdout.trim())
}

/** The path the installer reported writing, or null when it claimed no install. */
function reportedHookPath(stdout: string): string | null {
  const m = /\[install-git-hooks\] (?:created|updated|prepended|re-prepended): (.+)/.exec(stdout)
  return m ? m[1].trim() : null
}

/**
 * THE post-condition: after any successful install, the directory the
 * installer wrote into equals `git rev-parse --git-path hooks` as evaluated in
 * `cwd`. Chasing one way of getting this wrong at a time (relative hooksPath
 * resolved against the cwd, `~` taken literally, a global value obeyed by git
 * but not by the installer, `--hooks-dir` anywhere at all) closes instances;
 * asserting the post-condition closes the class.
 */
function expectWrittenDirIsHooksPath(
  cwd: string,
  r: { stdout: string; stderr: string },
  extraEnv: NodeJS.ProcessEnv = {},
): void {
  const reported = reportedHookPath(r.stdout)
  expect(reported, `no install line in:\n${r.stdout}${r.stderr}`).not.toBeNull()
  expect(
    normPath(dirname(reported!)),
    'the installed hook is not in the directory git reads hooks from — installed-looking, enforcing nothing',
  ).toBe(normPath(hooksPathOf(cwd, extraEnv)))
}

const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')

type Staged = { relPath: string; content: string; message: string }

/** Stage `file` and attempt a commit with `hooksDir` as core.hooksPath. */
function commitWith(repo: string, hooksDir: string, file: Staged) {
  writeFileSync(join(repo, file.relPath), file.content)
  const add = vcs(repo, ['add', file.relPath])
  expect(add.status, add.stderr).toBe(0)
  const commit = vcs(repo, [
    '-c', `core.hooksPath=${posix(hooksDir)}`,
    'commit', '-m', file.message,
  ])
  const log = vcs(repo, ['log', '--oneline'])
  return { commit, logOut: log.status === 0 ? log.stdout : '', output: commit.stdout + commit.stderr }
}

/**
 * Write raw hook TEXT into a throwaway hooks dir — used only for the recorded
 * RED (the pre-fix tolerant block, which no installer produces any more).
 * mode 0o755 + an explicit chmod: `writeFileSync` without a mode yields 0644
 * under a normal umask, and git SILENTLY IGNORES a non-executable hook, so on
 * POSIX every assertion below would be measuring "git never ran the hook".
 */
function hooksDirWithText(hookText: string): string {
  const hooksDir = tempDir('kmirror-hooks-')
  const p = join(hooksDir, 'pre-commit')
  writeFileSync(p, `#!/bin/sh\n${hookText}\n`, { mode: 0o755 })
  chmodSync(p, 0o755)
  return hooksDir
}

/** Run the REAL installer into a throwaway hooks dir (optionally pre-seeded
 *  with a foreign hook) and return that dir — the e2e cases then execute the
 *  exact bytes and permissions `installHooks` ships. */
function installedHooksDir(seed?: string): string {
  const d = tempDir('kmirror-install-')
  if (seed !== undefined) writeFileSync(join(d, 'pre-commit'), seed, { mode: 0o755 })
  installHooks({ hooksDir: d, gremionUiRoot })
  return d
}

function installedWrapper(): string {
  return readFileSync(join(installedHooksDir(), 'pre-commit'), 'utf8')
}

/** A staged file that violates `no-deep-import-into-newsletter`. */
const VIOLATION: Staged = {
  relPath: 'gremion-ui/src/lib/server/boundary/kmirror-violation-probe.ts',
  content: "import { thing } from '$lib/server/newsletter/thing'\nexport const probe = thing\n",
  message: 'kmirror boundary violation probe',
}

/** A staged file that breaks no boundary rule. */
const CLEAN: Staged = {
  relPath: 'gremion-ui/src/lib/server/boundary/kmirror-clean-probe.ts',
  content: 'export const probe = 1\n',
  message: 'kmirror clean probe',
}

describe('installHooks template', () => {
  it('delegates to a hook path that EXISTS in this checkout', () => {
    const hooksDir = tempDir('kmirror-hooks-')
    const { hookPath } = installHooks({ hooksDir, gremionUiRoot })
    const text = readFileSync(hookPath, 'utf8')
    const referenced = referencedHookPath(text)
    expect(referenced).toBe('gremion-ui/scripts/hooks/pre-commit')
    expect(
      existsSync(join(repoRoot, referenced)),
      `installer delegates to ${referenced}, which does not exist — the hook would silently enforce nothing`,
    ).toBe(true)
    // The `!` is the fail-closed sense. Without asserting it, a revert to the
    // base `[ -f … ]; then … fi` fall-through still passes this test.
    expect(text, 'the delegate guard must be the fail-closed `[ ! -f … ]` form').toContain(
      '[ ! -f "$GREMION_ROOT/gremion-ui/scripts/hooks/pre-commit" ]',
    )
  })

  it('negative control: the kernel PRE-FIX template fails that same check', () => {
    // Proves the assertion above discriminates rather than passing vacuously.
    // The base template names the same (existing) delegate, so path existence
    // cannot tell them apart — the fail-closed SENSE is what does.
    expect(referencedHookPath(DEAD_TOLERANT_BLOCK)).toBe('gremion-ui/scripts/hooks/pre-commit')
    expect(
      DEAD_TOLERANT_BLOCK,
      'the pre-fix template is the tolerant form — it must NOT satisfy the fail-closed assertion',
    ).not.toContain('[ ! -f "$GREMION_ROOT/gremion-ui/scripts/hooks/pre-commit" ]')
  })

  it('PREPENDS the managed block to a foreign hook so it always runs first', () => {
    // Appending puts the block behind the foreign hook's own `exit 0` — dead
    // code that the installer nevertheless reports as installed. That is the
    // silent-skip defect verbatim, arriving through a supported install path.
    const dir = tempDir('kmirror-foreign-')
    const p = join(dir, 'pre-commit')
    writeFileSync(p, FOREIGN_HOOK, { mode: 0o755 })
    const r = installHooks({ hooksDir: dir, gremionUiRoot })
    expect(r.action, 'a foreign hook must be prepended to, never appended after').toBe('prepended')
    const text = readFileSync(p, 'utf8')
    expect(text.startsWith('#!/bin/sh\n'), text).toBe(true)
    expect(text).toContain('[foreign] ok')
    expect(
      text.indexOf(MARKER_BEGIN),
      'the managed block must precede the foreign hook body',
    ).toBeLessThan(text.indexOf('[foreign] ok'))
  })

  it('re-running over a prepended hook updates in place and preserves the foreign body', () => {
    const dir = tempDir('kmirror-foreign-')
    const p = join(dir, 'pre-commit')
    writeFileSync(p, FOREIGN_HOOK, { mode: 0o755 })
    installHooks({ hooksDir: dir, gremionUiRoot })
    const second = installHooks({ hooksDir: dir, gremionUiRoot })
    expect(second.action).toBe('updated')
    const text = readFileSync(p, 'utf8')
    expect(text.split(MARKER_BEGIN).length - 1, 'exactly one managed block').toBe(1)
    expect(text).toContain('[foreign] ok')
  })

  it.skipIf(isWindows)('writes the hook with the executable bit (POSIX)', () => {
    // git SILENTLY IGNORES a non-executable hook ("hint: … was ignored because
    // it's not set as executable") and the commit succeeds, so a 0644 hook
    // turns every e2e assertion below into a measurement of nothing.
    const installed = join(installedHooksDir(), 'pre-commit')
    expect(lstatSync(installed).mode & 0o777).toBe(0o755)
    // …and so does the harness that writes raw hook text for the recorded RED.
    const harness = join(hooksDirWithText(DEAD_TOLERANT_BLOCK), 'pre-commit')
    expect(lstatSync(harness).mode & 0o777).toBe(0o755)
  })
})

describe('temp-dir symlink cleanup', () => {
  it('removes the LINK and never touches the target', () => {
    const target = tempDir('kmirror-target-')
    writeFileSync(join(target, 'keep.txt'), 'keep')
    const holder = tempDir('kmirror-holder-')
    const link = join(holder, 'link')
    symlinkSync(target, link, 'junction')
    unlinkJunction(link)
    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(target, 'keep.txt')), 'the link target must survive').toBe(true)
  })

  it('is a no-op when the link is absent and REFUSES a real directory', () => {
    const holder = tempDir('kmirror-holder-')
    expect(() => unlinkJunction(join(holder, 'nope'))).not.toThrow()
    const real = join(holder, 'real')
    mkdirSync(real)
    expect(() => unlinkJunction(real)).toThrow(/refusing to remove/)
    expect(existsSync(real)).toBe(true)
  })
})

describe('versioned pre-commit hook', () => {
  it('has no bare `exit 0` skip path', () => {
    expect(
      bareExitZeroLines(readFileSync(versionedHook, 'utf8')),
      'a bare `exit 0` is the silent-skip defect — every skip must fail the commit with an instruction',
    ).toEqual([])
  })

  it('the INSTALLED WRAPPER has no bare `exit 0` skip path either', () => {
    // Applying this detector only to the delegate exempts exactly the artifact
    // the installer produces — and the base wrapper ends in a literal `exit 0`.
    expect(
      bareExitZeroLines(installedWrapper()),
      'the generated wrapper must never be able to exit 0 without running the delegate',
    ).toEqual([])
  })

  it('the bare-`exit 0` detector recognises every skip shape', () => {
    // Negative control for the detector itself.
    expect(bareExitZeroLines('if [ ! -f "$LINT" ]; then exit 0; fi').map((b) => b.line)).toEqual([1])
    expect(bareExitZeroLines('then exit 0').map((b) => b.line)).toEqual([1])
    expect(bareExitZeroLines('  exit 0').map((b) => b.line)).toEqual([1])
    expect(bareExitZeroLines('[ -f "$LINT" ] || exit 0').map((b) => b.line)).toEqual([1])
    // A separator-enumerating regex misses all four of these.
    expect(bareExitZeroLines('if [ -f x ]; then :; else exit 0; fi').map((b) => b.line)).toEqual([1])
    expect(bareExitZeroLines('else exit 0').map((b) => b.line)).toEqual([1])
    expect(bareExitZeroLines('case $x in *) exit 0 ;; esac').map((b) => b.line)).toEqual([1])
    expect(bareExitZeroLines('exit  0').map((b) => b.line)).toEqual([1])
    // …and it must not fire on the forms the hardened hook legitimately uses.
    expect(bareExitZeroLines('exit $status')).toEqual([])
    expect(bareExitZeroLines('cd "$ROOT" || exit 1')).toEqual([])
    expect(bareExitZeroLines('# then exit 0 — described in a comment')).toEqual([])
  })

  it('the detector FIRES on the kernel pre-fix delegate (negative control)', () => {
    // The base delegate's three `exit 0` skip paths are what the detector is
    // for; without this row the assertion above could pass vacuously.
    const preFix = [
      'ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0',
      'if [ ! -f "$LINT" ]; then',
      '  exit 0  # pre-P0.4 checkout — nothing to run',
      'fi',
    ].join('\n')
    expect(bareExitZeroLines(preFix).map((b) => b.line)).toEqual([1, 3])
  })

  it('is checked out with LF endings, not CRLF', () => {
    // The hook is extensionless, so none of .gitattributes' `*.sh`-style rules
    // cover it and core.autocrlf=true would check it out with CRLF. Hardening
    // rather than a reproduced break — Git-for-Windows' bundled sh still runs a
    // CRLF copy — but other sh implementations are less forgiving.
    // `gremion-ui/scripts/hooks/** text eol=lf` is what keeps it LF.
    const raw = readFileSync(versionedHook, 'utf8')
    expect(
      raw.includes('\r'),
      'the hook was checked out with CRLF — pin it in .gitattributes (gremion-ui/scripts/hooks/** text eol=lf)',
    ).toBe(false)
  })
})

describe('boundary-lint file-count parser', () => {
  it('distinguishes a real lint from one that inspected nothing', () => {
    expect(lintFilesChecked('[boundary-lint] OK (3 file(s) checked, mode --staged)')).toBe(3)
    expect(lintFilesChecked('[boundary-lint] OK (0 file(s) checked, mode --staged)')).toBe(0)
    expect(lintFilesChecked('nothing of the sort')).toBeNull()
  })
})

describe('installer CLI hooks-dir resolution', () => {
  it('REFUSES --hooks-dir pointing anywhere git does not read hooks from', () => {
    // As an UNCONDITIONAL override, `--hooks-dir` means that on the one code
    // path the docs and every copy-pasted remedy push people down, the question
    // that decides whether a hook ever runs — "is this the directory git reads
    // hooks from?" — is never asked. A hook outside it is installed-looking and
    // enforcing nothing: the whole failure class.
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    const target = tempDir('kmirror-cli-')
    const r = runInstallerCli(repo, ['--hooks-dir', target])
    expect(r.status, `expected a refusal, got:\n${r.stdout}${r.stderr}`).not.toBe(0)
    expect(
      existsSync(join(target, 'pre-commit')),
      'the installer wrote a hook into a directory git does not read',
    ).toBe(false)
    expect(r.stdout, 'nothing was installed, so nothing may be reported as one').not.toMatch(
      /created:|updated:|prepended:|re-prepended:/,
    )
    const out = `${r.stdout}${r.stderr}`
    const m = /git reads hooks from: (.+)/.exec(out)
    expect(m, `the refusal must name the directory git DOES read:\n${out}`).not.toBeNull()
    expect(normPath(m![1].trim())).toBe(normPath(hooksPathOf(repo)))
  }, 60_000)

  it('parses the --hooks-dir=<path> equals form (and judges it the same way)', () => {
    // `indexOf('--hooks-dir')` alone drops the equals form WITHOUT a word, so
    // the value would be silently ignored rather than judged.
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    const target = tempDir('kmirror-cli-eq-')
    const r = runInstallerCli(repo, [`--hooks-dir=${target}`])
    expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0)
    expect(
      `${r.stdout}${r.stderr}`,
      `--hooks-dir=${target} was never parsed`,
    ).toContain(target)
    expect(existsSync(join(target, 'pre-commit'))).toBe(false)
    expect(existsSync(join(repo, '.git/hooks/pre-commit'))).toBe(false)
  }, 60_000)

  it('ACCEPTS --hooks-dir when it IS the directory git reads hooks from', () => {
    // The flag is not banned, it is subordinated to the post-condition.
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    const r = runInstallerCli(repo, ['--hooks-dir', hooksPathOf(repo)])
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    expectWrittenDirIsHooksPath(repo, r)
  }, 60_000)

  it('rejects --hooks-dir followed by another flag', () => {
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    const r = runInstallerCli(repo, ['--hooks-dir', '--verbose'])
    expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0)
    expect(existsSync(join(repo, '--verbose'))).toBe(false)
  }, 60_000)

  it('falls back to the git common dir hooks/ when core.hooksPath is UNSET', () => {
    // `git config core.hooksPath` EXITS 1 when the key is absent, so an
    // unguarded execFileSync throws and any `|| <common dir>` fallback written
    // beside it is unreachable — the installer would crash in the DEFAULT setup.
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    expect(
      vcs(repo, ['config', 'core.hooksPath']).status,
      'precondition: the key must be unset',
    ).not.toBe(0)
    const r = runInstallerCli(repo)
    expect(r.status, `installer failed with core.hooksPath unset:\n${r.stdout}${r.stderr}`).toBe(0)
    const written = join(repo, '.git/hooks/pre-commit')
    expect(
      existsSync(written),
      `expected the hook in the git common dir, got: ${r.stdout}${r.stderr}`,
    ).toBe(true)
    expect(readFileSync(written, 'utf8')).toContain(MARKER_BEGIN)
    expectWrittenDirIsHooksPath(repo, r)
  }, 60_000)

  it('honours a LOCAL core.hooksPath when it IS set', () => {
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    const configured = tempDir('kmirror-hookspath-')
    expect(vcs(repo, ['config', 'core.hooksPath', posix(configured)]).status).toBe(0)
    const r = runInstallerCli(repo)
    expect(r.status, `installer failed with core.hooksPath set:\n${r.stdout}${r.stderr}`).toBe(0)
    expect(existsSync(join(configured, 'pre-commit')), `${r.stdout}${r.stderr}`).toBe(true)
    // …and it must NOT have written into the common dir instead.
    expect(existsSync(join(repo, '.git/hooks/pre-commit'))).toBe(false)
    expectWrittenDirIsHooksPath(repo, r)
  }, 60_000)

  it('resolves a RELATIVE core.hooksPath against the worktree toplevel, not the cwd', () => {
    // git resolves a relative core.hooksPath against the worktree TOP LEVEL.
    // `resolve(value)` resolves against process.cwd(), so running the installer
    // from gremion-ui/ would write to <repo>/gremion-ui/.githooks — a directory
    // git never reads, created silently by mkdirSync(recursive) and reported as
    // `created:`. Installed-looking, enforcing nothing.
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    expect(vcs(repo, ['config', 'core.hooksPath', '.githooks']).status).toBe(0)
    const r = runInstallerCli(join(repo, 'gremion-ui'))
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    expect(
      existsSync(join(repo, '.githooks/pre-commit')),
      `expected <repo>/.githooks/pre-commit (where git looks), got: ${r.stdout}${r.stderr}`,
    ).toBe(true)
    expect(
      existsSync(join(repo, 'gremion-ui/.githooks')),
      'the installer resolved the relative hooksPath against its own cwd',
    ).toBe(false)
    // Because git resolves it per worktree, a RELATIVE hooksPath gives every
    // linked worktree its own <worktree>/.githooks. The hook is NOT shared, so
    // a worktree nobody installed into commits unguarded — the installer must
    // say so rather than let a "shared by every worktree" promise stand.
    expect(
      `${r.stdout}${r.stderr}`,
      'a relative hooksPath is not shared between linked worktrees — say so',
    ).toMatch(/relative[\s\S]*worktree/i)
    expectWrittenDirIsHooksPath(join(repo, 'gremion-ui'), r)
  }, 60_000)

  it('expands a `~/` core.hooksPath against the home directory', () => {
    // git expands a leading `~` in core.hooksPath. resolve(top, "~/x") does
    // not: it creates a literal directory named "~" inside the worktree and
    // reports `created:` for a hook git will never run.
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    const home = tempDir('kmirror-home-')
    expect(vcs(repo, ['config', 'core.hooksPath', '~/kmirror-tilde-hooks']).status).toBe(0)
    const r = runInstallerCli(repo, [], { HOME: home, USERPROFILE: home })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0)
    expect(
      existsSync(join(home, 'kmirror-tilde-hooks/pre-commit')),
      `git expands ~ in core.hooksPath, so the installer must too. got: ${r.stdout}${r.stderr}`,
    ).toBe(true)
    expect(
      existsSync(join(repo, '~')),
      'the installer created a literal "~" directory inside the worktree',
    ).toBe(false)
    expectWrittenDirIsHooksPath(repo, r, { HOME: home, USERPROFILE: home })
  }, 60_000)

  it('REFUSES to install into a global/system core.hooksPath and says so', () => {
    // A global hooksPath is shared by every REPO on the machine. Writing this
    // fail-closed wrapper there makes every unrelated repository un-committable
    // without --no-verify, and the remediation it prints is unrunnable there.
    const home = tempDir('kmirror-fakehome-')
    const globalCfg = join(home, 'gitconfig')
    const globalHooks = tempDir('kmirror-globalhooks-')
    writeFileSync(globalCfg, `[core]\n\thooksPath = ${posix(globalHooks)}\n`)
    const isolated = {
      GIT_CONFIG_GLOBAL: globalCfg,
      GIT_CONFIG_SYSTEM: join(home, 'no-system-config'),
    }
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    // precondition: git itself DOES see the global value in this environment
    const seen = vcs(repo, ['config', '--get', 'core.hooksPath'], isolated)
    expect(seen.stdout.trim(), 'precondition: the global value must be visible').toBe(posix(globalHooks))

    const r = runInstallerCli(repo, [], isolated)
    // exit 0 + a warning + a write into the repo's OWN hooks dir is itself the
    // defect: git obeys the INHERITED value, so that hook is never run — yet
    // stdout would say `created: …` and the exit code would say success, which
    // is what a postinstall step, CI or an agent harness reads.
    expect(r.status, `expected a NON-ZERO exit, got:\n${r.stdout}${r.stderr}`).not.toBe(0)
    expect(
      existsSync(join(globalHooks, 'pre-commit')),
      'the installer wrote the fail-closed wrapper into a MACHINE-WIDE hooks dir',
    ).toBe(false)
    expect(
      existsSync(join(repo, '.git/hooks/pre-commit')),
      'the installer wrote into a hooks dir git will NOT read while the inherited value stands',
    ).toBe(false)
    expect(
      `${r.stdout}${r.stderr}`,
      'refusing silently is the same failure class — the user must be told',
    ).toMatch(/core\.hooksPath is set OUTSIDE this repository/)
    expect(
      r.stdout,
      'a "created:" line claims an install that did not happen',
    ).not.toMatch(/created:/)
    expect(
      `${r.stdout}${r.stderr}`,
      'the remedy must be the exact command that makes an install possible',
    ).toContain('git config --local core.hooksPath')

    // The remedy must be ABSOLUTE. git resolves a relative hooksPath against
    // EACH worktree's own top level, so in a linked worktree `.git/hooks` names
    // a path under a `.git` FILE, and in the main worktree it silently opts
    // every linked worktree out.
    const out = `${r.stdout}${r.stderr}`
    const remedy = /git config --local core\.hooksPath "?([^"\n]+)"?/.exec(out)
    expect(remedy, `no remedy command in:\n${out}`).not.toBeNull()
    const remedyPath = remedy![1].trim()
    expect(isAbsolute(remedyPath), `the remedy value "${remedyPath}" is not absolute`).toBe(true)
    expect(normPath(remedyPath)).toBe(normPath(join(repo, '.git/hooks')))
    expect(
      out,
      'the bare relative `.git/hooks` literal is the value that breaks in linked worktrees',
    ).not.toMatch(/core\.hooksPath\s+"?\.git\/hooks"?/)

    // A refusal must not hand out the escape hatch that skips the very
    // post-condition it just enforced.
    expect(out, '--hooks-dir must not be offered as a remedy').not.toContain('--hooks-dir')
  }, 60_000)

  it('worktree-SCOPED core.hooksPath is honoured, not mistaken for an inherited value', () => {
    // `git config --local --get` does NOT see a per-worktree value, and plain
    // `git config --get` cannot tell one from a global one. Classifying a
    // legitimate `--worktree core.hooksPath` as "set OUTSIDE this repository"
    // and REFUSING makes the installer unusable in exactly the linked worktrees
    // it warns people about. Scope must be read explicitly (`--show-scope`).
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    expect(vcs(repo, ['commit', '-q', '--allow-empty', '--no-verify', '-m', 'base']).status).toBe(0)
    expect(vcs(repo, ['config', '--local', 'extensions.worktreeConfig', 'true']).status).toBe(0)
    const wt = join(tempDir('kmirror-wt-'), 'linked')
    const added = vcs(repo, ['worktree', 'add', '-q', wt, '-b', 'kmirror-wt'])
    expect(added.status, added.stderr).toBe(0)
    const wtHooks = join(wt, 'wt-hooks')
    expect(vcs(wt, ['config', '--worktree', 'core.hooksPath', posix(wtHooks)]).status).toBe(0)
    const scope = vcs(wt, ['config', '--show-scope', '--get', 'core.hooksPath'])
    expect(scope.stdout, 'precondition: the value must really be worktree-scoped').toMatch(
      /^worktree\t/,
    )

    const r = runInstallerCli(wt)
    expect(r.status, `a worktree-scoped hooksPath must be honoured, got:\n${r.stdout}${r.stderr}`).toBe(0)
    expect(existsSync(join(wtHooks, 'pre-commit')), `${r.stdout}${r.stderr}`).toBe(true)
    expectWrittenDirIsHooksPath(wt, r)
  }, 60_000)

  it('a FAILING git is not silently treated as "core.hooksPath is unset"', () => {
    // `git config --get <unset key>` exits 1; a git that cannot read its config
    // at all exits 128. Collapsing both to null makes a broken environment look
    // like the default one, and the installer then reports "not inside a git
    // repository" — a diagnosis that sends the user to fix the wrong thing.
    const home = tempDir('kmirror-badcfg-')
    const brokenCfg = join(home, 'gitconfig')
    writeFileSync(brokenCfg, '[core\n\thooksPath = whatever\n')
    const isolated = {
      GIT_CONFIG_GLOBAL: brokenCfg,
      GIT_CONFIG_SYSTEM: join(home, 'no-system-config'),
    }
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    const probe = vcs(repo, ['config', '--get', 'core.hooksPath'], isolated)
    expect(probe.status, 'precondition: git must fail with something other than 1').not.toBe(1)
    expect(probe.status).not.toBe(0)

    const r = runInstallerCli(repo, [], isolated)
    const out = `${r.stdout}${r.stderr}`
    expect(r.status, `expected a refusal, got:\n${out}`).not.toBe(0)
    expect(existsSync(join(repo, '.git/hooks/pre-commit'))).toBe(false)
    expect(out, 'the report must say GIT failed, and echo what git said').toMatch(
      /git (?:itself )?failed|git exited/i,
    )
    expect(out, "git's own diagnosis is the actionable part").toMatch(/bad config/i)
    expect(
      out,
      'blaming the checkout for a broken git config sends the user to fix the wrong thing',
    ).not.toMatch(/not inside a git repository/)
  }, 60_000)
})

describe('end-to-end rejection (throwaway repo, core.hooksPath)', () => {
  it('blocks a staged boundary-violating import and leaves no commit', () => {
    const repo = throwawayRepo()
    const { commit, logOut, output } = commitWith(repo, installedHooksDir(), VIOLATION)
    expect(commit.status, `expected a blocked commit, got:\n${output}`).not.toBe(0)
    expect(output).toContain('no-deep-import-into-newsletter')
    expect(logOut).toBe('') // post-condition: the commit is absent from git log
  }, 180_000)

  it('POSITIVE PATH: a clean commit passes AND the lint inspected N >= 1 files', () => {
    // Without this, "block everything" would score as a pass. And without the
    // file-count assertion, a lint that collected ZERO files (what a stale path
    // prefix does) would score as a pass too.
    const repo = throwawayRepo()
    const { commit, logOut, output } = commitWith(repo, installedHooksDir(), CLEAN)
    expect(commit.status, `expected the clean commit to be ACCEPTED, got:\n${output}`).toBe(0)
    expect(logOut).toContain('kmirror clean probe')
    const checked = lintFilesChecked(output)
    expect(checked, `boundary-lint printed no OK line — did it run at all?\n${output}`).not.toBeNull()
    expect(
      checked,
      `boundary-lint reported ${checked} file(s) checked — a zero-file lint passes vacuously`,
    ).toBeGreaterThanOrEqual(1)
  }, 180_000)

  it('the WRAPPER fails closed when the versioned hook is absent', () => {
    // The wrapper's own fall-through is the kernel base's shape: it can harden
    // the delegate and still keep `if [ -f … ]; then … fi`, so a worktree
    // missing the delegate commits silently — the defect, one level up.
    const repo = throwawayRepo({ versionedHook: false })
    expect(existsSync(join(repo, 'gremion-ui/scripts/hooks/pre-commit'))).toBe(false)
    const { commit, logOut, output } = commitWith(repo, installedHooksDir(), VIOLATION)
    expect(commit.status, `expected a blocked commit, got:\n${output}`).not.toBe(0)
    expect(output).toContain('gremion-ui/scripts/hooks/pre-commit')
    expect(output, 'the block must carry a remediation instruction').toContain('install-git-hooks.mjs')
    expect(logOut).toBe('')
  }, 180_000)

  it('RECORDED RED: the kernel PRE-FIX wrapper lets that same commit through', () => {
    // The base tolerant wrapper with the delegate absent: `[ -f … ]` is false,
    // the `fi` falls through, the hook exits 0 and the violating commit lands.
    // Present, executable, enforcing nothing.
    const repo = throwawayRepo({ versionedHook: false })
    const { commit, logOut } = commitWith(repo, hooksDirWithText(DEAD_TOLERANT_BLOCK), VIOLATION)
    expect(commit.status, 'the pre-fix hook is expected to enforce nothing').toBe(0)
    expect(logOut).toContain('kmirror boundary violation probe')
  }, 180_000)

  it('a FOREIGN hook ending in `exit 0` still fails closed when the delegate is absent', () => {
    // With the block APPENDED after the foreign `exit 0`, none of the
    // fail-closed branches ever execute and the commit lands with only
    // "[foreign] ok" printed.
    const repo = throwawayRepo({ versionedHook: false })
    const hooksDir = installedHooksDir(FOREIGN_HOOK)
    const { commit, logOut, output } = commitWith(repo, hooksDir, VIOLATION)
    expect(commit.status, `expected a blocked commit, got:\n${output}`).not.toBe(0)
    expect(output).toContain('install-git-hooks.mjs')
    expect(logOut).toBe('')
  }, 180_000)

  it('a FOREIGN hook still runs on a clean commit', () => {
    // Prepending must not disable what was already there.
    const repo = throwawayRepo()
    const hooksDir = installedHooksDir(FOREIGN_HOOK)
    const { commit, logOut, output } = commitWith(repo, hooksDir, CLEAN)
    expect(commit.status, `expected the clean commit to be ACCEPTED, got:\n${output}`).toBe(0)
    expect(output, 'the preserved foreign hook must still execute').toContain('[foreign] ok')
    expect(logOut).toContain('kmirror clean probe')
  }, 180_000)

  it('fails the commit with an instruction when gremion-ui/node_modules is missing', () => {
    // The kernel base delegate `exit 0`s here — which is every fresh agent
    // worktree, i.e. the most common way this guard silently does nothing.
    const repo = throwawayRepo({ nodeModules: false })
    const { commit, logOut, output } = commitWith(repo, installedHooksDir(), VIOLATION)
    expect(commit.status, `expected a blocked commit, got:\n${output}`).not.toBe(0)
    expect(output).toContain('pnpm install')
    expect(logOut).toBe('')
  }, 180_000)

  it('fails the commit with an instruction when boundary-lint.ts is missing', () => {
    const repo = throwawayRepo({ lint: false })
    const { commit, logOut, output } = commitWith(repo, installedHooksDir(), VIOLATION)
    expect(commit.status, `expected a blocked commit, got:\n${output}`).not.toBe(0)
    expect(output).toContain('boundary-lint.ts')
    expect(logOut).toBe('')
  }, 180_000)
})

/** Foreign hooks that are NOT shell scripts. The managed block is /bin/sh
 *  code; prepending it produces a file that is a syntax error for its own
 *  interpreter, so every commit in that clone would then die on a hook the
 *  installer itself mangled — and the foreign hook would stop working too. */
const PYTHON_HOOK = '#!/usr/bin/env python3\nimport sys\nprint("[foreign-py] ok")\nsys.exit(0)\n'
const NODE_HOOK = '#!/usr/bin/node\nconsole.log("[foreign-node] ok")\nprocess.exit(0)\n'
/** bash IS a shell — the refusal must not over-trigger and lock out the most
 *  common non-/bin/sh shebang there is. */
const BASH_HOOK = '#!/usr/bin/env bash\necho "[foreign-bash] ok"\nexit 0\n'

/** The managed block exactly as the CURRENT installer emits it. */
function currentManagedBlock(): string {
  const t = installedWrapper()
  return t.slice(t.indexOf(MARKER_BEGIN), t.indexOf(MARKER_END) + MARKER_END.length)
}

/** The layout an APPEND-era install leaves on developers' machines: foreign
 *  body, its `exit 0`, then the managed block — marker-bearing, so the
 *  installer's "replace between the markers" path treats it as up to date,
 *  and permanently unreachable. */
function appendedLegacyHook(): string {
  return `${FOREIGN_HOOK}${currentManagedBlock()}\n`
}

/** Everything before MARKER_BEGIN, as lines. */
function preambleLines(text: string): string[] {
  return text.slice(0, text.indexOf(MARKER_BEGIN)).split('\n').slice(0, -1)
}

describe('foreign hooks the installer must not rewrite', () => {
  it.each([
    ['python3', PYTHON_HOOK],
    ['node', NODE_HOOK],
  ])('refuses a %s foreign hook and leaves it byte-identical', (interpreter, fixture) => {
    const dir = tempDir('kmirror-nonsh-')
    const p = join(dir, 'pre-commit')
    writeFileSync(p, fixture, { mode: 0o755 })
    const before = readFileSync(p)
    expect(() => installHooks({ hooksDir: dir, gremionUiRoot })).toThrow(new RegExp(interpreter))
    expect(
      readFileSync(p).equals(before),
      'a hook the installer refuses must be left byte-identical',
    ).toBe(true)
  })

  it('names the interpreter AND the remedies', () => {
    const dir = tempDir('kmirror-nonsh-msg-')
    writeFileSync(join(dir, 'pre-commit'), PYTHON_HOOK, { mode: 0o755 })
    let message = ''
    try {
      installHooks({ hooksDir: dir, gremionUiRoot })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message, 'the installer must refuse, not proceed').not.toBe('')
    expect(message).toContain('python3')
    expect(message, 'a refusal without a way forward is a dead end').toContain('mv ')
    // "Install it somewhere git does not read hooks from" is a remedy that
    // produces the exact enforcing-nothing state this guard exists to prevent.
    // Pointing the REPOSITORY at another hooks dir is the honest version.
    expect(message, '--hooks-dir must not be offered as a remedy').not.toContain('--hooks-dir')
    expect(message, 'the remedy must move git, not dodge it').toContain(
      'git config --local core.hooksPath',
    )
  })

  it('CLI: exits non-zero, writes nothing and claims no install', () => {
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    const target = tempDir('kmirror-nonsh-cli-')
    const p = join(target, 'pre-commit')
    writeFileSync(p, PYTHON_HOOK, { mode: 0o755 })
    const before = readFileSync(p)
    // Point the REPOSITORY at that dir — the installer only ever writes where
    // git reads, so that is the only way to reach a foreign hook from the CLI.
    expect(vcs(repo, ['config', '--local', 'core.hooksPath', posix(target)]).status).toBe(0)
    const r = runInstallerCli(repo)
    expect(r.status, `expected a non-zero exit, got:\n${r.stdout}${r.stderr}`).not.toBe(0)
    expect(readFileSync(p).equals(before), 'the foreign hook was rewritten').toBe(true)
    expect(`${r.stdout}${r.stderr}`).toContain('python3')
    expect(r.stdout, 'no install happened, so nothing may be reported as one').not.toMatch(
      /created:|updated:|prepended:/,
    )
  }, 60_000)

  it('still PREPENDS to a bash-shebang hook', () => {
    const dir = tempDir('kmirror-bash-')
    const p = join(dir, 'pre-commit')
    writeFileSync(p, BASH_HOOK, { mode: 0o755 })
    const r = installHooks({ hooksDir: dir, gremionUiRoot })
    expect(r.action, 'bash is a shell — the refusal must not fire here').toBe('prepended')
    const text = readFileSync(p, 'utf8')
    expect(text.startsWith('#!/usr/bin/env bash\n'), text).toBe(true)
    expect(text.indexOf(MARKER_BEGIN)).toBeLessThan(text.indexOf('[foreign-bash] ok'))
  })
})

describe('a managed block APPENDED behind the foreign body', () => {
  it('is moved back to the front on re-install', () => {
    // A marker-replacement path that rewrites the block WHERE IT SAT leaves it
    // behind the foreign hook's `exit 0` — dead code — and re-running the
    // installer, the documented remedy for a stale hook, reports `updated` and
    // changes nothing that matters.
    const dir = tempDir('kmirror-appended-')
    const p = join(dir, 'pre-commit')
    writeFileSync(p, appendedLegacyHook(), { mode: 0o755 })
    const seeded = readFileSync(p, 'utf8')
    expect(
      seeded.indexOf('exit 0'),
      'precondition: the seeded layout must really be the broken one',
    ).toBeLessThan(seeded.indexOf(MARKER_BEGIN))

    const r = installHooks({ hooksDir: dir, gremionUiRoot })
    expect(r.action).toBe('re-prepended')
    const text = readFileSync(p, 'utf8')
    expect(text.split(MARKER_BEGIN).length - 1, 'exactly one managed block').toBe(1)
    expect(text.split(MARKER_END).length - 1, 'exactly one managed block').toBe(1)
    expect(
      preambleLines(text).filter((l) => l.trim() !== '' && !l.trim().startsWith('#')),
      'MARKER_BEGIN must be preceded only by shebang/blank/comment lines — anything else can exit first',
    ).toEqual([])
    expect(text, 'the foreign body must survive the move').toContain('[foreign] ok')
    expect(text.indexOf(MARKER_END)).toBeLessThan(text.indexOf('[foreign] ok'))
  })

  it('e2e: a violating commit is BLOCKED through the re-prepended hook', () => {
    const repo = throwawayRepo()
    const dir = tempDir('kmirror-appended-e2e-')
    writeFileSync(join(dir, 'pre-commit'), appendedLegacyHook(), { mode: 0o755 })
    installHooks({ hooksDir: dir, gremionUiRoot })
    const { commit, logOut, output } = commitWith(repo, dir, VIOLATION)
    expect(commit.status, `expected a blocked commit, got:\n${output}`).not.toBe(0)
    expect(output).toContain('no-deep-import-into-newsletter')
    expect(logOut).toBe('')
  }, 180_000)
})

describe('chmod failures are visible', () => {
  it('logs when the executable bit cannot be set', () => {
    // Swallowing the failure leaves a 0644 hook, and git SILENTLY IGNORES a
    // non-executable hook on POSIX — installed-looking, enforcing nothing.
    const dir = tempDir('kmirror-chmod-')
    const seen: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      seen.push(args.map(String).join(' '))
    })
    let threw = false
    try {
      installHooks({
        hooksDir: dir,
        gremionUiRoot,
        chmod: () => {
          const err = new Error('EPERM: operation not permitted, chmod') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        },
      })
    } catch {
      threw = true
    } finally {
      spy.mockRestore()
    }
    const log = seen.join('\n')
    expect(log, 'a swallowed chmod failure is an unenforced hook on POSIX').toMatch(
      /executable bit/i,
    )
    expect(log, 'the reason must be reported, not just the fact').toMatch(/EPERM/)
    expect(
      threw,
      'on POSIX git ignores a non-executable hook, so the failure must not be downgraded to a warning',
    ).toBe(!isWindows)
  })
})

/** A real ELF binary's first bytes. `pre-commit` may legitimately be a compiled
 *  program — git only requires an executable file. Decoding one as UTF-8 and
 *  writing the result back destroys it. */
const ELF_HOOK = Buffer.from([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x3e, 0x00, 0x01, 0x00, 0x00, 0x00, 0x40, 0x10, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00,
])
/** `#!/bin/sh\necho "café"\n` in LATIN-1: a plausible hand-written hook on a
 *  non-UTF-8 machine. No NUL byte, a perfectly good `/bin/sh` shebang — and
 *  0xE9 is not valid UTF-8, so `readFileSync(…, 'utf8')` silently replaces it
 *  with U+FFFD and the write-back corrupts the file. */
const LATIN1_HOOK = Buffer.from([
  0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73, 0x68, 0x0a,
  0x65, 0x63, 0x68, 0x6f, 0x20, 0x22, 0x63, 0x61, 0x66, 0xe9, 0x22, 0x0a,
])

describe('hooks that are not UTF-8 text', () => {
  it.each([
    ['ELF binary', ELF_HOOK],
    ['Latin-1 text', LATIN1_HOOK],
  ])('refuses a %s pre-commit and leaves it byte-identical', (_label, fixture) => {
    const dir = tempDir('kmirror-bin-')
    const p = join(dir, 'pre-commit')
    writeFileSync(p, fixture, { mode: 0o755 })
    const before = sha256(p)
    expect(() => installHooks({ hooksDir: dir, gremionUiRoot })).toThrow(/UTF-8|binary/i)
    expect(
      sha256(p),
      'a hook the installer refuses must be left byte-identical — decoding it as UTF-8 and writing it back destroys it',
    ).toBe(before)
    expect(readFileSync(p).equals(fixture)).toBe(true)
  })

  it('CLI: refuses, exits non-zero and claims no install', () => {
    const repo = throwawayRepo({ nodeModules: false, lint: false })
    const target = tempDir('kmirror-bin-cli-')
    const p = join(target, 'pre-commit')
    writeFileSync(p, ELF_HOOK, { mode: 0o755 })
    const before = sha256(p)
    expect(vcs(repo, ['config', '--local', 'core.hooksPath', posix(target)]).status).toBe(0)
    const r = runInstallerCli(repo)
    expect(r.status, `expected a refusal, got:\n${r.stdout}${r.stderr}`).not.toBe(0)
    expect(sha256(p)).toBe(before)
    expect(r.stdout).not.toMatch(/created:|updated:|prepended:|re-prepended:/)
  }, 60_000)
})

describe('a symlinked pre-commit', () => {
  it('is refused, not written through', () => {
    // Writing through a symlink writes to its TARGET — which can be outside the
    // hooks dir entirely. The installer would then report installing a hook at
    // a path whose bytes live somewhere else, and `existsSync` follows links,
    // so a DANGLING one is "absent" and gets created at the target instead.
    const dir = tempDir('kmirror-symlink-')
    const link = join(dir, 'pre-commit')
    const store = tempDir('kmirror-linktarget-')
    let targetFile: string | null = null
    if (isWindows) {
      // A file symlink needs Developer Mode or elevation on Windows; a
      // directory JUNCTION does not, and lstat reports it as a symlink too.
      symlinkSync(store, link, 'junction')
    } else {
      targetFile = join(store, 'real-hook')
      writeFileSync(targetFile, FOREIGN_HOOK)
      symlinkSync(targetFile, link)
    }
    const before = targetFile === null ? null : sha256(targetFile)

    expect(() => installHooks({ hooksDir: dir, gremionUiRoot })).toThrow(/symlink/i)
    expect(lstatSync(link).isSymbolicLink(), 'the link itself must survive untouched').toBe(true)
    if (targetFile !== null) {
      expect(sha256(targetFile), 'the installer wrote THROUGH the symlink').toBe(before)
    }
  })
})

describe('the hook is written atomically', () => {
  it('writes a sibling temp file, chmods THAT, and renames it into place', () => {
    // A plain writeFileSync truncates the live hook first: an interrupted or
    // failing install (a chmod that throws, a full disk, a killed process)
    // leaves a half-written or 0644 pre-commit that git either ignores or runs
    // as garbage. temp + chmod + rename in the SAME directory makes the swap a
    // single atomic operation — the hook is either the old one or the new one.
    const dir = tempDir('kmirror-atomic-')
    const hookPath = join(dir, 'pre-commit')
    writeFileSync(hookPath, FOREIGN_HOOK, { mode: 0o755 })
    const observed: { path: string; mode: number; hookAtChmodTime: string }[] = []
    installHooks({
      hooksDir: dir,
      gremionUiRoot,
      chmod: (p: string, mode: number) => {
        observed.push({ path: p, mode, hookAtChmodTime: readFileSync(hookPath, 'utf8') })
      },
    })
    expect(observed.length, 'the exec bit must still be set exactly once').toBe(1)
    const [{ path: chmodded, mode, hookAtChmodTime }] = observed
    expect(chmodded, 'chmod must target the TEMP file, not the live hook').not.toBe(hookPath)
    expect(
      normPath(dirname(chmodded)),
      'the temp file must be a SIBLING — rename is only atomic within one filesystem',
    ).toBe(normPath(dir))
    expect(mode).toBe(0o755)
    expect(
      hookAtChmodTime,
      'the live hook must still be the OLD one until the rename — nothing may observe a partial write',
    ).toBe(FOREIGN_HOOK)
    const after = readFileSync(hookPath, 'utf8')
    expect(after, 'and after the rename it is the new one').toContain(MARKER_BEGIN)
    expect(after).toContain('[foreign] ok')
    expect(
      readdirSync(dir),
      'no temp file may be left behind',
    ).toEqual(['pre-commit'])
  })

  it('leaves the previous hook intact when the install fails', () => {
    const dir = tempDir('kmirror-atomic-fail-')
    const hookPath = join(dir, 'pre-commit')
    writeFileSync(hookPath, FOREIGN_HOOK, { mode: 0o755 })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      installHooks({
        hooksDir: dir,
        gremionUiRoot,
        chmod: () => {
          const err = new Error('EPERM: operation not permitted, chmod') as NodeJS.ErrnoException
          err.code = 'EPERM'
          throw err
        },
      })
    } catch {
      // POSIX: a chmod failure is fatal (git ignores a non-executable hook).
    } finally {
      spy.mockRestore()
    }
    if (!isWindows) {
      expect(
        readFileSync(hookPath, 'utf8'),
        'a failed install must not have clobbered the working hook',
      ).toBe(FOREIGN_HOOK)
    }
    expect(readdirSync(dir), 'no temp file may be left behind by a failed install').toEqual([
      'pre-commit',
    ])
  })
})

describe('upgrading the hook an EXISTING clone actually carries', () => {
  /**
   * What a clone installed from the kernel base holds: the tolerant managed
   * block written by an installer generation whose wrapper ended in a literal
   * `exit 0`. Upgrading it is the path every existing developer takes, and the
   * bare-`exit 0` detector is never pointed at the RESULT of that path — only
   * at a hook installed into an empty directory.
   */
  const LIVE_CLONE_HOOK = `#!/bin/sh\n${DEAD_TOLERANT_BLOCK}\nexit 0\n`

  it('the upgrade ARTIFACT has no bare `exit 0` skip path', () => {
    const dir = tempDir('kmirror-upgrade-')
    const p = join(dir, 'pre-commit')
    writeFileSync(p, LIVE_CLONE_HOOK, { mode: 0o755 })
    expect(
      bareExitZeroLines(readFileSync(p, 'utf8')).length,
      'precondition: the existing-clone fixture really does carry a bare `exit 0`',
    ).toBe(1)

    const r = installHooks({ hooksDir: dir, gremionUiRoot })
    expect(r.action).toBe('updated')
    const upgraded = readFileSync(p, 'utf8')
    expect(
      bareExitZeroLines(upgraded),
      "upgrading an existing clone left the previous generation's `exit 0` tail in place",
    ).toEqual([])
    expect(referencedHookPath(upgraded)).toBe('gremion-ui/scripts/hooks/pre-commit')
    expect(upgraded, 'the fail-closed sense must survive the upgrade').toContain(
      '[ ! -f "$GREMION_ROOT/gremion-ui/scripts/hooks/pre-commit" ]',
    )
    expect(upgraded.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('does NOT strip an `exit 0` that belongs to a FOREIGN body', () => {
    // The tail-trim must recognise a previous generation of OUR OWN wrapper,
    // not amputate whatever a developer wrote.
    const dir = tempDir('kmirror-upgrade-foreign-')
    const p = join(dir, 'pre-commit')
    writeFileSync(p, FOREIGN_HOOK, { mode: 0o755 })
    installHooks({ hooksDir: dir, gremionUiRoot })
    const text = readFileSync(p, 'utf8')
    expect(text, 'the foreign body must survive verbatim').toContain('[foreign] ok')
    expect(text).toContain('exit 0')
  })

  it('e2e: a violating commit is BLOCKED through the upgraded existing-clone hook', () => {
    const repo = throwawayRepo()
    const dir = tempDir('kmirror-upgrade-e2e-')
    writeFileSync(join(dir, 'pre-commit'), LIVE_CLONE_HOOK, { mode: 0o755 })
    installHooks({ hooksDir: dir, gremionUiRoot })
    const { commit, logOut, output } = commitWith(repo, dir, VIOLATION)
    expect(commit.status, `expected a blocked commit, got:\n${output}`).not.toBe(0)
    expect(output).toContain('no-deep-import-into-newsletter')
    expect(logOut).toBe('')
  }, 180_000)
})

describe('CONTRIBUTING.md documents the post-condition', () => {
  const contributing = () => readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf8')

  it('documents the install command', () => {
    expect(
      contributing(),
      'an installer nobody is told to run is a guard nobody has',
    ).toContain('node gremion-ui/scripts/install-git-hooks.mjs')
  })

  it('never recommends --hooks-dir', () => {
    // Documenting an unconditional override as the escape hatch is how the
    // "installed somewhere git does not read" state gets reached on purpose.
    expect(contributing(), 'CONTRIBUTING must not recommend --hooks-dir').not.toContain(
      '--hooks-dir',
    )
  })

  it('states the post-condition and the absolute-path remedy', () => {
    const text = contributing()
    expect(text, 'the guarantee the installer now enforces must be written down').toContain(
      'git rev-parse --git-path hooks',
    )
    expect(
      text,
      'the relative `.git/hooks` remedy breaks in linked worktrees — do not print it',
    ).not.toMatch(/core\.hooksPath\s+`?\.git\/hooks`?/)
  })
})

describe('versioned hook file mode', () => {
  it('is TRACKED executable (100755) in the index', () => {
    // The exec bit lives in the git index, so a fresh clone reproduces it. At
    // 100644 the delegate is non-executable everywhere; it survives only
    // because the wrapper invokes it as `sh <path>`, i.e. one edit away from
    // the silent-skip class this whole guard exists for.
    const r = spawnSync('git', ['ls-files', '-s', '--', 'gremion-ui/scripts/hooks/pre-commit'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(r.status, r.stderr).toBe(0)
    expect(
      r.stdout.trim(),
      'run: git update-index --chmod=+x gremion-ui/scripts/hooks/pre-commit',
    ).toMatch(/^100755 /)
  })
})

/** `#!/bin/sh\r\necho "[foreign] ok"\r\nexit 0\r\n` — a hand-written hook saved
 *  by a Windows editor. It is valid UTF-8 and its shebang trims to `sh`, so
 *  every other refusal above waves it through. */
const CRLF_HOOK = '#!/bin/sh\r\necho "[foreign] ok"\r\nexit 0\r\n'

describe('hooks with CRLF line endings', () => {
  it('refuses a CRLF foreign hook and leaves it byte-identical', () => {
    const dir = tempDir('kmirror-crlf-')
    const p = join(dir, 'pre-commit')
    writeFileSync(p, CRLF_HOOK, { mode: 0o755 })
    const before = sha256(p)
    expect(() => installHooks({ hooksDir: dir, gremionUiRoot })).toThrow(/CRLF|carriage return/i)
    expect(sha256(p), 'a hook the installer refuses must be left byte-identical').toBe(before)
    expect(readFileSync(p, 'utf8')).toBe(CRLF_HOOK)
  })

  it('says WHY and hands over a remediation that converts the endings', () => {
    const dir = tempDir('kmirror-crlf-msg-')
    writeFileSync(join(dir, 'pre-commit'), CRLF_HOOK, { mode: 0o755 })
    let message = ''
    try {
      installHooks({ hooksDir: dir, gremionUiRoot })
    } catch (err) {
      message = (err as Error).message
    }
    expect(message, 'the installer must refuse, not proceed').not.toBe('')
    // The managed block is written with LF. Prepending it under a shebang line
    // that still ends in CR leaves a file POSIX resolves against an interpreter
    // named `/bin/sh<CR>`: the wrapper's fail-closed branches never execute,
    // and the installer would have reported `prepended:`.
    expect(message).toMatch(/CRLF|carriage return/i)
    expect(message, 'a refusal without a way forward is a dead end').toMatch(
      /dos2unix|LF|line ending/i,
    )
    expect(message).toContain('Nothing was changed.')
  })

  it('still installs into an LF hook of the same shape', () => {
    // The refusal must be about the ENDINGS, not about foreign hooks at large.
    const dir = tempDir('kmirror-crlf-control-')
    const p = join(dir, 'pre-commit')
    writeFileSync(p, CRLF_HOOK.split('\r\n').join('\n'), { mode: 0o755 })
    const r = installHooks({ hooksDir: dir, gremionUiRoot })
    expect(r.action).toBe('prepended')
    expect(readFileSync(p, 'utf8')).toContain(MARKER_BEGIN)
  })
})

describe('make lint-sh covers the shell artifacts this package ships', () => {
  const makefile = () => readFileSync(join(repoRoot, 'Makefile'), 'utf8')

  /** The recipe lines of one Makefile target (tab-indented). */
  function recipe(text: string, target: string): string {
    const lines = text.split('\n')
    const start = lines.findIndex((l) => l.startsWith(`${target}:`))
    expect(start, `Makefile has no ${target} target`).toBeGreaterThan(-1)
    const out: string[] = []
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith('\t')) break
      out.push(line)
    }
    return out.join('\n')
  }

  it('lints the versioned pre-commit hook', () => {
    // `scripts/*.sh` never matched it: the hook is extensionless and lives
    // under gremion-ui/. An unlinted shell artifact is how a hook that fails
    // closed acquires a syntax error nobody sees until a commit dies.
    expect(
      recipe(makefile(), 'lint-sh'),
      'the one shell file that gates every commit must be linted',
    ).toContain('gremion-ui/scripts/hooks/pre-commit')
  })

  it('control: the recipe parser really reads the shellcheck line', () => {
    expect(recipe(makefile(), 'lint-sh')).toContain('shellcheck')
  })
})
