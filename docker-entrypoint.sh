#!/bin/sh
set -e

SSH_PUBLIC_KEY_EXPORT_PATH="${SSH_PUBLIC_KEY_EXPORT_PATH:-/app/ssh-public}"
SSH_PUBLIC_KEY_SOURCE="${SSH_PUBLIC_KEY_SOURCE:-/app/keys/ch09_brk_iis.pub}"

mkdir -p "$SSH_PUBLIC_KEY_EXPORT_PATH"

if [ -f "$SSH_PUBLIC_KEY_SOURCE" ]; then
  cp "$SSH_PUBLIC_KEY_SOURCE" "$SSH_PUBLIC_KEY_EXPORT_PATH/ch09_brk_iis.pub"
  echo "SSH public key exported to $SSH_PUBLIC_KEY_EXPORT_PATH/ch09_brk_iis.pub"
else
  echo "SSH public key source not found: $SSH_PUBLIC_KEY_SOURCE" >&2
fi

exec "$@"
