# Pi861 配置说明（CONFIGURATION）

- 首版日期：2026-09-22（P1 阶段交付）。本文于 2026-09-27 同步 M1-M5 已合入代码 `d45b981b4b493ce322c4af6ae2c90a320f0b48a5`。
- 引用以**符号**（接口/函数/命令）为准并标注源文件（相对 `extensions/pi861/`），不绑定行号；尚未接入某个入口的可配置项明确标注（如"库层 API，RuntimeConfig 未暴露"）。

## 1. 配置面总览

| 入口 | 配置来源 | 适用场景 |
| --- | --- | --- |
| `index.ts`（基础组合入口，`pi -e ./extensions/pi861/index.ts`） | 编程式 `Pi861Options` + 环境变量 | 只需要基础 /goal、记忆、可选搜索；或自带记忆 backend 的组合扩展 |
| `runtime.ts`（完整运行入口，需 `PI861_CONFIG` 指向可信绝对路径 JSON） | `RuntimeConfig`（`configFromFile` 校验）+ 环境变量 | 模型路由、Skill/MCP、项目调度、Worker/远程节点、外部数据库 |
| `src/live/worker-service.ts`（远程 Worker 独立部署入口，R3.13） | operator 持有的 service JSON + 环境变量 | 在 Worker 节点上常驻提供 HTTP 任务执行服务 |

配置文件不含任何明文密钥：数据库与远程 Worker 凭据在 JSON 中只写**环境变量名**（`database.urlEnv`、`remoteWorkers[].tokenEnv`、worker-service 的 `tokenEnv`），运行时从环境读取（G8）。

## 2. 环境变量（以代码为准）

### 2.1 基础入口与库层（index.ts / src/search.ts / src/web-read.ts）

| 变量 | 读取位置 | 默认 | 语义 |
| --- | --- | --- | --- |
| `PI861_WEB_SEARCH_ENABLED` | `index.ts`（installPi861） | 未设=关闭 | `1` 开启 Brave 搜索（显式 opt-in） |
| `BRAVE_SEARCH_API_KEY` | `index.ts`（installPi861） | 无 | Brave 订阅令牌；缺失时搜索报错不伪造 |
| `PI861_WEB_READ_ENABLED` | `src/web-read.ts`（`webReadOptionsFromEnv`） | 未设=关闭 | `1` 开启有界网页读取（显式 opt-in） |
| `PI861_WEB_READ_HOSTS` | 同上 | 空 | 逗号分隔**公共主机**白名单：精确名或 `*.suffix` 通配；仅允许协议默认端口（https 443 / http 80），每跳经 DNS/SSRF 防护 |
| `PI861_WEB_READ_INTERNAL_ENDPOINTS` | 同上 | 空 | 逗号分隔**受批内部端点**，精确 `scheme://host[:port]` 匹配（与公共主机不同的批准类型）；内部端点不做公共地址黑名单检查，但连接同样绑定已验证地址（防 DNS rebinding） |
| `PI861_AUTO_RECALL` | `index.ts`（installPi861） | 未设=开启 | `0` 关闭自动召回（before_agent_start） |
| `PI861_AUTO_CAPTURE` | `index.ts`（installPi861） | 未设=开启 | `0` 关闭用户输入自动采集 |
| `PI861_PROJECT_ID` | `index.ts`（restore） | `digest(cwd).slice(0,24)` | 稳定项目身份；未设置时用 cwd 哈希（仅适合本地试验） |
| `PI861_AGENT_ID` | `index.ts`（restore） | `main` | 主体标识；生产应由认证服务确定，不由模型填写 |
| `PI861_DATABASE_URL` | `examples/postgres-extension.mjs` | 必填（该示例） | PostgreSQL 连接串（示例组合入口） |
| `PI861_TENANT_ID` | 同上 | 必填（该示例） | 租户标识 |
| `PI861_PG_CA_FILE` | 同上 | 无 | 受信 CA 文件路径（TLS 默认 rejectUnauthorized） |
| `PI861_PG_ALLOW_LOCAL_PLAINTEXT` | 同上 | 关闭 | `1` 且主机为 loopback 时允许明文连接 |

补充（`WebReadOptions` 编程默认，非环境变量）：maxBytes=262144、timeoutMs=15000、maxRedirects=3、cacheTtlMs=600000（每 options 对象 32 条 TTL 缓存）。读取仅接受 `text/*`、xhtml/xml/json/rss/atom 内容类型；重定向逐跳重新审批；输出标记 `untrusted: true`。

