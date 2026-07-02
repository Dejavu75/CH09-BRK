#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:?target is required}"
IMAGE_TAG="${2:-latest}"
IMAGE="dhzacur/ha_ch09_brk:${IMAGE_TAG}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/ch09_deploy_key}"
SSH_BASE_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -i "$SSH_KEY")

port_or_default() {
  local value="${1:-}"
  if [[ -n "$value" ]]; then
    printf '%s' "$value"
  else
    printf '22'
  fi
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 2
  fi
}

ssh_target() {
  local user="$1"
  local host="$2"
  local port="$3"
  local command="$4"
  local escaped_command
  printf -v escaped_command '%q' "$command"
  ssh "${SSH_BASE_OPTS[@]}" -p "$(port_or_default "$port")" "${user}@${host}" "bash -lc $escaped_command"
}

ssh_target_with_jump() {
  local jump_user="$1"
  local jump_host="$2"
  local jump_port="$3"
  local user="$4"
  local host="$5"
  local port="$6"
  local command="$7"
  local escaped_command
  printf -v escaped_command '%q' "$command"
  ssh "${SSH_BASE_OPTS[@]}" \
    -J "${jump_user}@${jump_host}:$(port_or_default "$jump_port")" \
    -p "$(port_or_default "$port")" \
    "${user}@${host}" "bash -lc $escaped_command"
}

remote_deploy_command() {
  local image="$1"
  shift
  local compose_dirs=("$@")
  local joined=""
  printf -v joined '%q ' "${compose_dirs[@]}"
  cat <<EOF
set -euo pipefail
IMAGE='$image'
for dir in $joined; do
  echo "==> Deploying CH09-BRK in \$dir with image \$IMAGE"
  cd "\$dir"
  docker compose config >/dev/null
  docker pull "$IMAGE"
  docker tag "$IMAGE" dhzacur/ha_ch09_brk:latest
  docker compose up -d --force-recreate --no-deps ch09
  docker image prune -f >/dev/null || true
  docker ps --filter name=ch09-brk
  docker exec ch09-brk node -e "const { BROKER_BUILD_INFO } = require('/app/build/generated/build_info.js'); console.log(JSON.stringify(BROKER_BUILD_INFO))" || true
done
EOF
}

deploy_srisri() {
  require_env SRISRI_HOST
  require_env SRISRI_USER
  local cmd
  cmd="$(remote_deploy_command "$IMAGE" \
    /mnt/solinges-phys/ecosystem/dockerzone/CH09-BRK \
    /mnt/solinges-phys/ecosystem/dockerzone/CH09-BRK-Testing)"
  ssh_target "$SRISRI_USER" "$SRISRI_HOST" "${SRISRI_PORT:-22}" "$cmd"
}

deploy_merclin() {
  require_env MERCLIN_HOST
  require_env MERCLIN_USER
  local cmd
  cmd="$(remote_deploy_command "$IMAGE" \
    /mnt/solinges-phys/ecosystem/dockerzone/CH09-BRK \
    /mnt/solinges-phys/ecosystem/dockerzone/CH09-BRK_Testing)"
  ssh_target "$MERCLIN_USER" "$MERCLIN_HOST" "${MERCLIN_PORT:-22}" "$cmd"
}

deploy_induart() {
  require_env INDUART_PHYSICAL_HOST
  require_env INDUART_PHYSICAL_USER
  require_env INDUART_GES01_HOST
  require_env INDUART_GES01_USER
  local cmd
  cmd="$(remote_deploy_command "$IMAGE" /opt/solinges/ecosystem/dockerzone/CH09-BRK)"
  ssh_target_with_jump \
    "$INDUART_PHYSICAL_USER" "$INDUART_PHYSICAL_HOST" "${INDUART_PHYSICAL_PORT:-22}" \
    "$INDUART_GES01_USER" "$INDUART_GES01_HOST" "${INDUART_GES01_PORT:-22}" \
    "$cmd"
}

case "$TARGET" in
  srisri) deploy_srisri ;;
  merclin) deploy_merclin ;;
  induart) deploy_induart ;;
  all)
    deploy_srisri
    deploy_merclin
    deploy_induart
    ;;
  *)
    echo "Unknown target: $TARGET" >&2
    exit 2
    ;;
esac
