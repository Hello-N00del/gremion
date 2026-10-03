// src/lib/server/files/register.server.ts
// Civitas Session-A inversion A1: the files module self-registers its Nextcloud
// provisioning adapter into the runtime-registry seam, so the governance
// orchestrator never imports files internals. Loaded for its side effects by the
// generated server-init barrel (scripts/build-module-server-init.mjs).
import {
  registerProvisioningSubsystem,
  registerProtocolDocumentPort,
  registerSetupHealthProbe,
} from '$lib/server/modules/runtime-registry'
import { serviceEnv } from '$lib/server/env/service-env'
import { createNextcloudClient } from './nextcloud-client'
import { createNextcloudSubsystem } from './provisioning/nextcloud-subsystem'
import { protocolDocumentPort } from './protocol-documents'

// The Nextcloud provisioning adapter. The factory captures the files module's
// own Nextcloud client + the user_oidc provider id; the governance orchestrator
// passes the per-tenant KC-admin client at build time.
registerProvisioningSubsystem('nextcloud', (kc) =>
  createNextcloudSubsystem(
    { nc: createNextcloudClient(), kc },
    Number(serviceEnv('NEXTCLOUD_OIDC_PROVIDER_ID') ?? '1'),
  ),
)

// A3a-2: the protocol document port (the Nextcloud draft/publish/PDF ops the
// protocol routes drive). Registering it here means the protocol routes resolve
// these ops via getProtocolDocumentPort() and never import $lib/server/files.
registerProtocolDocumentPort(protocolDocumentPort)

// A3c S2: setup-wizard credential probe for Nextcloud (#191). The setup-health
// route iterates the registered probes instead of importing nextcloud-client, so
// it reports `credentials.nextcloud` from this module's own admin client.
registerSetupHealthProbe({
  service: 'nextcloud',
  validate: () => createNextcloudClient().validateCredentials(),
})