### 2.2 完整 runtime 与 Worker（runtime.ts / worker-service.ts）

| 变量 | 读取位置 | 默认 | 语义 |
| --- | --- | --- | --- |
| `PI861_CONFIG` | `runtime.ts`（`configFromFile`） | **必填** | 指向可信 JSON 配置的**绝对路径**（Unix `/` 或 Windows 盘符开头）；不满足即拒绝启动 |
| `PI861_ROLE_ID` | `runtime.ts`（`currentRole`） | `config.role.id` | 覆盖当前岗位（须存在于 role/roles 列表，否则"Agent role has been revoked"） |
| `PI861_INITIAL_MODEL_ID` | `runtime.ts`（`initialize`） | `config.models.preferred` | 覆盖初始首选模型（同时抬高 minQuality 下限） |
| `PI861_WORKER` | `runtime.ts` | 非 Worker | `1` 时：不注册 /goal、启用 tool_call 守卫、收敛基础工具集 |
| `PI861_WRITE_SCOPES` | `runtime.ts` | `[]` | Worker 模式写入范围（JSON 字符串数组，由派发方注入；非法即拒绝启动） |
| `PI861_RUNTIME_ENTRY` | `runtime.ts`（/goal 派发） | runtime.ts 自身路径 | 本地 Worker 子进程加载的完整入口路径覆盖 |
| `PI861_WORKER_SERVICE_CONFIG` | `src/live/worker-service.ts` | 无 | worker-service 启动配置 JSON 路径（也可用 `--config` 参数） |
| `database.urlEnv` 指向的变量（如 `PI861_DATABASE_URL`） | `runtime.ts`（启动） | 视配置 | 数据库连接串；配置了 database 但变量缺失即抛错 |
| `remoteWorkers[].tokenEnv` / worker-service `tokenEnv` 指向的变量 | `runtime.ts` / `worker-service.ts` | 视配置 | 远程 Worker bearer token（≥24 字符）；缺失即抛错 |

### 2.3 测试/CI 专用

| 变量 | 用途 |
| --- | --- |
| `PI861_TEST_PI_CLI` | 指向已发布 Pi 0.86.1 CLI bundle；两个宿主集成测试缺少它时 skip（CI 中由 pi-host job 注入） |
| `PI861_ALLOW_TEST_DATABASE=1` + `PI861_TEST_POSTGRES_URL` + `PI861_TEST_DRIVER_ROOT` | 仅接受 loopback `pi861_test` 库的 SQL 集成测试（`.github/workflows/pi861-runtime.yml`） |

## 3. `Pi861Options`（基础入口）

| 字段 | 类型/默认 | 说明 |
| --- | --- | --- |
| `managedGoal` | `boolean`，默认 false | true 时基础 /goal 与 goal_report 不注册（由完整 runtime 接管），防双注册 |
| `search` | `SearchOptions`，默认取环境变量（见 2.1） | `{ enabled, provider?, apiKey?, maxResults?, maxResponseBytes?, timeoutMs?, fetch? }`；provider 目前仅 `"brave"`（`resolveSearchProvider`）；默认 maxResults=5、maxResponseBytes=262144、timeoutMs=15000；`fetch` 仅供测试注入 |
| `goalMaxRuns` | `number`，默认 20 | 基础 /goal 次数预算上限 |
| `memory.backend` | `MemoryBackend`，默认 LocalMemory（会话分支快照） | 外部 backend（如 PostgresMemory）注入点 |
| `memory.scope` | `string`，默认 `project:${PI861_PROJECT_ID}` | 外部 backend 必须显式给 scope；不给即拒绝恢复 |
| `memory.autoRecall` / `autoCapture` | `boolean`，默认取环境变量（开） | 覆盖 2.1 的 env 默认 |
| `memory.maxContextBytes` | `number`，默认 6000 | 召回上下文字节预算 |

搜索结果超限走受控分页（R7.7，库层 `searchPayload`/`ControlledResults`：最多 64 条 / 总量 4 MiB / TTL 10 分钟，超 16000 字节内联阈值转为分页引用）。

## 4. `RuntimeConfig`（完整入口 JSON schema）

