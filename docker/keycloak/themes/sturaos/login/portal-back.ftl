<#-- v12 (apex topology) — the "back to the public portal" escape hatch.
     Included by ALL FOUR templates (login / login-otp / login-reset-password /
     error) so EVERY auth state carries it. This theme has no template.ftl (each
     template is self-contained), so the include is repeated per template rather
     than overriding Keycloak's base template.

     Target: the `gremion.portal-url` realm attribute. Validation and the
     absent-or-invalid -> emit-NOTHING contract live in url-guard.ftl; a realm
     without the attribute renders byte-identically to the pre-v12 page. That
     default matters here: the kernel is a standalone governance kernel and an
     operator may run it with no public portal at all, so nothing is rendered
     until the realm opts in.

     Styling is graphite/neutral (--ink-muted -> --ink on hover), NOT an accent:
     this is a secondary escape hatch, not a brand moment. Both tokens are
     defined in the light :root and in the dark blocks of sturaos.v2.css, so it
     reads correctly in either scheme.

     ESCAPER CHOICE for the href — ?esc (HTML escaping), NOT ?url, NOT ?html:
       * ?url / ?url_path percent-encode a URL's STRUCTURAL characters
         ("/" -> %2F, ":" -> %3A). That is the right escaper for a value being
         embedded INTO a query parameter, and the WRONG one for a whole href —
         it would turn /portal into a broken relative filename.
       * ?html is NOT usable here. Keycloak 26's DefaultFreeMarkerProvider
         configures FreeMarker with the HTML output format and auto-escaping ON,
         and FreeMarker then REFUSES the legacy escapers at parse time:
         "Using ?html (legacy escaping) is not allowed when auto-escaping is on
         with a markup output format (HTML), to avoid double-escaping mistakes."
         (Verified empirically against quay.io/keycloak/keycloak:26.6.1 — using
         ?html here makes every login render fail with HTTP 500. This theme is
         mounted into exactly that image by docker-compose.yml.)
       * ?esc is the modern, allowed spelling of exactly that HTML escaping: it
         encodes & < > " ' and returns a markup-output value, so auto-escaping
         does not escape it a second time. It is written explicitly rather than
         relying on the implicit auto-escape so the sink is self-documenting —
         this value goes into an attribute and is escaped for one, on purpose.
       * The escaping is defence in depth. The allow-list in url-guard.ftl is the
         actual control: it excludes & < > " ' ` \ and whitespace, so escaping
         here is in practice the identity function and a value that could break
         out of the attribute never reaches the escaper at all. -->
<#include "url-guard.ftl">
<#assign gremionPortalUrl = gremionSafeUrl('gremion.portal-url')>
<#if gremionPortalUrl?has_content>
  <div class="auth-portal">
    <a href="${gremionPortalUrl?esc}"><span class="arr">←</span> ${msg("sturaosBackToPortal")}</a>
  </div>
</#if>
