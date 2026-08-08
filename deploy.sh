#!/usr/bin/env bash
# Deploy the yammbo-alerts Worker. Reads the CF API token at runtime so the
# token string never appears in a tool/bash command line (hook-safe pattern).
set -euo pipefail
cd /root/repos/yammbo-alerts
export CLOUDFLARE_API_TOKEN="$(cat /root/.cloudflare-api-token)"
export CLOUDFLARE_ACCOUNT_ID="$(cat /root/.cloudflare-account-id)"
npx wrangler deploy "$@"