顶层校验（`configFromFile`）：`version` 必须为 **2**；`projectId` 匹配 `^[a-zA-Z0-9_-]+$`；`stateDirectory` 必填（解析为绝对路径并以 0700 创建）；`role.id` 必填。任一不满足即拒绝启动。运行中 `currentRole()` 每次重读配置文件，支持撤权即时生效。

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `version` | `2` | 必填 | 配置 schema 版本 |
| `projectId` | string | 必填 | 稳定项目身份（状态键前缀、记忆 scope） |
| `stateDirectory` | string（绝对路径） | 必填 | 文件状态/集成身份/Worker 会话目录 |
| `tenantId` | string | `local` | 租户 |
| `agentId` | string | `main` | 主体 |
| `database` | `{ urlEnv, driverRoot? }` | 无（文件状态） | `urlEnv`=连接串环境变量名；`driverRoot`=隔离 pg 驱动安装根；池 max=8、连接超时 5s |
| `role` / `roles` | `Role` / `Role[]` | 必填 role | 岗位：`{ id, skillIds[], grants[{toolId,accountId,resourceIds[]}] }` |
| `environment` | string[] | `[]` | 节点能力通告（分支激活 environment 前置 + Worker capabilities） |
| `mcp` | `McpServer[]` | `[]` | `{ id, accountId, transport: stdio{process} \| http{url,headers?,allowLoopbackHttp?}, timeoutMs?, maxBytes?, reconnect?{maxAttempts?,baseDelayMs?} }`；HTTP 强制 HTTPS（显式 loopback 例外）；reconnect 仅限建连，工具派发永不重放 |
| `resourceRules` | `ResourceRule[]` | `[]` | `{ toolId, accountId, resourceId, equals?, endpointConfined?, readOnly? }`；equals 为参数点路径等值约束；endpointConfined 在 production-isolated 模式被拒绝（见 §7） |
| `models` | `ModelPolicy & { intakeId, enableRouting?, maxOutputTokens? }` | 无（不启用模型运行时） | 见下表 |
| `memory` | `{ autoRecall?, autoCapture?, autoEnrich?, modelId?, maxJobsPerWake? }` | 见 2.1；autoEnrich 默认关、maxJobsPerWake=2 | autoEnrich 需同时配置 modelId |
| `skills` | `{ compilerModelId? }` | 无 | 配置后 /skills install 自动触发编译 |
| `project` | 见下 | 无（不启用项目调度） | 完整 /goal 与 Worker 池 |
| `budget` | `{ maxRequests }` | 1000 | 全局模型请求配额（`RequestBudget`，按意图幂等预留） |

`models`（ModelPolicy，`src/live/model-runtime.ts`；`recovery` 核心字段无默认，必须显式给全）：

| 字段 | 说明 |
| --- | --- |
| `targets[]` | ModelTarget，见下；构造校验见 `ModelRecovery` 构造函数 |
| `preferred` | 初始首选（可被 `PI861_INITIAL_MODEL_ID` 覆盖），须满足 requirements |
| `requirements` | `{ minQuality, contextTokens, capabilities[], allowedIds[], dataBoundary? }` 硬过滤；`dataBoundary` 设定时仅 `dataEgress` **精确匹配**的目标可参与路由 |
| `recovery` | `{ failoverEnabled, failbackEnabled, probeIntervalMs, maxProbeIntervalMs, requiredProbeSuccesses, maxConcurrentProbes?, probeBudget? }`（构造时严格校验；`maxConcurrentProbes` 默认 1、`probeBudget` 默认无限） |
| `maxAttempts` / `requestTimeoutMs` | 每请求尝试次数与单次尝试总超时 |
| `requestDeadlines` | 可选 `{ connectMs?, firstResponseMs?, progressMs? }`（正整数）：单次尝试的连接/首响应/进度间隔细粒度deadline，违规按 transient 失败并标注 phase（connect/first-response/progress/total）；总时限仍为 requestTimeoutMs |
| `maxRequests` / `maxProbeRequests` | 请求/探测配额 |
| `intakeId` | 接待分类模型（targets 内 id） |
| `enableRouting` | `false` 时禁用动态分类（仅固定+升级） |
| `maxOutputTokens` | 默认 8192 |

ModelTarget 必填字段（`src/routing.ts`；缺一或非法即"Invalid or duplicate model configuration"）：

