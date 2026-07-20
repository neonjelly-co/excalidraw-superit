#!/bin/sh
set -e

node /opt/runtime-env/node_modules/@import-meta-env/cli/bin/import-meta-env.js \
  -x /opt/.env.example \
  -p /usr/share/nginx/html/index.html
