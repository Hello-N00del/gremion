// R33b: which surface the protocol body page shows for an editable draft.
// An ODT draft is the text that publish converts, so the in-app editor must
// never appear for a protocol that has one, even when the wopi token failed.

export type ProtocolBodyMode = 'collabora' | 'in-app' | 'unavailable' | 'readonly'

export function protocolBodyMode(i: {
  isEditable: boolean
  isAdmin: boolean
  hasWopiToken: boolean
  hasDraftDocument: boolean
}): ProtocolBodyMode {
  if (!i.isEditable) return 'readonly'
  if (i.hasWopiToken) return "collabora"
  if (!i.isAdmin) return 'readonly'
  return i.hasDraftDocument ? 'unavailable' : 'in-app'
}