| 字段 | 类型/校验 | 说明 |
| --- | --- | --- |
| `id` / `revision` / `provider` / `model` | 非空字符串；id 唯一 | 目标身份与提供方模型名 |
| `quality` / `costRank` | 有限数 ≥ 0 | 质量分数与成本序（小者先选） |
| `contextWindow` | 安全整数 > 0 | 上下文窗口（token） |
| `capabilities[]` / `enabled` | 字符串数组 / 布尔 | 能力标签与启用位 |
| `account` | 非空字符串 | **账户故障域**：健康状态按 `provider\|account\|endpoint` 共享（`HealthService.key`），同账户目标共同进退 |
| `endpoint` | 非空字符串 | **端点故障域**（网关/主机标识），与 account 一起构成共享健康键 |
| `billing` | `{ inputPerMillionTokens, outputPerMillionTokens, cacheReadPerMillionTokens?, cacheWritePerMillionTokens?, currency? }`；费率为有限数 ≥ 0 | 已知定价：提供方未上报成本时按此估算（`estimateCost`），供用量台账（`UsageLedger`）记账；未知用量记 unknown 不补零 |
| `dataEgress` | 非空字符串 | **数据出域边界标签**；`requirements.dataBoundary` 可钉死精确边界 |

`project`（`runtime.ts` ProjectConfig；`CheckCommand` 见 `src/live/workspace.ts`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `repository` / `worktreeRoot` | 必填 | 源仓库与 worktree 根（必须在源工作树之外） |
| `cli` | 必填 | Pi CLI 入口（Worker 子进程用） |
| `maxConcurrent` / `maxTasks` | 2 / 100 | 本地 Worker 槽数 / 任务总数上限 |
| `reviewSlots` | 1 | **独立复审池**（`config.project.reviewSlots` 传入 BoardOptions；见 §8.1） |
| `checks[]` | 必填（每任务至少引用一个） | `{ id, command, args[], timeoutMs?, env? }` 检查命令白名单（仅 id 可被计划引用） |
| `plannerModelId` | 必填 | 只读规划模型（targets 内） |
| `allowWorkerShell` | false | Worker 是否允许 bash/powershell |
| `workerEnv` / `workerExtensionPaths` | 无 | Worker 子进程环境/额外扩展 |
| `remoteWorkers[]` | 无 | `{ identity, url, tokenEnv, allowLoopbackHttp? }`；URL 强制 HTTPS（显式 loopback 例外） |

## 5. 优先级与继承（当前真实规则）

1. **编程式 options > 环境变量 > 内置默认**：如 `Pi861Options.memory.autoRecall` 显式给出则覆盖 `PI861_AUTO_RECALL`；二者皆无则默认开启。
2. **运行时覆盖配置文件**：`PI861_ROLE_ID` > `config.role.id`；`PI861_INITIAL_MODEL_ID` > `config.models.preferred`（并抬高 minQuality）。`/model-policy`（`status | failover on/off | failback on/off | escalate`）可在运行中切换 failover/failback（不重做已完成操作；关 failback 即停探测并清定时器）。
3. **派发方向注入**：协调者把任务的 `modelId/roleId/writeScopes` 经 `PI861_INITIAL_MODEL_ID/PI861_ROLE_ID/PI861_WRITE_SCOPES` 注入本地 Worker 子进程，Worker 端非法值直接拒绝启动。
4. **模型策略层级（`resolveModelPolicy`，`src/live/model-runtime.ts`）**：全局默认 → Agent → 子 Agent 逐层解析，**每层只允许收紧**（违反即抛错，末尾构造 `ModelRecovery` 复验一致性）：
   - `targets`：只能从继承目录移除目标（保留的同 id 条目须与父层完全一致）；
   - `allowedIds`：只能收窄为父层子集；`minQuality`/`contextTokens` 只能升；`capabilities` 只能增要求；
   - `dataBoundary`：父层已钉死则不可更改（不可放松）；
   - `recovery`：不得重新启用父层关闭的 failover/failback；probeIntervalMs 不低于父层、maxProbeIntervalMs 不高于父层、requiredProbeSuccesses 不低于父层、maxConcurrentProbes/probeBudget 不高于父层；
   - `maxAttempts`/`requestTimeoutMs`/`maxRequests`/`maxProbeRequests` 只能降；`preferred` 可改。
   - 该层级为库层 API；`RuntimeConfig.models` 目前只承载全局基线，未暴露分层字段。
