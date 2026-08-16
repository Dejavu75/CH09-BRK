#!/usr/bin/env bash
set -euo pipefail

KEY_DIR="${SSH_KEY_HOST_PATH:-${1:-}}"
PUBLIC_DIR="${SSH_PUBLIC_KEY_HOST_PATH:-${2:-}}"
KEY_NAME="ch09_brk_iis"
VALIDATE_ONLY="${VALIDATE_ONLY:-false}"
[[ "${1:-}" == "--validate-only" ]] && VALIDATE_ONLY=true

if [[ -z "$KEY_DIR" || -z "$PUBLIC_DIR" ]]; then
  echo "Usage: SSH_KEY_HOST_PATH=/persistent/keys SSH_PUBLIC_KEY_HOST_PATH=/public/export $0 [--validate-only]" >&2
  exit 1
fi

PRIVATE_KEY="$KEY_DIR/$KEY_NAME"
PUBLIC_KEY="$PRIVATE_KEY.pub"
PUBLIC_EXPORT="$PUBLIC_DIR/$KEY_NAME.pub"

umask 077
if [[ "$VALIDATE_ONLY" != true ]]; then
  mkdir -p "$KEY_DIR" "$PUBLIC_DIR"
  chmod 700 "$KEY_DIR"
fi

if [[ -e "$PRIVATE_KEY" || -e "$PUBLIC_KEY" ]]; then
  if [[ -L "$KEY_DIR" || -L "$PUBLIC_DIR" || -L "$PRIVATE_KEY" || -L "$PUBLIC_KEY" || -L "$PUBLIC_EXPORT" || ! -f "$PRIVATE_KEY" || ! -s "$PRIVATE_KEY" || ! -f "$PUBLIC_KEY" || ! -s "$PUBLIC_KEY" ]]; then
    echo "Incomplete broker SSH identity; refusing to replace or repair it automatically" >&2
    exit 1
  fi
else
  [[ "$VALIDATE_ONLY" != true ]] || { echo "Broker SSH identity is missing" >&2; exit 1; }
  ssh-keygen -q -t ed25519 -f "$PRIVATE_KEY" -C "ch09-brk-iis" -N ""
fi

if [[ "$VALIDATE_ONLY" != true ]]; then
  chmod 600 "$PRIVATE_KEY"
  chmod 644 "$PUBLIC_KEY"
fi
[[ "$(stat -c '%a' "$PRIVATE_KEY")" =~ ^(400|600)$ ]] || { echo "Broker SSH private key mode must be 400 or 600" >&2; exit 1; }
key_uid="$(stat -c '%u' "$PRIVATE_KEY")"
[[ "$key_uid" == 0 || "$key_uid" == "$(id -u)" ]] || { echo "Broker SSH private key has an unexpected owner" >&2; exit 1; }

DERIVED_PUBLIC="$(mktemp)"
trap 'rm -f "$DERIVED_PUBLIC"' EXIT HUP INT TERM
ssh-keygen -y -f "$PRIVATE_KEY" > "$DERIVED_PUBLIC"
if [[ "$(awk 'NR == 1 { print $1 " " $2 }' "$DERIVED_PUBLIC")" != "$(awk 'NR == 1 { print $1 " " $2 }' "$PUBLIC_KEY")" ]]; then
  echo "Broker SSH keypair mismatch; refusing to export" >&2
  exit 1
fi

if [[ "$VALIDATE_ONLY" == true ]]; then
  :
else
  install -m 0644 "$PUBLIC_KEY" "$PUBLIC_EXPORT"
fi
echo "Broker SSH identity is ready; copy only: $PUBLIC_EXPORT"
