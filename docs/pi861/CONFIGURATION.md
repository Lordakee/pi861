# Pi861 配置说明（CONFIGURATION）

- 首版日期：2026-09-22（P1 阶段交付）。依据代码 `e3f07a789b7648f26ec72ce65fa5856046dbd6d3`；入口与行号相对 `extensions/pi861/`。
- 本文以实际代码为准列出全部配置面；尚未实现的可配置项（如 pgvector、继承层级）明确标注"未实现"。

## 1. 配置面总览

| 入口 | 配置来源 | 适用场景 |
| --- | --- | --- |
| `index.ts`（基础组合入口，`pi -e ./extensions/pi861/index.ts`） | 编程式 `Pi861Options`（`index.ts:42-48`）+ 环境变量 | 只需要基础 /goal、记忆、可选搜索；或自带记忆 backend 的组合扩展 |
| `runtime.ts`（完整运行入口，需 `PI861_CONFIG` 指向可信绝对路径 JSON） | `RuntimeConfig`（`runtime.ts:34-43`）+ 环境变量 | 模型路由、Skill/MCP、项目调度、Worker/远程节点、外部数据库 |

配置文件不含任何明文密钥：数据库与远程 Worker 凭据在 JSON 中只写**环境变量名**（`database.urlEnv`、`remoteWorkers[].tokenEnv`），运行时从环境读取（G8）。

## 2. 环境变量（以代码为准）

### 2.1 基础入口（index.ts / examples）

| 变量 | 读取位置 | 默认 | 语义 |
| --- | --- | --- | --- |
| `PI861_WEB_SEARCH_ENABLED` | `index.ts:82` | 未设=关闭 | `1` 开启 Brave 搜索（显式 opt-in） |
| `BRAVE_SEARCH_API_KEY` | `index.ts:83` | 无 | Brave 订阅令牌；缺失时搜索报错不伪造 |
| `PI861_AUTO_RECALL` | `index.ts:91` | 未设=开启 | `0` 关闭自动召回（before_agent_start） |
| `PI861_AUTO_CAPTURE` | `index.ts:92` | 未设=开启 | `0` 关闭用户输入自动采集 |
| `PI861_PROJECT_ID` | `index.ts:154` | `digest(cwd).slice(0,24)` | 稳定项目身份；未设置时用 cwd 哈希（仅适合本地试验） |
| `PI861_AGENT_ID` | `index.ts:157` | `main` | 主体标识；生产应由认证服务确定，不由模型填写 |
| `PI861_DATABASE_URL` | `examples/postgres-extension.mjs:12` | 必填（该示例） | PostgreSQL 连接串（示例组合入口） |
| `PI861_TENANT_ID` | 同上 | 必填（该示例） | 租户标识 |
| `PI861_PG_CA_FILE` | 同上:24 | 无 | 受信 CA 文件路径（TLS 默认 rejectUnauthorized） |
| `PI861_PG_ALLOW_LOCAL_PLAINTEXT` | 同上:20 | 关闭 | `1` 且主机为 loopback 时允许明文连接 |

### 2.2 完整 runtime（runtime.ts）

| 变量 | 读取位置 | 默认 | 语义 |
| --- | --- | --- | --- |
| `PI861_CONFIG` | `runtime.ts:45-46` | **必填** | 指向可信 JSON 配置的**绝对路径**（Unix `/` 或 Windows 盘符开头）；不满足即拒绝启动 |
| `PI861_ROLE_ID` | `runtime.ts:86` | `config.role.id` | 覆盖当前岗位（须存在于 role/roles 列表，否则"Agent role has been revoked"） |
| `PI861_INITIAL_MODEL_ID` | `runtime.ts:134` | `config.models.preferred` | 覆盖初始首选模型（同时抬高 minQuality 下限） |
| `PI861_WORKER` | `runtime.ts:92,253,294` | 非 Worker | `1` 时：不注册 /goal、启用 tool_call 守卫、收敛基础工具集 |
| `PI861_WRITE_SCOPES` | `runtime.ts:282,296` | `[]` | Worker 模式写入范围（JSON 字符串数组，由派发方注入；非法即拒绝启动） |
| `PI861_RUNTIME_ENTRY` | `runtime.ts:281` | runtime.ts 自身路径 | Worker 子进程加载的完整入口路径覆盖 |
| `database.urlEnv` 指向的变量（如 `PI861_DATABASE_URL`） | `runtime.ts:71` | 视配置 | 数据库连接串；配置了 database 但变量缺失即抛错 |
| `remoteWorkers[].tokenEnv` 指向的变量 | `runtime.ts:284` | 视配置 | 远程 Worker bearer token（≥24 字符）；缺失即抛错 |

