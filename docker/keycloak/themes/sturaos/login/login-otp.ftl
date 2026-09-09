<#-- StuRaOS v4 — OTP / 2FA step. Self-contained. KC injects url, realm,
     message, messagesPerField, otpLogin, locale. Field name: otp. -->
<!DOCTYPE html>
<html lang="${(locale.currentLanguageTag)!'de'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${msg("sturaosOtpTitle")} · ${(realm.displayName)!'StuRaOS'}</title>
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
        <h1>${msg("sturaosOtpTitle")}</h1>
        <p>${msg("sturaosOtpSubtitle")}</p>
      </div>

      <#if message?has_content>
        <div class="auth-alert auth-alert-${message.type}">
          <span class="ic"><#if message.type = 'success'>✓<#elseif message.type = 'info'>i<#else>!</#if></span>
          <span>${message.summary}</span>
        </div>
      </#if>

      <form class="auth-form" action="${url.loginAction}" method="post">
        <#if otpLogin?? && otpLogin.userOtpCredentials?? && (otpLogin.userOtpCredentials?size > 1)>
          <div class="auth-field">
            <label>${msg("loginOtpDevice")!"Gerät"}</label>
            <#list otpLogin.userOtpCredentials as otpCred>
              <label class="auth-check">
                <input type="radio" name="selectedCredentialId" value="${otpCred.id}" <#if otpCred.id == otpLogin.selectedCredentialId>checked</#if>/>
                ${otpCred.userLabel}
              </label>
            </#list>
          </div>
        </#if>

        <div class="auth-field">
          <label for="otp">${msg("sturaosOtpLabel")}</label>
          <input id="otp" name="otp" class="auth-input mono" type="text" inputmode="numeric"
                 autocomplete="one-time-code" maxlength="6" placeholder="000000" autofocus
                 aria-invalid="<#if messagesPerField.existsError('totp')>true</#if>"/>
        </div>

        <button class="auth-btn" type="submit">${msg("doSubmit")} <span class="arr">→</span></button>
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
