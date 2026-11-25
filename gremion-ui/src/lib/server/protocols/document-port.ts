// The protocol document port, as the CURRENT tenant may use it.
//
// The files module registers ONE ProtocolDocumentPort per process (runtime-registry), and its operations
// (draft .odt, published copy and PDF, editor URL) all run on the Nextcloud and Collabora that every customer
// of the install shares. The protocol routes are governance and always on, so a registered port says only that
// the BUILD has the files module, never that this customer may use it. A customer whose files switch is off
// (a core-only customer on a secondary host has it pinned off: pinned_off_modules) must not have its minutes
// created, edited or published in the shared service: for such a tenant the port is absent, and every protocol
// route takes its in-app path (protocols.body_html), exactly as it does when the build has no files module.
//
// `=== true` and not `!== false`: the same fail-closed reading as the Karenz retained sink of the files module
// (available(): modules.files === true). A tenant whose config does not say files is on does not get the port.
import { readConfig } from '$lib/server/config'
import { getProtocolDocumentPort, type ProtocolDocumentPort } from '$lib/server/modules/runtime-registry'

/** The registered port when the current tenant has the files module on, otherwise undefined. */
export function getTenantProtocolDocumentPort(): ProtocolDocumentPort | undefined {
  const port = getProtocolDocumentPort()
  if (!port) return undefined
  return readConfig().modules.files === true ? port : undefined
}
