# pi861 Web Console

Interactive management console for a pi861 runtime: main-agent chat, goal/task board with
DAG view, agent management, model assignment, budget/usage and settings — over a single
WebSocket. Successor to the read-only SSE dashboard (`extensions/pi861/web-ui`, port 3900).

## Layout

```
server/
  index.mjs             HTTP + WebSocket entry, static files, health check, graceful shutdown
  rpc-bridge.mjs        Console chat sessions as spawned pi RPC subprocesses (steer/abort)
  coordinator-bridge.mjs ProjectCoordinator/ProjectRunner/Workspaces wrapper + goal templates
  protocol.mjs           WS message protocol (requestId acks, 2s snapshot broadcast)
web/
  index.html styles.css main.js core.js   SPA shell, dark theme, router, WS client
  pages/ chat.js goals.js agents.js models.js settings.js
```

## Start

```bash
PI861_CONFIG=/path/to/pi861-config.json \
PI861_CONSOLE_TOKEN=<strong-bearer-token> \
node extensions/pi861-web/server/index.mjs
# or: ./start.sh
```

Environment:

| Variable | Default | Meaning |
|---|---|---|
| `PI861_CONFIG` | required | Trusted runtime config (state directory, project, models) |
| `PI861_CONSOLE_TOKEN` | unset | Bearer token; without it the console is read-only and binds 127.0.0.1 |
| `PI861_CONSOLE_PORT` | 3901 | HTTP/WS listen port |
| `PI861_CONSOLE_HOST` | see index.mjs | Bind host (0.0.0.0 when a token is set, else 127.0.0.1) |
| `PI861_RUNTIME_ENTRY` | `../../pi861/runtime.ts` | Extension loaded into spawned chat/worker sessions |

## Protocol (WebSocket at `/ws`)

Authenticate with `?token=` (or an `auth` message). Commands carry `requestId` and get
`command.accepted`/`command.rejected` replies: `chat.send|history|cancel`, `goal.create|control`,
`task.append|withdraw|unblock|edit`, `team.join|leave`, `agent.control|steer`,
`model.assign|control`, `runner.start|stop`, `settings.update`, `subscribe`.
Server events: `hello`, `project.snapshot` (2s change-detection poll + wake-driven),
`chat.message|delta|tool|completed|error`, `agent.status`.

Chat conversations run as real pi subprocesses in RPC mode with the pi861 runtime extension
loaded; conversation continuity survives console restarts via the recorded pi session file.
Goal control and task mutations go through the real `ProjectCoordinator` (idempotent,
version-checked, file-locked), so the console and any runtime host cooperate on the same state.

## HTTPS

Terminated by the existing host Caddy on 443:

```
pi861.156.238.229.178.sslip.io {
	reverse_proxy 172.17.0.1:3901
}
```

`deploy/caddy-route` holds the block to merge; reload with
`docker exec sub2api-caddy caddy reload --config /etc/caddy/Caddyfile`.
