/**
 * The local-setup preflight (TASK-028, D1; TRD-099).
 *
 * A fresh clone carries neither `.env` nor `legal/legal.env`: both are
 * git-ignored and written by `scripts/setup.sh`. Any check that renders the
 * dev composition or the dev kustomize overlay without them fails -- and the
 * failure used to be read as a finding. The app-port binding check reported
 * "2 non-loopback gremion-ui binding(s)", a security-invariant failure that had
 * measured nothing at all.
 *
 * So the question "is this working copy set up?" is answered HERE, from the
 * file system, BEFORE any render, and both callers
 * (gremion-ui/scripts/check-app-port-binding.mjs and the hygiene check's g2)
 * ask it first. The stderr regexes those callers used to rely on stay only as
 * a second net.
 *
 * NARROW ON PURPOSE: a file counts as missing only when NOTHING exists at its
 * path. A directory or an unreadable file at `.env` is not "not set up", it is
 * broken, and the render that follows must be allowed to say so -- a
 * setup-first message there would mask a real error.
 */

import { lstatSync, statSync } from 'node:fs'
import path from 'node:path'

/** The git-ignored files `scripts/setup.sh` writes, relative to the repo root. */
export const LOCAL_ENV_FILES = Object.freeze(['.env', 'legal/legal.env'])

/** The exact instruction every setup-first message carries (pinned by tests). */
export const SETUP_FIRST = 'run scripts/setup.sh first'

function absent(abs) {
  try {
    lstatSync(abs)
  } catch (err) {
    if (err && err.code === 'ENOENT') return true
    throw err
  }
  // A symlink whose target is gone is as absent as no file: compose and
  // kustomize both fail to open it. Any other stat error is re-thrown.
  try {
    statSync(abs)
    return false
  } catch (err) {
    if (err && err.code === 'ENOENT') return true
    throw err
  }
}

/**
 * The LOCAL_ENV_FILES that do not exist under `root`, in declaration order.
 * An empty array means the working copy is set up; anything else means no
 * render may be attempted and the caller must say "run setup first".
 *
 * @param {string} root the repository root
 * @returns {string[]}
 */
export function missingLocalEnvFiles(root) {
  if (typeof root !== 'string' || root === '') {
    throw new TypeError('missingLocalEnvFiles: root must be a non-empty path')
  }
  return LOCAL_ENV_FILES.filter((rel) => absent(path.join(root, rel)))
}