5. **记忆开关层级（`resolveMemorySettings`，`src/memory.ts`）**：tenant → project → role 三层 `MemorySettingsChain`，**按键覆盖**：更具体的层级显式设置的键生效，未设置的键继承上层，全未设置默认开启；非布尔值抛错。授权范围不因任何覆盖自动扩大。同样为库层 API，`RuntimeConfig.memory` 为扁平字段。

## 6. 记忆自动化与维护（LayeredMemory）

配置面（`RuntimeConfig.memory` + 库层 `LayeredMemoryOptions`）与命令：

| 项 | 说明 |
| --- | --- |
| 开关继承 | `resolveMemorySettings` 三层链（见 §5 第 5 条）；`autoRecall`/`autoCapture`/`autoEnrich` 按键继承 |
| 提炼队列 | 每条 user/tool 来源的已提交记录入队 `queued`；记录再变更使旧任务 `obsolete` 并重建投影。`enrich()` 批处理：任务带 token 与 `expiresAt`（超时+5s）防僵尸占位，恢复时按 token 校验 |
| 重试与死信 | 失败按 `classifyExtractionFailure` 分为 `transient`/`invalid_output`/`unknown`；`retry` 策略默认 maxAttempts=3、baseDelayMs=30000（指数倍增）；attempts 耗尽进入 **dead（死信）** |
| 死信处置 API | `deadJobs()` 列出死信；`retryJob(id)` 将 dead/failed 重新入队并**重置尝试预算**；`abandonJob(id)` 仅对 dead 丢弃（不再派生任何内容）。库层 API（`src/live/layered-memory.ts`） |
| 手动批次 | `/memory-maintain`（runtime 命令）：处理 `maxJobsPerWake`（默认 2）个提炼任务，需配置 `memory.modelId` |
| reconcile 语义 | `reconcile()` 修复**委派两阶段提交崩溃窗口**（item 已在权威 backend 提交、控制状态事务未跑）：以 items backend 为权威逐条重整合缺失的 change/job；**幂等**（重跑零新增）；嵌入（非委派）模式恒返回 0。权威枚举优先 `exportItems`，否则 `list` 分页（看不到 withdrawn）；无事件日志时中间版本不可重建。启动/运维时调用（库层 API） |
| 增量同步 | `delta(afterSequence)` 游标分页 + `ContextAssembler`（session_start/resume、model_change、compaction、node_change 触发的上下文组装与事件召回），供对等节点刷新派生视图 |

## 7. Skill/MCP 管理与部署边界

| 项 | 说明 |
| --- | --- |
| `deploymentMode` | `CapabilityOptions.deploymentMode`（`src/live/skills-host.ts`，R5.11），默认 `trusted-local`。**trusted-local**：单操作者机器；允许本地 stdio server 与显式 `allowLoopbackHttp` 的 HTTP；原始 Skill 源、shell、脚本仍在同一岗位检查之后。**production-isolated**：共享宿主；MCP server 必须为远端 **HTTPS**（禁 stdio 子进程、禁明文 HTTP 含 loopback），且 `resourceRules` 中的 `endpointConfined` 断言被拒绝——共享主机上必须用 `equals` 参数点等值约束。库层选项，`RuntimeConfig` 未暴露该字段 |
| `/skills` 命令（runtime） | `install PATH ID GROUP`（revision 自动为内容 digest；配置 compilerModelId 时安装即编译）｜`compile GROUP`｜`publish CANDIDATE`（交互确认）｜`rollback ID REVISION`｜缺省 browse |
| `installAuto` 自动归组 | `SkillRepository.installAuto`（R4.3，库层 API）：分类器基于完整归档文档与现有活跃分组挑选能力组，同组的等价通用 Skill 在编译期去重；`override.group` 保留**人工 GROUP 为显式覆盖**；返回同组 related 源列表。identity.revision 省略或 `"auto"` 时按文件内容 digest 生成 |
| 发布证据四分类 | `structural` / `behavioral` / `human-review` / `human-acceptance`（`EvidenceKind`）。发布（`publish`，R4.9）必须提供 **structural + 至少一种确认类**（behavioral/human-review/human-acceptance），裸 `passed:true` 不算验收；旧字符串前缀 `user-reviewed`→human-review、`test`→behavioral 兼容映射。`/skills publish` 以 `user-reviewed:` 证据记录人工评审 |
| `uninstall(id)` | 移除源包及其**全部派生运行时版本与候选**；已激活会话保留其 pin 的快照，恢复时再校验（库层 API） |
| `staleVersions()` | 列出组内活跃源集合与编译时 sourceSet 不再一致的已发布版本（受影响重建视图，R4.10；库层 API） |
| MCP 发布 | `/mcp refresh SERVER`：发现元数据并按 resourceRules 生成确定性资源绑定 Skill（仅授权分支出现在岗位视图，工具激活前不生效）；`/mcp operations` / `/mcp resolve` 管理未知结局操作的对账 |

