#!/bin/bash
# Read Docker secrets from /run/secrets/ and export as env vars.
# Each secret filename becomes the environment variable name.
if [ -d /run/secrets ]; then
  for secret_file in /run/secrets/*; do
    if [ -f "$secret_file" ]; then
      var_name=$(basename "$secret_file")
      export "$var_name"="$(cat "$secret_file")"
    fi
  done
fi
exec "$@"