### 2.3 测试/CI 专用

| 变量 | 用途 |
| --- | --- |
| `PI861_TEST_PI_CLI` | 指向已发布 Pi 0.86.1 CLI bundle；两个宿主集成测试缺少它时 skip（CI 中由 pi-host job 注入） |
| `PI861_ALLOW_TEST_DATABASE=1` + `PI861_TEST_POSTGRES_URL` + `PI861_TEST_DRIVER_ROOT` | 仅接受 loopback `pi861_test` 库的 SQL 集成测试（`.github/workflows/pi861-runtime.yml:59-63`） |

## 3. `Pi861Options`（基础入口，`index.ts:42-48`）

| 字段 | 类型/默认 | 说明 |
| --- | --- | --- |
| `managedGoal` | `boolean`，默认 false | true 时基础 /goal 与 goal_report 不注册（由完整 runtime 接管），防双注册 |
| `search` | `SearchOptions`，默认取环境变量（见 2.1） | `{ enabled, apiKey?, maxResults?, maxResponseBytes?, timeoutMs?, fetch? }`；默认 maxResults=5、maxResponseBytes=262144、timeoutMs=15000；`fetch` 仅供测试注入 |
| `goalMaxRuns` | `number`，默认 20 | 基础 /goal 次数预算上限 |
| `memory.backend` | `MemoryBackend`，默认 LocalMemory（会话分支快照） | 外部 backend（如 PostgresMemory）注入点 |
| `memory.scope` | `string`，默认 `project:${PI861_PROJECT_ID}` | 外部 backend 必须显式给 scope；不给即拒绝恢复 |
| `memory.autoRecall` / `autoCapture` | `boolean`，默认取环境变量（开） | 覆盖 2.1 的 env 默认 |
| `memory.maxContextBytes` | `number`，默认 6000 | 召回上下文字节预算 |

## 4. `RuntimeConfig`（完整入口 JSON schema，`runtime.ts:34-51`）

顶层校验（`configFromFile`）：`version` 必须为 **2**；`projectId` 匹配 `^[a-zA-Z0-9_-]+$`；`stateDirectory` 必填（解析为绝对路径并以 0700 创建）；`role.id` 必填。任一不满足即拒绝启动。运行中 `currentRole()` 每次重读配置文件（`runtime.ts:84-90`），支持撤权即时生效。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `version` | `2` | 必填 | 配置 schema 版本 |
| `projectId` | string | 必填 | 稳定项目身份（状态键前缀、记忆 scope） |
| `stateDirectory` | string（绝对路径） | 必填 | 文件状态/集成身份/Worker 会话目录 |
| `tenantId` | string | `local` | 租户 |
| `agentId` | string | `main` | 主体 |
| `database` | `{ urlEnv, driverRoot? }` | 无（文件状态） | `urlEnv`=连接串环境变量名；`driverRoot`=隔离 pg 驱动安装根；池 max=8、连接超时 5s（`runtime.ts:73-74`） |
| `role` / `roles` | `Role` / `Role[]` | 必填 role | 岗位：`{ id, skillIds[], grants[{toolId,accountId,resourceIds[]}] }` |
| `environment` | string[] | `[]` | 节点能力通告（分支激活 environment 前置 + Worker capabilities） |
| `mcp` | `McpServer[]` | `[]` | `{ id, accountId, transport: stdio{process} \| http{url,headers?,allowLoopbackHttp?}, timeoutMs?, maxBytes? }`；HTTP 强制 HTTPS（显式 loopback 例外） |
| `resourceRules` | `ResourceRule[]` | `[]` | `{ toolId, accountId, resourceId, equals?, endpointConfined?, readOnly? }`；equals 为参数点路径等值约束 |
| `models` | `ModelPolicy & { intakeId, enableRouting?, maxOutputTokens? }` | 无（不启用模型运行时） | 见下表 |
| `memory` | `{ autoRecall?, autoCapture?, autoEnrich?, modelId?, maxJobsPerWake? }` | 见 2.1；autoEnrich 默认关、maxJobsPerWake=2 | autoEnrich 需同时配置 modelId |
| `skills` | `{ compilerModelId? }` | 无 | 配置后 /skills install 自动触发编译 |
| `project` | 见下 | 无（不启用项目调度） | 完整 /goal 与 Worker 池 |
| `budget` | `{ maxRequests }` | 1000 | 全局模型请求配额 |