## 8. 项目调度与远程 Worker

### 8.1 调度参数

| 项 | 位置 | 默认 | 说明 |
| --- | --- | --- | --- |
| `maxConcurrent` / `maxAttempts` | `BoardOptions`（`src/scheduler.ts`，经 `ProjectCoordinator`） | runtime 传 2 / 2 | 并发执行槽与单任务尝试上限 |
| `reviewSlots` | `BoardOptions`（`src/scheduler.ts`） | **库层未设**；runtime 传 `config.project.reviewSlots ?? 1` | **独立复审池**：库层未设时 review 状态任务与 running 一起占用 maxConcurrent；设定后 running 单独对 maxConcurrent 计数、review 池单独封顶 reviewSlots，池满即拒绝新领取（review-capacity 背压，`explainConcurrency` 给出原因）。runtime 从 `RuntimeConfig.project.reviewSlots` 传入，未配置时默认 1（即默认就启用独立复审池） |
| `leaseMs` / `maxTaskMs` / `idlePollMs` | `ProjectRunnerOptions`（库层） | 60000 / 600000 / 1000 | 执行租约（心跳按 leaseMs/3 续） / 单任务上限 / 空闲轮询兜底 |
| `integrationLeaseMs` | `ProjectRunnerOptions`（库层） | 120000 | 集成工作区**单执行者租约 TTL**（durable lease + generation）。持租期间**无自动续约**：集成（merge + 检查 + verify）必须在 TTL 内完成，即最大集成时长受 integrationLeaseMs 约束；到期后其他执行者可接管，但需等待旧 Git 进程收敛（探测 git 锁，重试至 TTL×2+5s 截止）；verify 必须携带与当前租约一致的 generation |

### 8.2 worker-service 独立部署入口（`src/live/worker-service.ts`，R3.13）

启动：`node --experimental-strip-types src/live/worker-service.ts --config service.json`（或 `PI861_WORKER_SERVICE_CONFIG` 指向该 JSON）。bearer token 只经 `tokenEnv` 环境变量注入（≥24 字符，缺失即拒绝启动）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `repository` / `worktreeRoot` / `statePath` | 必填 | 源仓库 / worktree 根 / 任务状态文件 |
| `tokenEnv` | 必填 | bearer token 环境变量名 |
| `host` / `port` | `127.0.0.1` / `0`（随机） | 监听地址；对协调者暴露需显式绑外网地址并配 TLS 终结（协调者侧 URL 强制 HTTPS，仅显式 loopback 例外） |
| `heartbeatMs` | 30000（下限 1000） | 心跳间隔：每次向 stdout 输出一行 JSON 状态（identity、容量、任务计数、uptime） |
| `identity` | 必填 | `{ id, capabilities[], roleIds[], modelIds[] }` 节点身份与能力通告 |
| `maxConcurrent` / `checks[]` | 必填 | 并发上限 / 检查命令白名单（请求无法携带命令、凭据或宿主路径） |
| `worker` | 必填 | `{ command, args[], env? }`：在**每个任务工作区**内运行的 Worker 进程模板；operator 负责指向带 worker 模式环境变量的 Pi861 runtime 入口 |

运行面：HTTP 接口 `GET /status`（心跳/容量通告视图）、`GET /jobs/:id`、`POST /jobs`、`POST /cancel`（均需 bearer token，常量时间比较）；服务重启将未决任务置 `unknown`（崩溃方的状态不证明操作未发生，绝不盲目重放）。`SIGTERM`/`SIGINT` 触发收敛式停机：中止运行中任务（置 unknown）、关闭 HTTP 服务、退出码 0。

## 9. 开关矩阵

