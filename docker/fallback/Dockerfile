FROM nginx:alpine
COPY index.html /usr/share/nginx/html/index.html
# Serve the starting page for ANY path so any cold-start URL is caught.
RUN printf 'server { listen 80; location / { root /usr/share/nginx/html; try_files /index.html =200; } }\n' \
    > /etc/nginx/conf.d/default.conf
