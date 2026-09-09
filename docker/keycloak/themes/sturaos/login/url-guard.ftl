<#-- v12 (apex topology) — shared URL guard for operator-supplied realm
     attributes that this theme puts into an `href` (today: `gremion.portal-url`).
     The contract: read a realm attribute, validate it STRICTLY, and emit NOTHING
     when it is absent or invalid — so a realm that does not set the attribute
     renders byte-identically to the pre-v12 page. Realm attributes are
     operator-owned, but this is a public, unauthenticated login page, so the
     value is treated as untrusted input regardless.

     (In the product vertical this pattern was established by `instance-accent.ftl`
     (#404), which drives the per-realm accent from `gremion.i-h`/`gremion.i-c`.
     That file is NOT in the kernel: the OKLCH instance engine is a deliberately
     deferred parity gap — see KNOWN_ISSUES.md, "Design parity with product". This
     file therefore establishes the realm-attribute pattern in the kernel on its
     own, and instance-accent should adopt it when the engine lands.)

     VALIDATION RULE — a value is accepted only if it is, IN FULL, either:
       (a) a SAME-ORIGIN ABSOLUTE PATH — one leading "/" that is NOT followed by
           another "/", then only characters from the allow-list below; or
       (b) an HTTPS ABSOLUTE URL — the literal lowercase "https://", a host made
           of [A-Za-z0-9] with "." / "-" separators (it must START and END
           alphanumeric), an optional ":<1..5 digits>" port, and an optional
           "/"-rooted tail from the same allow-list.
     ...and is 1..200 characters long.

     Consequently REJECTED (the function returns "" and the caller emits no
     markup at all — a partially sanitised value is never rendered):
       * any other scheme: `javascript:`, `data:`, `vbscript:`, `file:` — none
         start with "/" or with "https://";
       * protocol-relative `//evil.com` — the (?!/) lookahead kills it;
       * backslash tricks `/\evil.com` — browsers normalise "/\" to "//", and
         "\" is not in the allow-list;
       * userinfo host confusion `https://good.com@evil.com/` — "@" is not in
         the host character class, so the host cannot be spoofed;
       * plaintext `http://` — https-only by rule (a non-TLS origin must be
         referenced as a same-origin path instead);
       * uppercase/mixed-case schemes (`HTTPS://`) — deliberately conservative;
       * anything containing whitespace, control characters (incl. CR/LF/NUL),
         quotes, angle brackets, backticks or backslashes — none are in the
         allow-list, so `/valid" onmouseover="x` cannot survive.

     FreeMarker's ?matches is a WHOLE-STRING match (java.util.regex
     Matcher.matches()): no anchors are needed, partial matches are not accepted,
     and because "." is never used in the pattern a trailing newline cannot slip
     through either.

     ALLOW-LIST (path + tail):  A-Z a-z 0-9  .  _  ~  %  !  $  *  +  ,  ;  =
     :  @  (  )  /  ?  #  -
     It deliberately EXCLUDES "&" and "'" as well as the obvious dangerous
     characters. Excluding "&" is what makes HTML-escaping the accepted value
     provably the IDENTITY function, so the rendered href cannot be corrupted by
     an escaping change and there is no double-escaping hazard. The cost is that
     a multi-parameter query string cannot be configured; a single "?k=v" still
     can, and a portal landing URL does not need more. -->
<#assign GREMION_SAFE_URL_RE = r"(/(?!/)[A-Za-z0-9._~%!$*+,;=:@()/?#-]*)|(https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$*+,;=:@()/?#-]*)?)">
<#assign GREMION_SAFE_URL_MAX = 200>

<#-- Returns the validated attribute value, or "" when the attribute is absent,
     empty, over-long or fails the rule above. Callers MUST guard on ?has_content
     and render nothing otherwise. Including this file more than once in one
     template is harmless — FreeMarker simply re-assigns the namespace entries. -->
<#function gremionSafeUrl attrName>
  <#local v = (realm.getAttribute(attrName))!''>
  <#if v?length gt 0 && v?length lte GREMION_SAFE_URL_MAX && v?matches(GREMION_SAFE_URL_RE)><#return v></#if>
  <#return ''>
</#function>
