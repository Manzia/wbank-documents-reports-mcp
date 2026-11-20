#!/bin/bash
# Local dispatcher entry point (plan §6). launchd runs it every 15 minutes and at login; see README.md.
set -euo pipefail
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
exec node "$(dirname "$0")/dispatch.mjs" "$@"
