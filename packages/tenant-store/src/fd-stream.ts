// packages/tenant-store/src/fd-stream.ts
//
// A Readable over an OPEN file descriptor that never closes it. fs.createReadStream destroys (and so closes) its
// descriptor whenever the stream is destroyed, `autoClose: false` or not; a pipeline that ends early (pg_restore --list
// reads only the TOC and exits, EPIPE) destroys its input, and that would close a descriptor the caller still means to
// use (the sha256 read of the same dump) or, once the number is reused, one that is somebody else's. This stream reads
// positionally from `start` (the descriptor's own offset is never touched, so the same descriptor can be read again) and
// leaves the closing to its owner. A destroy waits for a read that is in flight, so the owner may close right after.
import { read, write } from 'node:fs'
import { Readable, Writable } from 'node:stream'

const CHUNK = 64 * 1024

export function descriptorStream(fd: number, start = 0): Readable {
  let pos = start
  let inflight = false
  let onIdle: (() => void) | undefined
  return new Readable({
    read() {
      if (inflight) return
      inflight = true
      const buf = Buffer.allocUnsafe(CHUNK)
      read(fd, buf, 0, CHUNK, pos, (err, n) => {
        inflight = false
        if (onIdle) {
          const done = onIdle
          onIdle = undefined
          done()
          return
        }
        if (err) {
          this.destroy(err)
          return
        }
        if (n === 0) {
          this.push(null)
          return
        }
        pos += n
        this.push(buf.subarray(0, n))
      })
    },
    destroy(err, cb) {
      if (inflight) onIdle = () => cb(err)
      else cb(err)
    },
  })
}

/**
 * A Writable into an OPEN file descriptor that never closes it, the counterpart of descriptorStream: fs.createWriteStream
 * closes its descriptor whenever it is destroyed, so a pipeline that fails would close one the caller still holds. This
 * stream writes positionally from `start`, and a destroy waits for the write that is in flight, so the owner may close
 * the descriptor right after the stream has settled.
 */
export function descriptorSink(fd: number, start = 0): Writable {
  let pos = start
  let inflight = false
  let onIdle: (() => void) | undefined
  return new Writable({
    write(chunk: Buffer, _enc, cb) {
      let off = 0
      const step = (): void => {
        inflight = true
        write(fd, chunk, off, chunk.length - off, pos, (err, n) => {
          inflight = false
          if (onIdle) {
            const done = onIdle
            onIdle = undefined
            done()
            return
          }
          if (err) {
            cb(err)
            return
          }
          off += n
          pos += n
          if (off < chunk.length) step()
          else cb()
        })
      }
      step()
    },
    destroy(err, cb) {
      if (inflight) onIdle = () => cb(err)
      else cb(err)
    },
  })
}
