// Test portability helpers: the suite runs on Linux (CI, the proof host) and
// on the Windows gate box (verify's unit part `nats-auth`, make
// test-nats-auth). What Windows cannot show is SKIPPED WITH A NAMED REASON,
// never silently passed; each such case runs on Linux.
import path from 'node:path'

export const IS_WINDOWS = process.platform === 'win32'

/** Reason POSIX mode assertions (0600 seeds, 0700 dirs) are skipped, or false. */
export const NO_POSIX_MODES: string | false = IS_WINDOWS
  ? 'Windows keeps no POSIX mode bits (chmod 0600 reads back 0666); asserted on Linux'
  : false

/**
 * Reason the bash-driven cases (proof.sh's post-condition hook, the host
 * scripts' functions run in isolation) are skipped, or false. On Windows the
 * `bash` on PATH is the WSL launcher (no distro: every call fails), and Git
 * for Windows' bash starts in seconds per process on the loaded gate box
 * (`bash -c 'echo hi'` measured 9.1 s), so proof.sh's grep pipeline runs past
 * any sane test timeout. These scripts only ever run on Linux hosts.
 */
export const NO_POSIX_BASH: string | false = IS_WINDOWS
  ? 'the scripts under test run on Linux hosts only; Windows has no usable bash for them (WSL launcher without a distro, Git bash seconds per fork)'
  : false

/** A path as a POSIX shell (and the repo's relative-path contract) spells it. */
export const posix = (p: string): string => p.split(path.sep).join('/')

/** Text as committed: LF, whatever core.autocrlf did to the checkout. */
export const lf = (s: string): string => s.replace(/\r\n/g, '\n')
