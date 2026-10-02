# ops/vendor-mail/__fixtures__/principals

The shape `gremion-vendor-mail collect` writes on a host (principal names,
emails and roles -- never their secrets; every realm's smtpServer user,
from and host -- never its password), for `check-principals.mjs` in verify
mode. RFC 2606 names only. A customer realm with no SMTP user configured yet
(`gamma_council`) is not a violation; one that shares a principal is.
