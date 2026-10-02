#!/usr/bin/env node
// smtp-sink.mjs — a scratch SMTP receiver for the customer-admins REHEARSAL of
// customer-provision-proof.sh (plain `docker run` of the pinned node image,
// never on a host). It accepts every message on port 2525 and writes each one,
// exactly as submitted (the DATA section, dot-unstuffed), to /out/<n>.eml, so
// the proof reads the RAW message Keycloak wrote -- the same bytes the vendor
// Stalwart would store. No TLS, no AUTH: it stands in for the delivery end
// only; the sender binding (kc-<token>@) is asserted on the From header.
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'

const OUT = process.env.SINK_DIR || '/out'
let n = 0
createServer((sock) => {
  sock.setEncoding('latin1')
  let buf = ''
  let data = null
  const say = (l) => sock.write(`${l}\r\n`)
  say('220 t043-sink ESMTP')
  sock.on('data', (chunk) => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 2)
      if (data !== null) {
        if (line === '.') {
          n += 1
          writeFileSync(`${OUT}/${String(n).padStart(4, '0')}.eml`, Buffer.from(data.join('\r\n') + '\r\n', 'latin1'), { mode: 0o644 })
          data = null
          say('250 2.0.0 stored')
        } else data.push(line.startsWith('..') ? line.slice(1) : line)
        continue
      }
      const verb = line.slice(0, 4).toUpperCase()
      if (verb === 'EHLO') {
        sock.write('250-t043-sink\r\n250 8BITMIME\r\n')
      } else if (verb === 'HELO' || verb === 'MAIL' || verb === 'RCPT' || verb === 'RSET' || verb === 'NOOP') say('250 2.0.0 ok')
      else if (verb === 'DATA') {
        data = []
        say('354 end with .')
      } else if (verb === 'QUIT') {
        say('221 2.0.0 bye')
        sock.end()
      } else say('502 5.5.2 not implemented')
    }
  })
  sock.on('error', () => {})
}).listen(2525, '0.0.0.0', () => console.log('smtp-sink listening on 2525'))