`models`（ModelPolicy，`src/live/model-runtime.ts:10-14`；`recovery` 选项无默认，必须显式给全）：

| 字段 | 说明 |
| --- | --- |
| `targets[]` | ModelTarget：`{ id, revision, provider, model, quality, costRank, contextWindow, capabilities[], enabled }`（账户/故障域/计费字段未实现，R1.1） |
| `preferred` | 初始首选（可被 `PI861_INITIAL_MODEL_ID` 覆盖） |
| `requirements` | `{ minQuality, contextTokens, capabilities[], allowedIds[] }` 硬过滤 |
| `recovery` | `{ failoverEnabled, failbackEnabled, probeIntervalMs, maxProbeIntervalMs, requiredProbeSuccesses }`（构造时严格校验） |
| `maxAttempts` / `requestTimeoutMs` | 每请求尝试次数与单次尝试超时 |
| `maxRequests` / `maxProbeRequests` | 请求/探测配额 |
| `intakeId` | 接待分类模型（targets 内 id） |
| `enableRouting` | `false` 时禁用动态分类（仅固定+升级） |
| `maxOutputTokens` | 默认 8192 |

`project`（`runtime.ts:41`；`CheckCommand` 见 `src/live/workspace.ts:9`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `repository` / `worktreeRoot` | 必填 | 源仓库与 worktree 根（必须在源工作树之外） |
| `cli` | 必填 | Pi CLI 入口（Worker 子进程用） |
| `maxConcurrent` / `maxTasks` | 2 / 100 | 本地 Worker 槽数 / 任务总数上限 |
| `checks[]` | 必填（每任务至少引用一个） | `{ id, command, args[], timeoutMs?, env? }` 检查命令白名单（仅 id 可被计划引用） |
| `plannerModelId` | 必填 | 只读规划模型（targets 内） |
| `allowWorkerShell` | false | Worker 是否允许 bash/powershell |
| `workerEnv` / `workerExtensionPaths` | 无 | Worker 子进程环境/额外扩展 |
| `remoteWorkers[]` | 无 | `{ identity, url, tokenEnv, allowLoopbackHttp? }`；URL 强制 HTTPS（显式 loopback 例外） |

## 5. 优先级与继承（当前真实规则）

1. **编程式 options > 环境变量 > 内置默认**：如 `Pi861Options.memory.autoRecall` 显式给出则覆盖 `PI861_AUTO_RECALL`；二者皆无则默认开启。
2. **运行时覆盖配置文件**：`PI861_ROLE_ID` > `config.role.id`；`PI861_INITIAL_MODEL_ID` > `config.models.preferred`（并抬高 minQuality）。`/model-policy` 可在运行中切换 failover/failback（不重做已完成操作）。
3. **派发方向注入**：协调者把任务的 `modelId/roleId/writeScopes` 经 `PI861_INITIAL_MODEL_ID/PI861_ROLE_ID/PI861_WRITE_SCOPES` 注入 Worker 子进程（`runtime.ts:282`），Worker 端非法值直接拒绝启动。
4. **未实现**：全局默认 → 项目/岗位设置 → Agent 覆盖 → 子 Agent 继承的层级体系（R1.7/R6.18 缺口，P1 契约 C1 落地点）；授权范围不因任何覆盖自动扩大。

## 6. 开关矩阵