| 开关 | 位置 | 默认 | 关闭时的行为 |
| --- | --- | --- | --- |
| 联网搜索 | `PI861_WEB_SEARCH_ENABLED` / `Pi861Options.search.enabled` | 关 | 不注册搜索模型工具；/web-search 报错；无密钥不伪造 |
| 网页读取 | `PI861_WEB_READ_ENABLED` / `WebReadOptions.enabled` | 关 | `readWebPage` 报错（提示配置开关与主机审批）；未批主机/非默认端口/非白名单内容类型一律拒绝 |
| 自动召回 | `PI861_AUTO_RECALL` / options / `config.memory.autoRecall` | 开 | before_agent_start 不注入记忆上下文 |
| 自动采集（输入） | `PI861_AUTO_CAPTURE` / options / `config.memory.autoCapture` | 开 | 用户输入不写候选记录 |
| 自动采集（工具结果） | `config.memory.autoCapture`（runtime 侧，`tool_execution_end`） | 开 | tool_execution_end 不写 evidence 记录 |
| 自动提炼 | `config.memory.autoEnrich` + `modelId` | 关 | 不后台提炼；仍可 `/memory-maintain` 手动批次 |
| 动态路由 | `config.models.enableRouting` | 开（有 models 时） | 不做接待分类，仅固定+异常升级 |
| failover / failback | `config.models.recovery.*` + `/model-policy` | 配置必填 | 关 failover：不自动切备用；关 failback：不回切、停探测并清定时器 |
| 部署边界 | `deploymentMode`（CapabilityOptions） | trusted-local | production-isolated：拒绝 stdio/明文 HTTP MCP 与 endpointConfined 断言（见 §7） |
| Worker Shell | `config.project.allowWorkerShell` | 关 | bash/powershell 被 tool_call 守卫拒绝；基础工具集收敛为 read/write/edit/grep/find/ls/pi861_memory/pi861_model_route |
| Worker 模式 | `PI861_WORKER=1` | 关 | 见 2.2；与 /goal 注册互斥 |
| 原始 Skill 被动发现 | skills-host 固定行为 | 关 | `options.skills=[]`，仅显式 /skill:name 可用原始 Skill |

## 10. 安全部署示例

### 10.1 基础入口（无外部依赖）

```sh
pi -e ./extensions/pi861/index.ts
# 可选搜索（Linux/macOS）：
export PI861_WEB_SEARCH_ENABLED=1
export BRAVE_SEARCH_API_KEY='<由环境或密钥管理器注入>'
# 可选有界网页读取（公共主机 + 受批内部端点）：
export PI861_WEB_READ_ENABLED=1
export PI861_WEB_READ_HOSTS='example.org,*.docs.example.org'
export PI861_WEB_READ_INTERNAL_ENDPOINTS='https://wiki.internal.acme.example'
```

### 10.2 PostgreSQL 组合入口（外部记忆权威）

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

