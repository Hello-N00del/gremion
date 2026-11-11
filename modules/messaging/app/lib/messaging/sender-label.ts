// How a message sender is shown. Pure and import-free: the messages page uses it in the browser,
// the sender-name resolver on the server.
//
// A sender is a Matrix id. Synapse takes the localpart from the Keycloak username, and the
// username of an invited user is their address with every other character encoded as _hh, so a raw
// id such as @max.mustermann_40example.org:matrix.example.org carries an address. The label shown
// to other people is therefore a name, never the id and never an address.

const UNKNOWN = 'Unbekannt'

/** The part of a Matrix id between the leading @ and the first colon. */
export function localpartOf(userId: string): string {
  const withoutAt = userId.startsWith('@') ? userId.slice(1) : userId
  const colon = withoutAt.indexOf(':')
  return colon === -1 ? withoutAt : withoutAt.slice(0, colon)
}

/** Undo the _hh encoding of a Keycloak username (UTF-8 bytes, lower-case hex). */
export function decodeUsername(localpart: string): string {
  return localpart.replace(/(?:_[0-9a-f]{2})+/g, (run) => {
    const bytes = Uint8Array.from(run.match(/[0-9a-f]{2}/g) ?? [], (h) => parseInt(h, 16))
    return new TextDecoder('utf-8').decode(bytes)
  })
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** A readable name from the id alone: the address part before the @, split at . _ -, capitalised. */
export function fallbackSenderName(userId: string): string {
  const decoded = decodeUsername(localpartOf(userId ?? ''))
  const beforeAt = decoded.split('@')[0] ?? ''
  const words = beforeAt.split(/[._\-\s]+/).filter(Boolean).map(titleCase)
  return words.length > 0 ? words.join(' ') : UNKNOWN
}

/** True when a candidate display name is usable as shown: not empty, not a Matrix id, not an address. */
export function isShowableName(name: string | null | undefined): name is string {
  if (!name) return false
  const trimmed = name.trim()
  if (!trimmed) return false
  if (/^@[^:\s]*:\S+$/.test(trimmed)) return false
  if (/\S+@\S+/.test(trimmed)) return false
  return true
}

/** The label for one message: the display name when it is a real name, else the readable fallback. */
export function senderLabel(sender: string, displayName: string | null | undefined): string {
  return isShowableName(displayName) ? displayName.trim() : fallbackSenderName(sender)
}

export function senderInitials(label: string): string {
  const words = label.split(/[\s._\-]+/).filter(Boolean)
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase()
  return label.slice(0, 2).toUpperCase()
}
