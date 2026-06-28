#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

read_env() {
  local name="$1"
  sed -n "s/^[[:space:]]*${name}[[:space:]]*=[[:space:]]*//p" ./.env | tail -n 1
}

DOMAIN="$(read_env CERTBOT_DOMAIN)"
EMAIL="$(read_env CERTBOT_EMAIL)"
CERTBOT_WEBROOT_PATH="$(read_env CERTBOT_WEBROOT_PATH)"

if [[ -z "$DOMAIN" || -z "$EMAIL" || -z "$CERTBOT_WEBROOT_PATH" ]]; then
  echo "Faltan CERTBOT_DOMAIN, CERTBOT_EMAIL o CERTBOT_WEBROOT_PATH en .env" >&2
  exit 1
fi

mkdir -p "$CERTBOT_WEBROOT_PATH"

docker run --rm \
  -v "$(read_env CERT_PATH):/etc/letsencrypt" \
  -v "$CERTBOT_WEBROOT_PATH:/var/www/certbot" \
  certbot/certbot certonly \
  --webroot \
  -w /var/www/certbot \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email

docker restart ch09-brk
