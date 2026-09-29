#!/usr/bin/env bash
# Start the pi861 web console (port 3901) behind the host Caddy HTTPS route.
# Usage: PI861_CONSOLE_TOKEN=... ./start.sh [config.json]
set -euo pipefail
cd "$(dirname "$0")"
CONFIG="${1:-${PI861_CONFIG:-}}"
if [ -z "$CONFIG" ]; then
	echo "Set PI861_CONFIG or pass the config path" >&2
	exit 2
fi
export PI861_CONFIG="$(cd "$(dirname "$CONFIG")" && pwd)/$(basename "$CONFIG")"
exec node server/index.mjs
