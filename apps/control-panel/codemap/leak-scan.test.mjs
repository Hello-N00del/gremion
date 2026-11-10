// leak-scan.mjs: the kernel repo is public. Every sample below is built from parts or from documentation
// values, so that this file holds no real address, host name or credential itself.
import { describe, expect, it } from 'vitest'
import { findLeaks } from './leak-scan.mjs'

const rules = (s) => findLeaks(s).map((l) => l.rule)

describe('findLeaks', () => {
  it('a clean text and an empty text pass', () => {
    expect(findLeaks('')).toEqual([])
    expect(findLeaks('The map shows 1200 functions. Open the file gremion-ui/src/hooks.server.ts.')).toEqual([])
  })

  it('an IPv4 address is a leak, except 127.0.0.1 and 0.0.0.0', () => {
    expect(rules(`host ${['203', '0', '113', '7'].join('.')} here`)).toEqual(['ipv4'])
    expect(rules(`bind ${['10', '0', '0', '4'].join('.')}`)).toEqual(['ipv4'])
    expect(rules('listen 127.0.0.1:3000 and 0.0.0.0')).toEqual([])
  })

  it('a version string is not an address', () => {
    expect(rules('version 1.2.3 and 10.2.3.4.5 and 999.1.1.1')).toEqual([])
  })

  it('a domain name is a leak for the listed endings', () => {
    for (const tld of ['de', 'com', 'org', 'net', 'io', 'eu', 'cloud']) expect(rules(`see panel.demo-host.${tld} now`)).toEqual(['domain'])
    expect(rules('see https://www.demo-host.de/path')).toEqual(['domain'])
  })

  it('example.* and the two schema hosts are allowed', () => {
    expect(rules('use example.com, a.example.org or example.de')).toEqual([])
    expect(rules('xmlns http://www.w3.org/2000/svg and schema.org')).toEqual([])
  })

  it('a file-name shape is not a domain', () => {
    expect(rules('docker-compose.app.dev.yml and docker-compose.prod.yml')).toEqual([])
    expect(rules('compose.cloud.yml, settings.io.ts, locale.de.json, a.net.ts')).toEqual([])
    expect(rules('apps/control-panel/src/lib/server/codemap.test.ts')).toEqual([])
  })

  it('a sentence that ends with a domain is still a leak', () => {
    expect(rules('the host is panel.demo-host.de. Next sentence.')).toEqual(['domain'])
  })

  it('a PEM header is a leak', () => {
    expect(rules('x ' + '-----BEGIN' + ' PRIVATE KEY-----')).toEqual(['pem'])
  })

  it('known token prefixes are leaks', () => {
    expect(rules('t ' + 'ghp_' + 'a'.repeat(20))).toEqual(['token'])
    expect(rules('t ' + 'github_pat_' + 'a'.repeat(20))).toEqual(['token'])
    expect(rules('t ' + 'AKIA' + 'A'.repeat(16))).toEqual(['token'])
    expect(rules('t ' + 'xoxb' + '-123456-abcdef')).toEqual(['token'])
    expect(rules('t ' + 'xoxp' + '-123456-abcdef')).toEqual(['token'])
  })

  it('a JWT is a leak', () => {
    expect(rules('t ' + ['eyJhbGciOiJub25lIn0', 'eyJzdWIiOiJ4In0', 'c2ln'].join('.'))).toEqual(['jwt'])
  })

  it('password= and secret= with a real value are leaks, with a placeholder they are not', () => {
    expect(rules('password=' + 'hunter22')).toEqual(['credential'])
    expect(rules('SECRET="' + 'abcd1234efgh' + '"')).toEqual(['credential'])
    expect(rules('secret = ' + 'abcd1234efgh')).toEqual(['credential'])
    expect(rules('password=')).toEqual([])
    expect(rules('password=<your password>')).toEqual([])
    expect(rules('password=${PASSWORD}')).toEqual([])
    expect(rules('password=$PGPASSWORD')).toEqual([])
    expect(rules('secret=changeme')).toEqual([])
    expect(rules('password=xxxx')).toEqual([])
    expect(rules('password=********')).toEqual([])
  })

  it('a local path is a leak', () => {
    expect(rules('at ' + 'C:' + '/Users' + '/someone/project')).toEqual(['local-path'])
    expect(rules('at ' + '/home' + '/someone/project')).toEqual(['local-path'])
  })

  it('a Windows path is a leak as a raw string, as JSON text, and in any letter case', () => {
    const bs = String.fromCharCode(92)
    const raw = ['C:', 'Users', 'someone', 'x'].join(bs)
    expect(rules(raw)).toEqual(['local-path'])
    expect(rules(JSON.stringify({ p: raw }))).toEqual(['local-path'])
    expect(rules(JSON.stringify(JSON.stringify({ p: raw })))).toEqual(['local-path'])
    expect(rules('at ' + 'c:' + '/users' + '/someone/project')).toEqual(['local-path'])
    expect(rules('at ' + 'D:' + bs + 'USERS' + bs + 'someone')).toEqual(['local-path'])
  })

  it('returns the rule and a sample, one entry for each hit', () => {
    const l = findLeaks(`a ${['203', '0', '113', '7'].join('.')} b ${['198', '51', '100', '9'].join('.')}`)
    expect(l).toHaveLength(2)
    expect(l[0]).toMatchObject({ rule: 'ipv4', sample: ['203', '0', '113', '7'].join('.') })
  })

})
