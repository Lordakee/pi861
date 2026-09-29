# pi861 web-ui

Read-only dashboard for a pi861 team run. Serves static files plus a
field-whitelisted JSON snapshot of the state directory; updates pushed over
SSE. No write endpoints (GET/HEAD only), no lease tokens, workspace paths,
task instructions, or memory contents are exposed.

## Run

```sh
PI861_STATE_DIR=/mnt/d/pi-projects/android-app/.pi861-state \
  node extensions/pi861/web-ui/server.mjs
```

- `PI861_STATE_DIR`: state directory to read (default `/mnt/d/pi-projects/android-app/.pi861-state`)
- `PORT`: listen port (default `3900`), `HOST`: bind address (default `0.0.0.0`)

## API

- `GET /api/snapshot` — full status JSON (`coordinator`, `usage`, `budget`, `memory`, `events`, `updatedAt`); each section carries `ok`/`error` so partial read failures are visible
- `GET /api/stream` — SSE, pushes the snapshot every 2s
- everything else — static files from `public/`

Files read: `coordinator.json`, `usage.json`, `budget.json`, `memory.json`.
Data that a file snapshot cannot provide (live model health, actual routing)
is intentionally not shown; treat displayed usage/budget as of `updatedAt`.
