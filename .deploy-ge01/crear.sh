#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! mountpoint -q /mnt/solinges-phys; then
  mkdir -p /mnt/solinges-phys
  sshfs -o reconnect -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o allow_other \
    diego.zacur@192.168.89.2:/C:/Servidor/Solinges /mnt/solinges-phys
fi

read_env() {
  local name="$1"
  sed -n "s/^[[:space:]]*${name}[[:space:]]*=[[:space:]]*//p" ./.env | tail -n 1
}

CONFIG_PATH="$(read_env CONFIG_PATH)"
LOG_PATH="$(read_env LOG_PATH)"
CERT_PATH="$(read_env CERT_PATH)"
CERTBOT_WEBROOT_PATH="$(read_env CERTBOT_WEBROOT_PATH)"
SSH_PUBLIC_KEY_HOST_PATH="$(read_env SSH_PUBLIC_KEY_HOST_PATH)"

mkdir -p "$CONFIG_PATH" "$LOG_PATH" "$CERT_PATH" "$CERTBOT_WEBROOT_PATH" "$SSH_PUBLIC_KEY_HOST_PATH"
cp ./.env "$CONFIG_PATH/.env"

docker network inspect habitatzone >/dev/null 2>&1 || \
  docker network create --subnet 172.30.0.0/24 habitatzone

docker compose down
docker image rm dhzacur/ha_ch09_brk || true
docker compose pull
docker compose up -d

docker ps --filter "name=ch09-brk"
docker logs --tail 80 ch09-brk
