// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-nocheck is intentional: a unit test imports this untyped Node script, pulling it into the svelte-check program where checkJs+strict would flag untyped params and ESM-only node: imports.
// @ts-nocheck — standalone node build script (invoked via CLI or imported by unit
// test); svelte-check/checkJs would flag untyped params and ESM-only node: imports.
// gremion-ui/scripts/install-git-hooks.mjs
// Installs/updates the pre-commit boundary-lint hook into the ONE directory git
// reads hooks from in this worktree. Idempotent.
//
// The single post-condition this script enforces:
//
//     the directory written == `git rev-parse --git-path hooks`
//
// Every way of getting that wrong is a variation on one shape — a relative
// core.hooksPath resolved against the installer's cwd, a leading `~` taken
// literally, an inherited global value git obeys and the installer does not, a
// per-worktree value the installer cannot see, `--hooks-dir` overriding all of
// it unconditionally. In each the hook lands somewhere git never looks, and the
// installer reports success. Asking git the one question it alone can answer,
// and REFUSING when the answer disagrees, closes the class rather than the
// instance.
//
// CLI: node gremion-ui/scripts/install-git-hooks.mjs
import { spawnSync } from 'node:child_process'
import {
  readFileSync, writeFileSync, chmodSync, mkdirSync, lstatSync, renameSync, realpathSync, rmSync,
} from 'node:fs'
import { join, dirname, resolve, isAbsolute, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKER_BEGIN = '# >>> sturaos-boundary-lint >>>'
export const MARKER_END = '# <<< sturaos-boundary-lint <<<'

/** Repo-relative path of the versioned hook the wrapper delegates to. */
const DELEGATE = 'gremion-ui/scripts/hooks/pre-commit'

/** The managed block delegates to the VERSIONED hook in the committing
 *  worktree, and FAILS CLOSED when it cannot.
 *
 *  The original wrapper wrapped the delegation in `if [ -f … ]; then … fi` so
 *  a worktree without the versioned hook would fall through silently. That
 *  tolerance is how this class of guard dies: after a directory rename the test
 *  is permanently false, so every installed hook is present, executable and
 *  enforcing nothing. An unreachable delegate is now a blocked commit with an
 *  instruction, one level up from the delegate's own fail-closed paths.
 *  `git commit --no-verify` remains the single VISIBLE bypass — that is what a
 *  genuinely older checkout uses, and it leaves a trace. */
function managedBlock() {
  return [
    MARKER_BEGIN,
    '# Managed by gremion-ui/scripts/install-git-hooks.mjs — do not edit between markers.',
    '# FAILS CLOSED: a wrapper that cannot reach its delegate blocks the commit with',
    '# an instruction. Falling through silently is how this guard dies.',
    'if ! GREMION_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then',
    '  echo "[boundary-lint] commit blocked: could not locate the repo root (git rev-parse --show-toplevel failed), so no boundary lint ran." >&2',
    '  echo "[boundary-lint] Commit from inside a checkout of this repository. Deliberate bypass: git commit --no-verify." >&2',
    '  exit 1',
    'fi',
    `if [ ! -f "$GREMION_ROOT/${DELEGATE}" ]; then`,
    `  echo "[boundary-lint] commit blocked: $GREMION_ROOT/${DELEGATE} is missing, so no boundary lint ran." >&2`,
    '  echo "[boundary-lint] If this checkout PREDATES the versioned hook (an old tag, a bisect step, a maintenance branch), commit with: git commit --no-verify." >&2',
    '  echo "[boundary-lint] Otherwise the installed hook is stale or the tree was renamed — reinstall it with: node gremion-ui/scripts/install-git-hooks.mjs" >&2',
    '  exit 1',
    'fi',
    `sh "$GREMION_ROOT/${DELEGATE}" "$@" || exit $?`,
    MARKER_END,
  ].join('\n')
}

/** Interpreters the managed block (POSIX sh code) is valid inside. */
const SHELL_INTERPRETERS = new Set([
  'sh', 'bash', 'dash', 'ash', 'ksh', 'ksh93', 'mksh', 'pdksh', 'zsh', 'busybox',
])

/** The interpreter a shebang selects, or null when the file has no shebang
 *  (git runs an extensionless hook with sh, so "no shebang" means sh). */
function shebangInterpreter(text) {
  if (!text.startsWith('#!')) return null
  const nl = text.indexOf('\n')
  const words = text.slice(2, nl === -1 ? undefined : nl).trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const leaf = (w) => basename(w.split('\\').join('/')).replace(/\.exe$/i, '')
  let cmd = leaf(words[0])
  if (cmd === 'env') {
    // `#!/usr/bin/env -S python3 -u` — skip env's own flags and VAR=value pairs.
    const arg = words.slice(1).find((w) => !w.startsWith('-') && !w.includes('='))
    if (!arg) return null
    cmd = leaf(arg)
  }
  return cmd
}

/**
 * The way forward after a refusal.
 *
 * Remedy 2 is deliberately NOT `--hooks-dir <dir>`, i.e. "install it somewhere
 * else". Somewhere else is somewhere git does not read hooks from, so that
 * remedy PRODUCES the installed-looking/enforcing-nothing state this whole
 * guard exists to prevent. Moving the REPOSITORY's hooks dir is the honest
 * version: git and this installer then still agree.
 */
function remedyLines(hookPath) {
  return [
    'Remedies (pick one, then re-run this installer):',
    `  1. move it aside — mv "${hookPath}" "${hookPath}.local" — and call the saved hook from the end of the generated wrapper;`,
    '  2. point this REPOSITORY at another hooks dir — git config --local core.hooksPath "<absolute dir>" — so git reads the hook this installer writes;',
    `  3. delete "${hookPath}" if it is obsolete.`,
  ]
}

/**
 * A foreign hook that is NOT a shell script is REFUSED, not rewritten.
 *
 * Prepending /bin/sh code to a python3 or node hook produces a file that is a
 * syntax error for its own interpreter: the foreign hook stops working AND
 * every commit in that clone dies on a file this installer mangled. There is
 * no safe automatic merge, so the installer stops before touching a byte and
 * hands over the remedies instead.
 */
function assertShellHook(hookPath, current) {
  const interpreter = shebangInterpreter(current)
  if (interpreter === null || SHELL_INTERPRETERS.has(interpreter)) return
  throw new Error(
    [
      `refusing to modify ${hookPath}: its shebang selects "${interpreter}", which is not a POSIX shell.`,
      'The managed block is /bin/sh code; prepending it would make the hook a syntax error for its own interpreter — the existing hook would stop working and every commit here would die on a file this installer wrote. Nothing was changed.',
      ...remedyLines(hookPath),
    ].join('\n'),
  )
}

/**
 * A pre-commit hook may legitimately be a compiled binary or text in a
 * non-UTF-8 encoding; git only requires an executable file.
 * `readFileSync(…, 'utf8')` replaces every byte it cannot decode with U+FFFD,
 * so the read-modify-write cycle DESTROYS such a file — silently, and while
 * reporting `prepended:`. A Latin-1 hook is the nastier case: its `#!/bin/sh`
 * shebang passes every other check, so nothing else stands between it and a
 * lossy rewrite. Refuse before the bytes are ever treated as text.
 */
function assertUtf8TextHook(hookPath, buf) {
  const isElf =
    buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46
  const hasNul = buf.includes(0)
  const lossy = !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
  if (!isElf && !hasNul && !lossy) return
  const what = isElf
    ? 'it is an ELF binary'
    : hasNul
      ? 'it is binary — it contains NUL bytes'
      : 'it is not valid UTF-8 text (a non-UTF-8 encoding such as Latin-1)'
  throw new Error(
    [
      `refusing to modify ${hookPath}: ${what}.`,
      'This installer reads a hook as UTF-8 text and writes it back. Every undecodable byte would come back as U+FFFD, so the existing hook would be silently corrupted by an install that reported success. Nothing was changed.',
      ...remedyLines(hookPath),
    ].join('\n'),
  )
}

/**
 * A hook with CRLF line endings is REFUSED, not rewritten.
 *
 * The installer keeps the foreign shebang verbatim as line 1 and writes the
 * managed block with LF. On a CRLF hook that line is `#!/bin/sh<CR>`, so POSIX
 * resolves an interpreter literally named `/bin/sh\r`: the file does not
 * execute at all, and the wrapper's fail-closed branches — the entire point of
 * this installer — never run, while the install reports `prepended:`. The
 * result is the installed-looking/enforcing-nothing state one level deeper than
 * before, because now it is this installer that produced it.
 *
 * `assertShellHook` cannot catch it: the shebang line is `.trim()`ed before the
 * interpreter is read, so a CR is stripped and `sh` looks perfectly ordinary.
 * The endings are therefore checked on their own, and the remedy is to
 * normalise them rather than to have the installer rewrite bytes it was not
 * asked to rewrite.
 */
function assertLfTextHook(hookPath, current) {
  if (!current.includes('\r\n')) return
  throw new Error(
    [
      `refusing to modify ${hookPath}: it has CRLF line endings.`,
      'The managed block is written with LF and the existing shebang is kept as line 1, so the result would be a file whose interpreter line still ends in a carriage return — POSIX would look for "/bin/sh\\r", the hook would not execute at all, and this installer would have reported success. Nothing was changed.',
      `Convert it to LF first — dos2unix "${hookPath}" (or: sed -i 's/\\r$//' "${hookPath}") — then re-run this installer.`,
      ...remedyLines(hookPath),
    ].join('\n'),
  )
}

/**
 * Writing through a SYMLINK writes to its target, which can be outside the
 * hooks dir entirely: the installer would report a path whose bytes live
 * somewhere else, and `existsSync` follows links, so a DANGLING one reads as
 * "no hook here" and the file gets created at the target instead. Neither is a
 * state anyone can reason about; refuse and let a human decide.
 */
function assertNotSymlink(hookPath, stats) {
  if (!stats.isSymbolicLink()) return
  throw new Error(
    [
      `refusing to modify ${hookPath}: it is a symlink.`,
      'Writing through a symlink writes to its TARGET — possibly outside this hooks dir — so the installer would report a path that does not hold the bytes it wrote. Nothing was changed.',
      ...remedyLines(hookPath),
    ].join('\n'),
  )
}

/** True when MARKER_BEGIN is preceded only by a shebang, blank lines and
 *  comments — i.e. by nothing that can exit before the block runs. */
function blockIsAtFront(text) {
  return text
    .slice(0, text.indexOf(MARKER_BEGIN))
    .split('\n')
    .every((l) => l.trim() === '' || l.trim().startsWith('#'))
}

/** Cut the managed block out — markers included, plus its trailing newline. */
function stripManagedBlock(text, endIdx) {
  const start = text.indexOf(MARKER_BEGIN)
  return text.slice(0, start) + text.slice(endIdx + MARKER_END.length).replace(/^\n/, '')
}

/**
 * A pre-existing FOREIGN hook is PREPENDED to, never appended after.
 *
 * Appending puts the managed block behind whatever the foreign hook already
 * did, and a foreign hook that ends in `exit 0` (husky's classic shim, most
 * hand-written hooks) makes every fail-closed branch above unreachable while
 * the installer still reports success — the silent-skip defect verbatim,
 * arriving through a supported install path. The foreign shebang is kept as
 * line 1 (it selects the interpreter) and the foreign body is preserved
 * verbatim after the managed block, so an existing hook still runs on a commit
 * that passes the boundary lint.
 */
function prependBlock(current, block) {
  const nl = current.indexOf('\n')
  const firstLine = nl === -1 ? current : current.slice(0, nl)
  const hasShebang = firstLine.startsWith('#!')
  const head = hasShebang ? `${firstLine}\n` : ''
  const body = (hasShebang ? current.slice(nl === -1 ? current.length : nl + 1) : current).replace(
    /^\n+/,
    '',
  )
  return `${head}${block}\n${body}`.replace(/\n?$/, '\n')
}

/**
 * The tail an EARLIER GENERATION of this installer left behind.
 *
 * An existing clone's hook is `#!/bin/sh` + the old managed block + a bare
 * `exit 0`, because that is what the wrapper of the day ended in. The
 * marker-replacement path rewrites only what lies BETWEEN the markers, so the
 * upgrade every existing developer performs would carry that `exit 0` forward
 * into the hardened hook — the exact statement this guard exists to keep out of
 * an installed hook, surviving inside the artifact the fix produces.
 *
 * Only blank/comment/`exit 0` lines qualify: a tail with any real statement is
 * a developer's own hook body and is preserved verbatim.
 */
function tailIsInstallerGenerated(tail) {
  return tail
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .every((l) => l.startsWith('#') || /^exit\s+0$/.test(l))
}

/**
 * Temp + chmod + rename, in the hook's OWN directory.
 *
 * `writeFileSync` truncates the live hook before it writes a byte, so an
 * install that fails partway (a chmod that throws, a full disk, a killed
 * process) replaces a working guard with a truncated or 0644 file — which git
 * either ignores outright or runs as garbage. A rename within one directory is
 * a single atomic operation: the hook is the old one or the new one, never
 * half of each, and the exec bit is already on the bytes before they become
 * `pre-commit`.
 */
function writeHookAtomically(hookPath, text, chmod) {
  const tmp = `${hookPath}.install-tmp-${process.pid}`
  writeFileSync(tmp, text)
  // The exec bit is not cosmetic: git SILENTLY IGNORES a non-executable hook on
  // POSIX ("hint: … was ignored because it's not set as executable") and the
  // commit proceeds — installed-looking, enforcing nothing.
  try {
    chmod(tmp, 0o755)
  } catch (err) {
    // Swallowing this leaves a 0644 hook that git ignores — installed, and
    // enforcing nothing. Always say so; on POSIX it is fatal.
    console.error(
      `[install-git-hooks] WARNING: could not set the executable bit on ${hookPath}: ${err?.code ?? err?.message ?? err}`,
    )
    if (process.platform !== 'win32') {
      console.error(
        '[install-git-hooks] git SILENTLY IGNORES a non-executable hook on POSIX, so this install would enforce nothing. Fix the permissions and re-run.',
      )
      rmSync(tmp, { force: true })
      throw err
    }
    console.error(
      '[install-git-hooks] Windows does not consult the exec bit, so the hook still runs here — but a POSIX checkout of this hooks dir would ignore it.',
    )
  }
  try {
    renameSync(tmp, hookPath)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

export function installHooks({ hooksDir, gremionUiRoot: _gremionUiRoot, chmod = chmodSync }) {
  const hookPath = join(hooksDir, 'pre-commit')
  const block = managedBlock()
  // git does NOT create a configured core.hooksPath directory; writing into a
  // missing one would fail with ENOENT.
  mkdirSync(hooksDir, { recursive: true })
  // lstat, not existsSync: existsSync FOLLOWS a symlink, so a dangling one
  // reads as "absent" and the hook would be created at the link's target.
  let stats = null
  try {
    stats = lstatSync(hookPath)
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err
  }
  let action
  let text
  if (stats === null) {
    // No trailing `exit 0`: the block's own exit IS the wrapper's exit. A bare
    // `exit 0` at the foot of a hook is the shape this whole guard exists to
    // kill, and the suite's detector is applied to this generated wrapper.
    text = `#!/bin/sh\n${block}\n`
    action = 'created'
  } else {
    // Every refusal below is decided BEFORE the single write at the foot of
    // this function, so a hook the installer refuses is left byte-identical.
    assertNotSymlink(hookPath, stats)
    const buf = readFileSync(hookPath)
    assertUtf8TextHook(hookPath, buf)
    const current = buf.toString('utf8')
    assertShellHook(hookPath, current)
    assertLfTextHook(hookPath, current)
    if (current.includes(MARKER_BEGIN)) {
      const start = current.indexOf(MARKER_BEGIN)
      const endIdx = current.indexOf(MARKER_END)
      if (endIdx === -1) {
        throw new Error(
          `${hookPath} contains ${MARKER_BEGIN} but no ${MARKER_END} — it was hand-edited. Remove the managed block (or the file) and re-run the installer.`,
        )
      }
      if (blockIsAtFront(current)) {
        // Replace the substring between (and including) the markers, and drop
        // a tail this installer wrote in an earlier generation.
        const tail = current.slice(endIdx + MARKER_END.length)
        text = current.slice(0, start) + block + (tailIsInstallerGenerated(tail) ? '\n' : tail)
        action = 'updated'
      } else {
        // An APPEND-era install left the managed block BEHIND the foreign body,
        // and therefore behind its `exit 0`. Rewriting it where it sits keeps
        // it unreachable while reporting `updated`, so re-running the installer
        // (the documented remedy for a stale hook) would fix nothing. Cut it
        // out and prepend it afresh.
        text = prependBlock(stripManagedBlock(current, endIdx), block)
        action = 're-prepended'
      }
    } else {
      text = prependBlock(current, block)
      action = 'prepended'
    }
  }
  writeHookAtomically(hookPath, text, chmod)
  return { action, hookPath }
}

// ---- CLI ----

/**
 * A git invocation, with its exit code kept.
 *
 * Collapsing every non-zero exit to null makes "this config key is UNSET"
 * (exit 1) indistinguishable from "git could not read its config at all"
 * (exit 128). A broken environment then looks exactly like the default one and
 * the installer diagnoses the wrong thing entirely. `status` is null when git
 * could not even be spawned.
 */
function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) return { status: null, stdout: '', stderr: String(r.error.message) }
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
}

/** `git …` stdout, or null when git did not answer. Only for calls where a
 *  non-zero exit genuinely means "no answer" and the caller says so. */
function gitOut(args) {
  const r = git(args)
  return r.status === 0 ? r.stdout : null
}

function fail(...lines) {
  for (const l of lines) console.error(`[install-git-hooks] ${l}`)
  process.exit(2)
}

/** `--hooks-dir <dir>` and `--hooks-dir=<dir>`; a following flag is rejected
 *  rather than taken as a directory name (mkdirSync would happily create it).
 *  The value is an ASSERTION about where git reads hooks from, not an
 *  override; see the check at the CLI entrypoint. */
function parseHooksDirArg(argv) {
  const eq = argv.find((a) => a.startsWith('--hooks-dir='))
  if (eq) {
    const value = eq.slice('--hooks-dir='.length)
    if (!value) fail('--hooks-dir=<dir> needs a directory argument')
    return value
  }
  const idx = argv.indexOf('--hooks-dir')
  if (idx === -1) return null
  const value = argv[idx + 1]
  if (!value || value.startsWith('-')) fail('--hooks-dir needs a directory argument')
  return value
}

/** Compare two paths the way the filesystem does — Windows hands out 8.3 SHORT
 *  forms that name the same directory as their long twin, so a raw string
 *  compare is a false negative. */
function samePath(a, b) {
  const norm = (p) => {
    let n = resolve(p)
    try {
      n = realpathSync.native(n)
    } catch {
      // The directory may not exist yet — the lexical form is the best answer.
    }
    n = n.split('\\').join('/').replace(/\/+$/, '')
    return process.platform === 'win32' ? n.toLowerCase() : n
  }
  return norm(a) === norm(b)
}

/**
 * core.hooksPath together with the SCOPE it came from.
 *
 * Reading `--local` first and falling back to a scopeless `--get` cannot tell a
 * per-worktree value from a machine-wide one. A legitimate
 * `git config --worktree core.hooksPath` would then be classified as "set
 * OUTSIDE this repository" and refused — the installer unusable in exactly the
 * linked worktrees that need it. `--show-scope` answers the question directly.
 */
function readHooksPathConfig() {
  const r = git(['config', '--show-scope', '--get', 'core.hooksPath'])
  if (r.status === 1) return { state: 'unset' }
  if (r.status !== 0) {
    fail(
      `git failed while reading core.hooksPath (git exited ${r.status === null ? 'without running' : r.status}).`,
      `git said: ${r.stderr || '(nothing on stderr)'}`,
      'Exit 1 would mean the key is UNSET; any other exit means git itself could not answer. Treating that as "unset" would install into a directory git may never read, so nothing was changed. Fix the git error above and re-run.',
    )
  }
  const tab = r.stdout.indexOf('\t')
  if (tab === -1) {
    fail(
      `could not parse the scope of core.hooksPath from git's answer: ${JSON.stringify(r.stdout)}`,
      'Expected `<scope>\\t<value>` from: git config --show-scope --get core.hooksPath',
    )
  }
  return { state: 'set', scope: r.stdout.slice(0, tab).trim(), value: r.stdout.slice(tab + 1).trim() }
}

/** The absolute `hooks/` of the git COMMON dir — shared by every worktree of
 *  this clone, and therefore the right value for a `core.hooksPath` remedy. */
function commonDirHooks() {
  // git prints --git-common-dir relative to the cwd; resolve() handles that.
  const commonDir = gitOut(['rev-parse', '--git-common-dir'])
  return commonDir === null ? null : resolve(commonDir, 'hooks')
}

/**
 * THE directory git reads hooks from — git's own answer, not a reconstruction.
 *
 * `git rev-parse --git-path hooks` already applies every rule an installer
 * would otherwise re-implement one at a time: core.hooksPath wins over the
 * common dir, a leading `~` is expanded against the home directory, a relative
 * value is resolved against this worktree, and a linked worktree gets its own
 * answer. It is printed relative to the cwd, so resolve() finishes the job.
 */
function gitHooksPath() {
  const raw = gitOut(['rev-parse', '--git-path', 'hooks'])
  if (raw === null) {
    fail(
      'not inside a git repository — run this from a checkout of this repository.',
      'The hook must be installed into the directory `git rev-parse --git-path hooks` names; outside a repository there is no such directory.',
    )
  }
  return resolve(process.cwd(), raw)
}

function resolveHooksDir() {
  const configured = readHooksPathConfig()
  if (configured.state === 'set' && (configured.scope === 'global' || configured.scope === 'system')) {
    // Warning + installing into the repo's own hooks dir with exit 0 is itself
    // the defect: git obeys the INHERITED value, so that hook never runs — and
    // the `created:` line plus the zero exit tell every caller it was installed.
    const shared = commonDirHooks()
    fail(
      `core.hooksPath is set OUTSIDE this repository (${configured.scope} value: ${configured.value}) and this repository has no local or per-worktree override.`,
      'Refusing to install. That directory is shared by EVERY repository on this machine and this wrapper fails closed, so installing there would block commits in unrelated repos with a remediation command that cannot be run from them.',
      "Installing into this repo's own hooks dir is not a fallback either: git obeys the inherited value, so that hook would never run — installed-looking and enforcing nothing.",
      // An ABSOLUTE value, never a bare `.git/hooks` literal: git resolves a
      // relative core.hooksPath against EACH worktree's own top level, where
      // `.git` is a FILE, not a hooks dir.
      shared === null
        ? 'Give this repository its own hooks dir first:  git config --local core.hooksPath "<absolute path to this clone\'s hooks dir>"'
        : `Give this repository its own hooks dir first:  git config --local core.hooksPath "${shared}"`,
      'Then re-run:  node gremion-ui/scripts/install-git-hooks.mjs',
      `Or drop the machine-wide value:  git config --${configured.scope} --unset core.hooksPath`,
    )
  }
  if (configured.state === 'set' && !isAbsolute(configured.value) && !configured.value.startsWith('~')) {
    // git resolves a RELATIVE hooksPath against each worktree's own top level,
    // so linked worktrees do NOT share the installed hook — one install does
    // not cover them, and an uninstalled worktree commits unguarded.
    console.error(
      `[install-git-hooks] NOTE: core.hooksPath is the RELATIVE path "${configured.value}". git resolves it against EACH worktree's own top level, so LINKED WORKTREES DO NOT SHARE this hook — every worktree needs its own install. Set an absolute path (git config --local core.hooksPath "<absolute dir>") if you want one shared hooks dir.`,
    )
  }
  return gitHooksPath()
}

// Use the simpler endsWith form — the URL comparison can misbehave on Windows paths.
const isMain = process.argv[1]?.endsWith('install-git-hooks.mjs')
if (isMain) {
  const gremionUiRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const hooksDir = resolveHooksDir()
  // `--hooks-dir` is not an override, only an assertion. As an unconditional
  // override it is how a hook lands where git does not look while the installer
  // reports success. It is accepted when it names the same directory git does,
  // and refused otherwise.
  const requested = parseHooksDirArg(process.argv.slice(2))
  if (requested !== null && !samePath(requested, hooksDir)) {
    fail(
      `--hooks-dir "${requested}" is not the directory git reads hooks from, so a hook installed there would never run.`,
      `git reads hooks from: ${hooksDir}`,
      'Refusing to install. A hook outside that directory is installed-looking and enforcing nothing — the failure this guard exists to prevent.',
      `To make git read another directory, tell GIT first:  git config --local core.hooksPath "${requested}"`,
      'Then re-run:  node gremion-ui/scripts/install-git-hooks.mjs',
    )
  }
  let r
  try {
    r = installHooks({ hooksDir, gremionUiRoot })
  } catch (err) {
    // A refusal must exit non-zero and print the reason as guidance, not as a
    // stack trace — and must NOT be followed by a line claiming an install.
    fail(...String(err?.message ?? err).split('\n'))
  }
  // The post-condition, re-checked against git after the write: whatever was
  // reported installed must live where git looks. Nothing may print a success
  // line that has not been confirmed by the one authority on the question.
  const authoritative = gitHooksPath()
  if (!samePath(dirname(r.hookPath), authoritative)) {
    fail(
      `POST-CONDITION FAILED: the hook was written to ${dirname(r.hookPath)}, but git reads hooks from ${authoritative}.`,
      'That hook would never run. Re-run this installer; if it keeps happening, core.hooksPath changed underneath it.',
    )
  }
  console.log(`[install-git-hooks] ${r.action}: ${r.hookPath}`)
}
