# Vault sidecar: nginx reverse proxy with age-encrypted credential injection.
#
# Decrypts vault.age at startup, renders nginx config with credentials,
# then proxies API requests with injected auth headers.
#
# Build: docker build -t openclaw-vault ./vault
# Requires: AGE_SECRET_KEY environment variable at runtime

FROM nginx:1.28-alpine

# Install age for secret decryption
RUN apk add --no-cache age

# Remove default nginx config
RUN rm -f /etc/nginx/conf.d/default.conf

COPY nginx.conf.template /etc/nginx/nginx.conf.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["entrypoint.sh"]
