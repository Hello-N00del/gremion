<#-- StuRaOS v5 — standalone error page (Fehler-Zustand). Renders hard Keycloak
     errors in the same self-contained auth shell as login/otp/reset instead of
     falling back to the parent keycloak.v2 theme. KC injects: message, client,
     skipLink, realm, locale. BRAND-driven via realm.displayName / realm.name. -->
<!DOCTYPE html>
<html lang="${(locale.currentLanguageTag)!'de'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${msg("sturaosErrorTitle")} · ${(realm.displayName)!'StuRaOS'}</title>
  <link rel="stylesheet" href="${url.resourcesPath}/css/sturaos.v2.css">
</head>
<body class="auth-body">
  <div class="auth-bg"></div>
  <div class="auth-wrap">
    <div class="auth-brand">
      <div class="logo">${msg("sturaosLogoLetter")}</div>
      <div>
        <div class="n">${(realm.displayName)!'StuRaOS'}</div>
        <div class="s">${msg("sturaosBrandSub")}</div>
      </div>
    </div>

    <div class="auth-card">
      <div class="auth-head">
        <h1>${msg("sturaosErrorTitle")}</h1>
        <p>${msg("sturaosErrorSubtitle")}</p>
      </div>

      <#if message?has_content>
        <div class="auth-alert auth-alert-${message.type}">
          <span class="ic">!</span>
          <span>${kcSanitize(message.summary)?no_esc}</span>
        </div>
      </#if>

      <#if !skipLink?? && client?? && client.baseUrl?has_content>
        <a class="auth-btn" href="${client.baseUrl}">${msg("sturaosBackToApp")} <span class="arr">→</span></a>
      <#else>
        <a class="auth-back" href="${url.loginUrl!'/'}">← ${msg("sturaosBackToApp")}</a>
      </#if>
    </div>

    <#include "portal-back.ftl">
    <div class="auth-foot">
      <a href="/legal/impressum">${msg("sturaosImprint")}</a><span class="sep">·</span>
      <a href="/legal/datenschutz">${msg("sturaosPrivacy")}</a>
    </div>
    <div class="auth-secured">${msg("sturaosSecured")} ${realm.name}</div>
  </div>
</body>
</html>
