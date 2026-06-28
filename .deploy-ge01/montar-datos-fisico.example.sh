#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y sshfs

sudo mkdir -p /mnt/solinges-phys
sudo chown "$USER:$USER" /mnt/solinges-phys

if ! grep -q "^user_allow_other" /etc/fuse.conf; then
  echo user_allow_other | sudo tee -a /etc/fuse.conf >/dev/null
fi

sshfs -o reconnect -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o allow_other \
  diego.zacur@192.168.89.2:/C:/Servidor/Solinges /mnt/solinges-phys

echo "Montado por SSHFS en /mnt/solinges-phys"
echo "Ruta ecosystem esperada: /mnt/solinges-phys/ecosystem"
