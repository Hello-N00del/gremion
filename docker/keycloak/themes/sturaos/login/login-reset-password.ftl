<#-- StuRaOS v4 — password reset request. Self-contained. KC injects url, realm,
     message, messagesPerField, auth, locale. Field name: username. -->
<!DOCTYPE html>
<html lang="${(locale.currentLanguageTag)!'de'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${msg("sturaosResetTitle")} · ${(realm.displayName)!'StuRaOS'}</title>
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
        <h1>${msg("sturaosResetTitle")}</h1>
        <p>${msg("sturaosResetSubtitle")}</p>
      </div>

      <#if message?has_content>
        <div class="auth-alert auth-alert-${message.type}">
          <span class="ic"><#if message.type = 'success'>✓<#elseif message.type = 'info'>i<#else>!</#if></span>
          <span>${message.summary}</span>
        </div>
      </#if>

      <form class="auth-form" action="${url.loginAction}" method="post">
        <div class="auth-field">
          <label for="username">${(realm.loginWithEmailAllowed)?then(msg("usernameOrEmail"), msg("username"))}</label>
          <input id="username" name="username" class="auth-input" type="text" autofocus
                 value="${(auth.attemptedUsername)!''}"
                 placeholder="vorname.nachname@example.org"
                 aria-invalid="<#if messagesPerField.existsError('username')>true</#if>"/>
        </div>

        <button class="auth-btn" type="submit">${msg("sturaosResetSubmit")} <span class="arr">→</span></button>
        <a class="auth-back" href="${url.loginUrl}">← ${msg("backToLogin")}</a>
      </form>
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