| 开关 | 位置 | 默认 | 关闭时的行为 |
| --- | --- | --- | --- |
| 联网搜索 | `PI861_WEB_SEARCH_ENABLED` / `Pi861Options.search.enabled` | 关 | 不注册搜索模型工具；/web-search 报错；无密钥不伪造 |
| 自动召回 | `PI861_AUTO_RECALL` / options / `config.memory.autoRecall` | 开 | before_agent_start 不注入记忆上下文 |
| 自动采集（输入） | `PI861_AUTO_CAPTURE` / options / `config.memory.autoCapture` | 开 | 用户输入不写候选记录 |
| 自动采集（工具结果） | `config.memory.autoCapture`（runtime 侧，`runtime.ts:208`） | 开 | tool_execution_end 不写 evidence 记录 |
| 自动提炼 | `config.memory.autoEnrich` + `modelId` | 关 | 不后台提炼；仍可 `/memory-maintain` 手动批次 |
| 动态路由 | `config.models.enableRouting` | 开（有 models 时） | 不做接待分类，仅固定+异常升级 |
| failover / failback | `config.models.recovery.*` + `/model-policy` | 配置必填 | 关 failover：不自动切备用、不赶回已处备用；关 failback：不回切、清探测 |
| Worker Shell | `config.project.allowWorkerShell` | 关 | bash/powershell 被 tool_call 守卫拒绝；基础工具集收敛为 read/write/edit/grep/find/ls/pi861_memory/pi861_model_route（`runtime.ts:307`） |
| Worker 模式 | `PI861_WORKER=1` | 关 | 见 2.2；与 /goal 注册互斥 |
| 原始 Skill 被动发现 | skills-host 固定行为（`skills-host.ts:150`） | 关 | `options.skills=[]`，仅显式 /skill:name 可用原始 Skill |

## 7. 安全部署示例

### 7.1 基础入口（无外部依赖）

```sh
pi -e ./extensions/pi861/index.ts
# 可选搜索（Linux/macOS）：
export PI861_WEB_SEARCH_ENABLED=1
export BRAVE_SEARCH_API_KEY='<由环境或密钥管理器注入>'
```

### 7.2 PostgreSQL 组合入口（外部记忆权威）

```sh
# 1) 迁移账号执行：psql -f extensions/pi861/sql/memory-v1.sql（专用库/受控 schema）
# 2) 运行账号：非超级用户、非 BYPASSRLS，仅授必要表 SELECT/INSERT/UPDATE
export PI861_DATABASE_URL='postgresql://pi861_run@db.internal:5432/pi861'
export PI861_TENANT_ID='acme'
export PI861_AGENT_ID='main'
export PI861_PROJECT_ID='billing-refactor'
# 远程默认验证 TLS；自签环境附加：
export PI861_PG_CA_FILE='/etc/pi861/ca.pem'
pi -e ./extensions/pi861/examples/postgres-extension.mjs
```

### 7.3 完整 runtime（脱敏示例；当前受 P0 阻塞，语法以修复后为准）

```jsonc
// /etc/pi861/billing.json（0600，operator 所有）
{
  "version": 2,
  "projectId": "billing-refactor",
  "stateDirectory": "/var/lib/pi861/billing",
  "tenantId": "acme",
  "agentId": "coordinator",
  "database": { "urlEnv": "PI861_DATABASE_URL" },
  "role": { "id": "dev", "skillIds": ["debug-general"],
    "grants": [{ "toolId": "jira/debug", "accountId": "acme", "resourceIds": ["PROJ-1"] }] },
  "mcp": [{ "id": "jira", "accountId": "acme",
    "transport": { "kind": "http", "url": "https://mcp.internal.acme.example/jira" } }],
  "resourceRules": [{ "toolId": "jira/debug", "accountId": "acme", "resourceId": "PROJ-1",
    "equals": { "project": "PROJ-1" }, "readOnly": true }],
  "models": {
    "preferred": "primary", "intakeId": "cheap", "enableRouting": true, "maxOutputTokens": 8192,
    "requirements": { "minQuality": 0.6, "contextTokens": 32000, "capabilities": ["text"], "allowedIds": ["primary", "cheap"] },
    "recovery": { "failoverEnabled": true, "failbackEnabled": true,
      "probeIntervalMs": 30000, "maxProbeIntervalMs": 600000, "requiredProbeSuccesses": 2 },
    "maxAttempts": 3, "requestTimeoutMs": 120000, "maxRequests": 1000, "maxProbeRequests": 50,
    "targets": [
      { "id": "primary", "revision": "2026-09", "provider": "<provider>", "model": "<model>",
        "quality": 0.9, "costRank": 3, "contextWindow": 200000, "capabilities": ["text"], "enabled": true },
      { "id": "cheap", "revision": "2026-09", "provider": "<provider>", "model": "<model>",
        "quality": 0.6, "costRank": 1, "contextWindow": 64000, "capabilities": ["text"], "enabled": true }
    ]
  },
  "memory": { "autoRecall": true, "autoCapture": true, "autoEnrich": true, "modelId": "cheap", "maxJobsPerWake": 2 },
  "skills": { "compilerModelId": "cheap" },
  "project": {
    "repository": "/srv/git/billing", "worktreeRoot": "/srv/pi861-worktrees/billing",
    "cli": "/opt/pi-coding-agent/dist/bundle/cli.js",
    "maxConcurrent": 2, "maxTasks": 100, "plannerModelId": "primary", "allowWorkerShell": false,
    "checks": [{ "id": "typecheck", "command": "node", "args": ["node_modules/typescript/bin/tsc", "--noEmit"], "timeoutMs": 300000 }],
    "remoteWorkers": [{ "identity": { "id": "node-b", "capabilities": ["linux"], "roleIds": ["dev"], "modelIds": ["primary", "cheap"] },
      "url": "https://worker-b.internal.acme.example/", "tokenEnv": "PI861_WORKER_B_TOKEN" }]
  },
  "budget": { "maxRequests": 1000 }
}
```

