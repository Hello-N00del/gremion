# infra/host/mail/from-align.sieve -- TASK-015 (TRD-253, TRD-049).
#
# Run by Stalwart at DATA for every AUTHENTICATED session (config.toml.tmpl
# [session.data]). must-match-sender checks the ENVELOPE sender only; measured
# on the pinned build (2026-09-28), an authenticated kc-<tenant>@ principal
# with a matching MAIL FROM could still write `From: system@<domain>` in the
# header and have it queued -- a customer credential sending as the vendor,
# and DMARC-aligned, because the envelope and the DKIM d= are the vendor
# domain. This script refuses a message unless EVERY From address is exactly
# the authenticated envelope sender (case-insensitive), refuses a message
# with no From (or a group From with no mailbox), and refuses an address in
# the DISPLAY NAME ("system@<domain> Gremion" <kc-a@...>), which a mail client
# shows in place of the real sender.
#
# Kept in its own file, loaded through %{file:...}%, because the Sieve variable
# syntax is the brace-dollar form that gremion-mail-bringup --render-config
# refuses to find surviving in the rendered config.toml.
require ["variables", "reject", "relational"];
if anyof (not exists "from",
          header :matches "from" "*@*<*",
          address :all :value "ne" "from" "${envelope.from}",
          not address :all :is "from" "${envelope.from}") {
    reject "5.7.1 the From header must be exactly the authenticated sender";
    stop;
}
