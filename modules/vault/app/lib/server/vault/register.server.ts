// src/lib/server/vault/register.server.ts
// Module Karenz (phase 2): the vault module declares its retention decision at server init. Loaded for its
// side effects by the generated server-init barrel when the module is enabled.
import { registerNoRetention } from '$lib/server/module-karenz/retained/extractors'

// Vault items, collection references and instance configuration (RC-PWD) are kept only for the 30-day grace
// through the pg_dump export of the blocked database (RC-MOD-EXPORT, secrets withheld); no sealed copy is
// written. Without this declaration the retained step fails closed on every pass once the module is enabled
// and switched off.
registerNoRetention('vault')
