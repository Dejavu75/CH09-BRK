#!/bin/sh
set -e

SSH_IDENTITY_REQUIRED="${SSH_IDENTITY_REQUIRED:-false}"
AGES_SSH_KEY_PATH="${AGES_SSH_KEY_PATH:-/run/secrets/ch09-brk-iis/ch09_brk_iis}"
SSH_PUBLIC_KEY_PATH="${SSH_PUBLIC_KEY_PATH:-${AGES_SSH_KEY_PATH}.pub}"

case "$SSH_IDENTITY_REQUIRED" in
  1|true|TRUE|yes|YES) SSH_IDENTITY_REQUIRED=true ;;
  0|false|FALSE|no|NO|'') SSH_IDENTITY_REQUIRED=false ;;
  *) echo "Invalid SSH_IDENTITY_REQUIRED value" >&2; exit 1 ;;
esac

if [ "$SSH_IDENTITY_REQUIRED" = true ]; then
  if [ -L "$AGES_SSH_KEY_PATH" ] || [ ! -f "$AGES_SSH_KEY_PATH" ] || [ ! -s "$AGES_SSH_KEY_PATH" ]; then
    echo "Required broker SSH private-key source is not a non-empty regular file" >&2
    exit 1
  fi
  if [ -L "$SSH_PUBLIC_KEY_PATH" ] || [ ! -f "$SSH_PUBLIC_KEY_PATH" ] || [ ! -s "$SSH_PUBLIC_KEY_PATH" ]; then
    echo "Required broker SSH public key is not a non-empty regular file" >&2
    exit 1
  fi

  runtime_key="${SSH_RUNTIME_KEY_PATH:-/run/ch09-brk-ssh/ch09_brk_iis}"
  mkdir -p "$(dirname "$runtime_key")"
  chmod 700 "$(dirname "$runtime_key")"
  install -m 0600 "$AGES_SSH_KEY_PATH" "$runtime_key"
  [ "$(stat -c '%a' "$runtime_key")" = 600 ] || { echo "Unable to secure runtime SSH key" >&2; exit 1; }

  derived_public="$(mktemp)"
  trap 'rm -f "$derived_public"' EXIT HUP INT TERM
  ssh-keygen -y -f "$runtime_key" > "$derived_public"
  if [ "$(awk 'NR == 1 { print $1 " " $2 }' "$derived_public")" != "$(awk 'NR == 1 { print $1 " " $2 }' "$SSH_PUBLIC_KEY_PATH")" ]; then
    echo "Broker SSH public key does not match the mounted private key" >&2
    exit 1
  fi
  rm -f "$derived_public"
  trap - EXIT HUP INT TERM
  export AGES_SSH_KEY_PATH="$runtime_key"
fi

exec "$@"