### 10.3 完整 runtime（脱敏示例）

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
    "requirements": { "minQuality": 0.6, "contextTokens": 32000, "capabilities": ["text"],
      "allowedIds": ["primary", "cheap"], "dataBoundary": "eu-only" },
    "recovery": { "failoverEnabled": true, "failbackEnabled": true,
      "probeIntervalMs": 30000, "maxProbeIntervalMs": 600000, "requiredProbeSuccesses": 2,
      "maxConcurrentProbes": 1, "probeBudget": 50 },
    "maxAttempts": 3, "requestTimeoutMs": 120000,
    "requestDeadlines": { "connectMs": 10000, "firstResponseMs": 30000, "progressMs": 60000 },
    "maxRequests": 1000, "maxProbeRequests": 50,
    "targets": [
      { "id": "primary", "revision": "2026-09", "provider": "<provider>", "model": "<model>",
        "quality": 0.9, "costRank": 3, "contextWindow": 200000, "capabilities": ["text"], "enabled": true,
        "account": "acme-main", "endpoint": "gateway-a", "dataEgress": "eu-only",
        "billing": { "inputPerMillionTokens": 3, "outputPerMillionTokens": 15,
          "cacheReadPerMillionTokens": 0.3, "currency": "USD" } },
      { "id": "cheap", "revision": "2026-09", "provider": "<provider>", "model": "<model>",
        "quality": 0.6, "costRank": 1, "contextWindow": 64000, "capabilities": ["text"], "enabled": true,
        "account": "acme-bulk", "endpoint": "gateway-b", "dataEgress": "eu-only",
        "billing": { "inputPerMillionTokens": 0.5, "outputPerMillionTokens": 2, "currency": "USD" } }
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

### 10.4 Worker 节点

本地 Worker 由协调者按任务派生：注入 `PI861_WORKER=1`、`PI861_CONFIG`、`PI861_INITIAL_MODEL_ID`、`PI861_ROLE_ID`、`PI861_WRITE_SCOPES`（`PI861_RUNTIME_ENTRY` 可覆盖入口路径）。远程 Worker 节点用 worker-service 常驻部署：

```jsonc
// /etc/pi861/worker-b.service.json（0600，operator 所有；不含明文密钥）
{
  "repository": "/srv/git/billing",
  "worktreeRoot": "/var/lib/pi861/worker-b/worktrees",
  "statePath": "/var/lib/pi861/worker-b/state.json",
  "tokenEnv": "PI861_WORKER_B_TOKEN",
  "host": "0.0.0.0", "port": 8787, "heartbeatMs": 30000,
  "identity": { "id": "node-b", "capabilities": ["linux"], "roleIds": ["dev"], "modelIds": ["primary", "cheap"] },
  "maxConcurrent": 2,
  "checks": [{ "id": "typecheck", "command": "node", "args": ["node_modules/typescript/bin/tsc", "--noEmit"], "timeoutMs": 300000 }],
  "worker": { "command": "node",
    "args": ["--experimental-strip-types", "/opt/pi861/runtime.ts"],
    "env": { "PI861_CONFIG": "/etc/pi861/worker-b.json", "PI861_WORKER": "1" } }
}
```

```sh
export PI861_WORKER_B_TOKEN='<≥24 字符强随机>'
node --experimental-strip-types extensions/pi861/src/live/worker-service.ts --config /etc/pi861/worker-b.service.json
# SIGTERM/SIGINT：收敛停机（运行中任务置 unknown，绝不盲目重放），退出码 0
```

协调者侧在 runtime 配置的 `project.remoteWorkers[]` 中指向该节点（跨节点协调需共享持久化状态，例如 `database`，文件状态不支持多进程协调）。

## 11. 升级、停机、恢复与回滚（当前可用项）

| 操作 | 现状 |
| --- | --- |
| 启动恢复 | 模型路由 checkpoint（policyHash 校验，恢复即 generation+1，不恢复旧请求的执行权）、激活 Skill 重激活、Goal 被动降级 paused、项目状态从 store 恢复、远程 Worker/服务重启将未决任务置 unknown（不盲目重放） |
| 停机收敛 | `session_shutdown`：停止派发→关闭模型运行时→暂停 Runner→等待提炼→关闭 MCP 客户端（capabilities.close）→关闭数据库池 |
| 记忆迁移 | `sql/memory-v1.sql` 为增量迁移（IF NOT EXISTS）；由迁移账号手工执行；升级前备份属运维要求（未自动化，R6.14） |
| 记忆对账 | `LayeredMemory.reconcile()` 幂等修复委派提交崩溃窗口（见 §6）；`delta()` 游标供对等同步 |
| Skill 回滚 | `/skills rollback ID REVISION`；卸载与陈旧检测走 `SkillRepository.uninstall/staleVersions`（库层 API） |
| 状态回滚 | 文件状态下为 operator 手工处置 stateDirectory（无内建命令）；PostgreSQL 状态键按行覆盖写（无版本历史） |
| 配置热更新 | 仅岗位（currentRole 每次重读文件）与 /model-policy 开关；其余字段需重启 |

## 12. 安全注意事项（部署清单）

1. `PI861_CONFIG` 与 worker-service 配置必须指向 operator 控制的绝对路径（入口强制）；文件权限 0600。
2. 数据库运行账号非超级用户、非 BYPASSRLS；迁移与运行账号分离；连接串不进模型上下文。
3. 远程 Worker 与 MCP 强制 HTTPS + 强 bearer token（≥24 字符）；明文仅限显式声明的 loopback 测试；production-isolated 下 loopback 明文与 endpointConfined 均被拒绝。
4. 检查命令白名单（checks）里的可执行文件本身受 operator 信任（文件守卫不沙箱检查程序）。
5. 状态目录 0700；集成身份文件 0600；`stateDirectory` 不应放进源仓库。
6. 密钥只经环境变量注入；日志与错误输出有启发式脱敏（publicError），不保证识别所有秘密。
7. 网页读取输出与 MCP 服务端描述均为**不可信外部数据**，永不作为指令或权限；公共主机仅协议默认端口，每跳 SSRF/DNS-rebinding 防护。
