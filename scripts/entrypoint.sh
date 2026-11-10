#!/bin/sh
set -e

mkdir -p /root/.ssh
if [ -d /host-ssh ]; then
  cp -f /host-ssh/* /root/.ssh/ 2>/dev/null || true
  chown -R root:root /root/.ssh
  chmod 700 /root/.ssh
  chmod 600 /root/.ssh/* 2>/dev/null || true
fi

exec "$@"
