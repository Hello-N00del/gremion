<#-- StuRaOS v4 login theme — self-contained (no template.ftl import) so the
     custom auth-card markup is exact. Keycloak still injects the full model:
     url, realm, message, messagesPerField, social, login, auth, locale.
     Copy lives in messages(.de).properties (msg keys), not the markup. -->
<!DOCTYPE html>
<html lang="${(locale.currentLanguageTag)!'de'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${msg("sturaosLoginTitle")} · ${(realm.displayName)!'StuRaOS'}</title>
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
        <h1>${msg("sturaosLoginTitle")}</h1>
        <p>${msg("sturaosLoginSubtitle")}</p>
      </div>

      <#if message?has_content>
        <div class="auth-alert auth-alert-${message.type}">
          <span class="ic"><#if message.type = 'success'>✓<#elseif message.type = 'info'>i<#else>!</#if></span>
          <span>${message.summary}</span>
        </div>
      </#if>

      <#if realm.password>
        <form class="auth-form" action="${url.loginAction}" method="post">
          <#if !(usernameHidden!false)>
            <div class="auth-field">
              <label for="username">${msg("usernameOrEmail")}</label>
              <input id="username" name="username" class="auth-input" type="text"
                     value="${(login.username)!''}" autocomplete="username" autofocus
                     placeholder="vorname.nachname"
                     aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"/>
            </div>
          </#if>

          <div class="auth-field">
            <label for="password">${msg("password")}<#if realm.resetPasswordAllowed><a href="${url.loginResetCredentialsUrl}">${msg("doForgotPassword")}</a></#if></label>
            <input id="password" name="password" class="auth-input" type="password"
                   autocomplete="current-password" placeholder="••••••••••••"
                   aria-invalid="<#if messagesPerField.existsError('username','password')>true</#if>"/>
          </div>

          <#if realm.rememberMe && !(usernameHidden!false)>
            <label class="auth-check">
              <input type="checkbox" name="rememberMe" <#if login.rememberMe??>checked</#if>/> ${msg("rememberMe")}
            </label>
          </#if>

          <#if auth?? && auth.selectedCredential?has_content>
            <input type="hidden" name="credentialId" value="${auth.selectedCredential}"/>
          </#if>

          <button class="auth-btn" type="submit" name="login">${msg("doLogIn")} <span class="arr">→</span></button>
        </form>
      </#if>

      <#if realm.password && social?? && social.providers?? && social.providers?has_content>
        <div class="auth-divider">${msg("sturaosOr")}</div>
        <#list social.providers as p>
          <a class="auth-idp" href="${p.loginUrl}">
            <span class="badge">${(p.displayName?upper_case)?substring(0,1)}</span>
            <span>${p.displayName}</span>
            <span class="chev">→</span>
          </a>
        </#list>
      </#if>

      <#if realm.password && realm.registrationAllowed && !registrationDisabled??>
        <a class="auth-back" href="${url.registrationUrl}">${msg("sturaosRegister")}</a>
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
