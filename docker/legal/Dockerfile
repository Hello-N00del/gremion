# A-021 wave 2: non-root nginx so the Pod can join an enforce=restricted
# namespace. nginx-unprivileged runs as uid 101 and listens on :8080.
FROM nginxinc/nginx-unprivileged:alpine

# envsubst ships with the nginx alpine images via gettext — no extra apk
# install needed.

# nginx-unprivileged defaults to USER 101; switch to root only for the COPYs
# + the chown that makes the html root writable by uid 101 (entrypoint.sh
# renders templates INTO it at container start), then drop back to 101.
USER root

COPY nginx.conf    /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
COPY templates/    /templates/

# entrypoint.sh (uid 101) writes rendered pages into the html root — make it
# owner-writable by 101. chmod +x the entrypoint while we're still root.
RUN chmod +x /entrypoint.sh \
    && chown -R 101:101 /usr/share/nginx/html

USER 101

ENTRYPOINT ["/entrypoint.sh"]