```sh
export PI861_CONFIG=/etc/pi861/billing.json
export PI861_DATABASE_URL='postgresql://pi861_run@db.internal:5432/pi861'
export PI861_WORKER_B_TOKEN='<≥24 字符强随机>'
pi -e ./extensions/pi861/runtime.ts
```

注意：完整入口当前因 `runtime.ts` TS1005 不能通过类型检查（P0 修复中）；上例为修复后形态的参考。

### 7.4 Worker 模式（由协调者派生，一般不手工运行）

协调者按任务注入 `PI861_WORKER=1`、`PI861_CONFIG`、`PI861_INITIAL_MODEL_ID`、`PI861_ROLE_ID`、`PI861_WRITE_SCOPES`（`runtime.ts:280-286`）；远程 Worker 侧还需独立检出与 `RemoteWorkerServer` 部署（可执行启动入口属 R3.13 未实现项，当前仅类+测试）。

## 8. 升级、停机、恢复与回滚（当前可用项）

| 操作 | 现状 |
| --- | --- |
| 启动恢复 | 模型路由 checkpoint（policyHash 校验，恢复即 generation+1）、激活 Skill 重激活、Goal 被动降级 paused、项目状态从 store 恢复、远程 Worker 重启将未决任务置 unknown |
| 停机收敛 | `session_shutdown`：停止派发→关闭模型运行时→暂停 Runner→等待提炼→关闭数据库池（`runtime.ts:308`） |
| 记忆迁移 | `sql/memory-v1.sql` 为增量迁移（IF NOT EXISTS）；由迁移账号手工执行；升级前备份属运维要求（未自动化，R6.14） |
| Skill 回滚 | `/skills rollback ID REVISION` |
| 状态回滚 | 文件状态下为 operator 手工处置 stateDirectory（无内建命令）；PostgreSQL 状态键按行覆盖写（无版本历史） |
| 配置热更新 | 仅岗位（currentRole 每次重读文件）与 /model-policy 开关；其余字段需重启 |

## 9. 安全注意事项（部署清单）

1. `PI861_CONFIG` 必须指向 operator 控制的绝对路径（入口强制）；文件权限 0600。
2. 数据库运行账号非超级用户、非 BYPASSRLS；迁移与运行账号分离；连接串不进模型上下文。
3. 远程 Worker 与 MCP 强制 HTTPS + 强 bearer token；明文仅限显式声明的 loopback 测试。
4. 检查命令白名单（checks）里的可执行文件本身受 operator 信任（文件守卫不沙箱检查程序）。
5. 状态目录 0700；集成身份文件 0600；`stateDirectory` 不应放进源仓库。
6. 密钥只经环境变量注入；日志与错误输出有启发式脱敏（publicError），不保证识别所有秘密。
