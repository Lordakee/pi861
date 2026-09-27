# Pi861 验收矩阵（ACCEPTANCE_MATRIX）

- 首版日期：2026-09-22（P1 阶段交付）。
- **状态绑定代码版本：`a667d206dabf5e99df742bc594a3ac16361d4a54`（分支 `pi861-p2-integration`，含 M1-M5 交付、五轮审核修复、统一接线、接线复审 `96f8d1375`、缺口修复 `65084e069`、G6 根检查收口 `d2bff94d4` 与 P3 反例测试 `612facfe4`；最后 4 个提交未推送，推送后 CI 才覆盖本版）**。后续每次状态更新必须重新绑定当时的代码 SHA，并注明测试所对应的版本。
- 2026-09-27 本地复核（Linux/Node 24）四层：**L1** 扩展独立 `tsc --noEmit`（tsconfig.json）0 错误；**L2** 确定性 `node --experimental-strip-types --test test/*.test.mjs` **251/251 通过**（spawn 密集的 live-remote 双 Worker 用例在满负载首轮偶发超时，重跑即绿）；**L3** 宿主类型 `tsc --project tsconfig.host.json`（对照已发布 Pi 0.86.1 + ts 5.9.3）0 错误；**L4** 宿主集成 `pi-host.integration.mjs` + `runtime-host.integration.mjs` + `skills-host.integration.mjs` **3/3 通过**（真实 Pi 0.86.1 CLI）。AX10 `goal-e2e.integration.mjs` 本地两连跑绿（同 L4 宿主）。
- CI 证据（远端最新）：run <https://github.com/Lordakee/pi861/actions/runs/36317857198>（@ `542feb6f6`，已推送）**5 job 全绿**（deterministic / postgres / repository-check / pi-host / pi-host-source）；`a667d206d` 较其多 4 个提交（`65084e069`/`d2bff94d4`/`612facfe4`/`a667d206d`），待推送后验证。
- 关键提交：M1 `42d0fc580`（审核修复 `0566a2d8e`）、M2 `3f32cf25b`（审核修复 `3752b2b6c`）、M3 `2b8b2cd39`（审核修复 `fec2f3609`）、M4 `74ef9b4ee`（审核修复 `385ce83c1`、双 Worker 验收 `8c8953088`）、M5 `1303783ea`（审核修复 `bf221703e`）、统一接线 `31a56510e`、CI job `19b2dd709`；P2 绑定后新增：接线复审 `96f8d1375`（wire-rev F001-F006）、缺口修复 `65084e069`（R6.3/R6.7/R4.7）、G6 `d2bff94d4`、P3 反例 `612facfe4`（merge `a667d206d`）。
- 需求条目定义见 [REQUIREMENTS.md](REQUIREMENTS.md)；本文记录每条的代码入口、测试、证据与当前状态。
- 路径约定：代码入口均相对 `extensions/pi861/`。`d2bff94d4` 的格式化收敛使 `runtime.ts` 行号整体漂移：本次更新的行（G6、R1.5、R2.8、R4.7、R6.3、R6.7、R6.18、R8.1）引用 `a667d206d` 版本行号；其余行仍为 `4edc8b6d5` 版本行号，仅作定位提示。

## 1. 当前版本的检查链事实（证据基线）

CI run <https://github.com/Lordakee/pi861/actions/runs/36317857198>（对应 `542feb6f6` 推送）是最新远端 CI 证据（5 job 全绿）；`a667d206d` 较其多 4 个未推送提交，新 CI 待验证：

| 检查 | 结果 | 对本矩阵的含义 |
| --- | --- | --- |
| deterministic（隔离 ts 5.9.3 `tsc --noEmit` + `node --test test/*.test.mjs`） | 本地复核 @ a667d206d：**251/251 通过**；CI @ 542feb6f6 通过 | 内核与基础入口（index.ts）的协议/安全行为有当前版本证据；M1-M5 + P3 新增测试全部计入。 |
| postgres（真实临时 PostgreSQL 18 + 受限角色） | CI @ 542feb6f6 通过（run 36317857198，postgres:17 时期）；升级 postgres:18 后本地 docker 实测 postgres.integration.mjs 8/8（2026-09-27），CI 复核随本次推送 | `postgres.integration.mjs`（含 M3 `PostgresMemory` 逐记录路径，7ec8592ec 起即导入）对真实临时库通过；真实业务库未触（见第 5 节待授权）。 |
| repository-check（根 `npm run check`） | 本地 @ a667d206d：退出 0（`d2bff94d4` 起根 tsconfig/biome 已含 pi861 扩展）；CI @ 542feb6f6 通过 | G6 盲区（根检查不含扩展目录）已收口。 |
| pi-host（发布宿主 0.86.1 + `tsconfig.host.json`） | 本地 @ a667d206d：**3/3 通过**（pi-host/runtime-host/skills-host，真实 Pi 0.86.1 CLI）；CI job 清单只含前两个（@ 542feb6f6 2/2） | runtime.ts 完整入口编译、加载、缓冲故障接管、记忆语义与 AX5 宿主级 Skill 生命周期在当前版本实际运行；skills-host.integration.mjs（P3 新增）尚未纳入 CI 清单。 |
| pi-host-source（源码宿主，`19b2dd709` job） | CI @ 542feb6f6 通过（tsgo 全量检查 + 源码宿主两个集成测试）；本地 @ a667d206d：`tsgo --project tsconfig.host-source.json` 退出 0 | O4 已获 CI 证据。已知限定：tsc 5.9.3 无法检查该配置（上游 `packages/tui/src/utils.ts` 的 ES2024 正则 flag，TS1501；workflow 注释已载），tsgo 为权威门。 |

由此得出本矩阵最重要的限定：

- runtime.ts 完整入口（模型运行时接线、/mcp、/skills、完整 /goal、Worker 守卫）已随宿主集成测试实际运行（3/3）；goal 全链（规划→双真实 Worker 子进程→Skill/MCP→检查门→独立审计→受控集成落 git）另有 AX10 端到端测试（本地两连跑绿，真实 Pi 0.86.1 宿主 + 确定性本地 provider fixture）。
- **fixture 证明协议与安全行为，不证明真实模型任务质量。** 目前没有任何真实付费模型、真实搜索密钥或跨主机多节点的验证；真实用量归因、真实搜索后端待授权；postgres 新路径已在 CI 对真实临时库验证（现已升级 PostgreSQL 18），真实业务库未触。

## 2. 状态 taxonomy（定义）

| 状态 | 定义 |
| --- | --- |
| 未实现 | 无代码，或仅有类型/占位/被丢弃的输入；需求行为不存在。 |
| 仅内核 | 实现在 `src/`（或 `src/live/`）核心并有确定性测试，但未连接任何宿主入口，或连接面不完整。 |
| 已接入 | 已连接 `index.ts` 或 `runtime.ts` 入口且可在模拟环境运行，但当前版本没有端到端受控证据（或证据仅覆盖部分子句）。 |
| 受控协议验证通过 | 在绑定版本的确定性/fixture/临时数据库测试中通过（协议与安全行为层面）。 |
| 真实服务已验证 | 对真实外部服务（真实数据库、真实模型、真实搜索后端、跨主机节点）验证通过并绑定版本证据。 |
| 阻塞 | 依赖未就绪或需外部授权才能推进/验证。 |

## 3. 需求×入口×测试×状态

### 3.1 通用横切（G）

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| G1 | `src/memory.ts:66`（checkPrincipal）、`runtime.ts:201-223`（principal/Role 来自配置）、`index.ts` | memory.test.mjs（tenant/principal 校验）、host.test.mjs（外部 backend 显式 scope） | 受控协议验证通过 | runtime 侧已随宿主集成实际运行（3/3）；模型输出无任何授权通道（设计上不存在）。 |
| G2 | `src/memory.ts:149`（replay）、`src/live/coordinator.ts`（receipts）、`src/live/operations.ts:16` | memory.test.mjs（重放幂等/意图冲突）、live-project.test.mjs、live-operations.test.mjs | 受控协议验证通过 | 三处均实现 requestId+intent hash 回执。 |
| G3 | `src/memory.ts:173`（expectedRevision）、`src/capabilities.ts`（不可变 digest）、`src/live/coordinator.ts`（expectedVersion） | memory.test.mjs、capabilities.test.mjs、live-project.test.mjs（versioned append） | 受控协议验证通过 | — |
| G4 | `src/live/operations.ts:26`（unknown 阻塞）、`src/scheduler.ts`（恢复需核对）、`src/live/remote-worker.ts`（unknown） | live-operations.test.mjs、scheduler.test.mjs、live-remote.test.mjs | 受控协议验证通过 | — |
| G5 | `src/live/layered-memory.ts`（两段提交）、`src/live/store.ts:12`（锁内禁外部调用约束） | live-memory.test.mjs（withdrawal while extractor runs） | 受控协议验证通过 | — |
| G6 | `runtime.ts:238-256`（hostPort 窄端口适配：事件名校验；capabilityPort 组合）、根 `tsconfig.json`/`biome.json`（`d2bff94d4` 起含 pi861 src/index/runtime） | tsconfig.host.json 全量检查（0 错误，L3）+ 根 `npm run check`（@ a667d206d 退出 0）+ 三个宿主集成测试（本地 3/3） | 受控协议验证通过 | 根检查盲区已收口（`d2bff94d4`：根 tsconfig 含 extensions/pi861/src 与 index.ts，runtime.ts 仍归 tsconfig.host.json 权威检查；biome 覆盖 src/index/runtime）；CI repository-check @ 542feb6f6 绿。 |
| G7 | 测试实现本身（无密钥路径；`SearchOptions.fetch`、fixtures 注入） | search.test.mjs（disabled/missing-key 不触网）等 | 受控协议验证通过 | 过程性条目：约束测试编写方式。 |
| G8 | `runtime.ts:64,192`（urlEnv）、`runtime.ts:40`（tokenEnv）、`examples/postgres-extension.mjs` | — | 已接入 | 设计约束无专项测试；配置文件中不出现明文密钥。 |

### 3.2 R1 多模型执行策略

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R1.1 | `src/routing.ts:11-29`（ModelTarget 含 account/endpoint/billing/dataEgress）、`runtime.ts:76-101`（normalizeModelTarget 补默认+字段名报错） | routing.test.mjs（"the data egress boundary is a hard filter"、"invalid configuration is rejected naming the offending field"） | 受控协议验证通过 | PolicyLayer 继承为**新增内核能力**（model-runtime.ts:379-420 resolveModelPolicy，测试 "policy layers narrow the inherited policy"），runtime 逐层（全局→Agent→子 Agent）接线未做。 |
| R1.2 | `src/live/compilers.ts:24`（routeClassifier）、`runtime.ts:331-332`（接线 intakeId/enableRouting） | live-models.test.mjs、runtime-host.integration.mjs（发布宿主 0.86.1，L4 3/3 之一） | 受控协议验证通过 | direct 模式语义由分类器一次决策返回，未再启动第二个路由 Agent。 |
| R1.3 | `src/live/model-runtime.ts`（classified/pending/mode 状态机）、`runtime.ts:384`（setTask） | live-models.test.mjs（fixed 分类的单次性+升级）、routing.test.mjs | 受控协议验证通过 | 完整入口随宿主集成运行（3/3）。 |
| R1.4 | `src/routing.ts:115`（eligible 硬过滤+costRank 排序）、`src/live/compilers.ts:27`（提示词质量原则） | routing.test.mjs（quality, context, capability, allowlist hard filters） | 受控协议验证通过 | 提示词对真实模型的有效性未验证（fixture 生成器测试）。 |
| R1.5 | `src/live/model-runtime.ts`（RouteReport 携带 reason/phase/verificationPassed）、`src/live/compilers.ts`（routeClassifier 提示词序列化路由证据）、`runtime.ts:584-609`（pi861_model_route：reason+signal 双必填，可选 phase/verificationPassed 透传 `modelRuntime.report(signal,{reason,phase,verificationPassed})`） | live-models.test.mjs（"route classifier prompt carries routing evidence (wire-rev-F002)"、"route reports carry reason and evidence into later classifications and checkpoints"）+ runtime-host.integration.mjs（宿主级断言 phase/verificationPassed 到达运行时证据） | 受控协议验证通过 | M1 + 接线（31a56510e）+ 接线复审 `96f8d1375`：路由证据（signal/reason/phase/verificationPassed/at）进入分类器提示词与 checkpoint，宿主集成证据（L4 3/3 内）。 |
| R1.6 | `src/live/model-runtime.ts`（escalate/downgrade 路径） | live-models.test.mjs（"fixed route classifies once then escalates on a concrete gap"、"downgrade requires a completed phase with verified quality"） | 受控协议验证通过 | 降级条件=已完成阶段+验证质量；升级/降级均在安全边界执行。 |
| R1.7 | `src/routing.ts`（开关/探测/边界）、`runtime.ts:407-417`（/model-policy） | routing.test.mjs（disabled failover/failback、备用保持、探测要求）、live-models.test.mjs | 受控协议验证通过 | /model-policy 已接线 runtime 并随宿主集成运行；策略继承层级为内核能力（见 R1.1），逐层接线未做。 |
| R1.8 | `runtime.ts:294-310`（AuxiliaryModelService 接管 direct/generator，共享 health/budget/ledger）、`runtime.ts:282-292`（direct 传输） | live-models.test.mjs（"auxiliary calls share recovery, budget and metering"、"auxiliary calls stop when the global budget is exhausted"、"auxiliary reservations do not replay across instances (m1rev-F003)"） | 受控协议验证通过 | 分类/提取/编译/规划全部经同一恢复状态机与预算（M1 `42d0fc580` + 接线 `31a56510e`）；审核修复 `0566a2d8e` 补 aux 盐防重放。 |
| R1.9 | `src/live/model-runtime.ts:81-136`（UsageLedger：token/费用/未知用量）、`routing.ts:91`（budget_exhausted 分类）、`runtime.ts:322-326`（usageOf 提取宿主 usage） | live-models.test.mjs（"attempts, failures and probes are metered; unknown usage stays unknown"、"external planner sessions are reserved and metered with unknown usage"、"local budget exhaustion neither fails over nor pollutes shared health (m1rev-F004)"） | 受控协议验证通过 | 输入/输出/缓存 token 与费用已计量、未知用量保持 null（不再记 0）；**真实供应商用量归因仍仅 fixture 验证**（无真实付费模型）；planner 外进程按会话粒度计量（每会话 1 次 unknown 用量），按轮计量为后续增强。 |

### 3.3 R2 故障接管与回切

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R2.1 | `src/routing.ts:121`（preferred/active 分离） | routing.test.mjs、live-models.test.mjs | 受控协议验证通过 | — |
| R2.2 | `src/routing.ts`（关 failback 清探测；fail 仅在 failoverEnabled 时切换） | routing.test.mjs（disabled failover never calls backup / disabled failback issues no probes / turning failback off releases the shared in-flight probe slot） | 受控协议验证通过 | — |
| R2.3 | `src/routing.ts:187-241`（分类/退避/Retry-After/稳定确认/边界回切）、`src/live/deadline.ts`（连接/首响应/进展三段截止，M1 新增） | routing.test.mjs（retry-after and backoff、buffered inference switches once、unclassified error 不换模型、"a connection deadline fences a transport that never connects"、"a first-response deadline fences a silent connection"、"a stalled progress stream fails over within the progress deadline"） | 受控协议验证通过 | "首响应/进展"细分截止已交付（M1）；熔断仍以健康退避近似。 |
| R2.4 | `src/routing.ts`（cancel 不触发接管、迟到结果拒绝）、`src/live/operations.ts`（unknown 核对） | routing.test.mjs（late successful output cannot revive、user cancellation never starts a backup） | 受控协议验证通过 | — |
| R2.5 | `src/routing.ts`（无合格备用返回 false→上抛）、`src/live/model-runtime.ts`（checkpoint 持久化） | routing.test.mjs（no authorized model / no eligible backup 路径） | 受控协议验证通过 | "保存进度暂停"仍表现为 checkpoint 持久化+错误上抛；任务级显式暂停状态未完整。 |
| R2.6 | `src/routing.ts:136-207`（HealthService 共享健康域+单飞探测+并发背压+探测预算） | routing.test.mjs（"health is shared per provider, account and endpoint fault domain"、"probes are single-flight per fault domain across shared recoveries"、"probe concurrency is backpressured across fault domains"、"a shared probe budget stops further probes"、"a sibling's traffic success in a shared health domain does not stall failback (m1rev-F001)"） | 受控协议验证通过 | 共享健康域 succeed→markReady 探测记账已由审核修复 `0566a2d8e` 修正并加回归测试（m1rev-F001）。 |
| R2.7 | `runtime.ts:294-310`（aux 经 AuxiliaryModelService=inferWithRecovery+共享服务）、`runtime.ts:673`（planner `meterExternal` 预订+计量） | live-models.test.mjs（"external planner sessions are reserved and metered with unknown usage"、"auxiliary calls share recovery, budget and metering"） | 受控协议验证通过 | 原复核路径缺口（direct/generator 不经接管、planner 无预算）已由 M1 + 接线关闭。 |
| R2.8 | `runtime.ts:584-609`（工具 schema reason+signal 双必填，可选 phase/verificationPassed；report 透传三字段） | live-models.test.mjs（"route classifier prompt carries routing evidence (wire-rev-F002)"）+ runtime-host.integration.mjs（宿主级 tool 透明度断言） | 受控协议验证通过 | M1+接线+`96f8d1375`：reason/phase/verificationPassed 不再被丢弃，宿主集成实际验证（L4）。 |
| R2.9 | `src/live/model-runtime.ts`（policyHash 校验+generation 递增）、`runtime.ts:334-348`（会话分支恢复 pi861.model-runtime.v2） | live-models.test.mjs（backup state and request accounting survive a runtime replacement） | 受控协议验证通过 | — |
| R2.10 | `runtime.ts:351-383`（缓冲 wrapper）、`src/routing.ts:410`（IncrementBuffer，M1 新增） | routing.test.mjs（"text increments stay attributed and stale attempts lose authority"、"incomplete or invalid tool arguments are never dispatched"） | 受控协议验证通过 | IncrementBuffer 提供文本增量归属+工具参数完整性校验后派发（M1.7 交付）；真流式（线上增量流）仍为缓冲派发。 |

### 3.4 R3 持续调度与多节点

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R3.1 | `src/live/coordinator.ts`（ProjectState 含持续 team）、`src/scheduler.ts`（TaskRecord：status/artifacts/evidence/attempts/lease） | live-project.test.mjs（"team persists across goals and accounting covers the whole task tree"）、scheduler.test.mjs | 受控协议验证通过 | 持续小组（team）已建模并跨目标持久化（M4 `74ef9b4ee`）。 |
| R3.2 | `src/scheduler.ts`（完成即补位）、`src/live/project-runner.ts:51-75`（wake 监听+轮询回退） | scheduler.test.mjs（newly unlocked work starts before unrelated slower task ends）、live-project.test.mjs（"rolling planner refills below the watermark, retries conflicts and seals"、"rolling planner withdraws and appends within one tick (m4rev-F002)"） | 受控协议验证通过 | 本地子进程 fixture；跨进程/多机见 R3.7。 |
| R3.3 | `src/live/coordinator.ts:39-53`（change+wakeup 持久唤醒）、`src/live/project-runner.ts:23,55-67`（外部 wake+空闲轮询回退） | live-project.test.mjs（"AX1 second half: an idle runner is woken by rolling appends without recreation"） | 受控协议验证通过 | 持久唤醒机制已交付（M4）；空闲轮询不记账（m4rev-F003）。 |
| R3.4 | `src/scheduler.ts`（claim 全约束、依赖环、写入冲突） | scheduler.test.mjs（overlapping paths / slots, capabilities / expired retry-safe / dependency cycles） | 受控协议验证通过 | — |
| R3.5 | `src/live/coordinator.ts`（append + expectedVersion + 滚动规划调用方） | live-project.test.mjs（"rolling planner refills below the watermark, retries conflicts and seals"、"rolling planner withdraws and appends within one tick (m4rev-F002)"） | 受控协议验证通过 | 滚动规划入口/低水位补充/冲突重试/封口已实现（M4 + 审核修复 `385ce83c1`）。 |
| R3.6 | `src/live/coordinator.ts`（maxTasks、reviewSlots）、`runtime.ts:206`（RequestBudget 全局共享 store） | live-project.test.mjs（"team persists across goals and accounting covers the whole task tree"）、scheduler.test.mjs（"a separate review pool releases execution slots under audit backpressure"） | 受控协议验证通过 | 全任务树计量经共享预算+UsageLedger；审核占用经独立 review 池释放执行名额。 |
| R3.7 | `src/live/remote-worker.ts`（服务端/客户端、bundle+sha256、完整差异重验）、`src/live/workspace.ts` | live-remote.test.mjs（distinct repository, bundle transfer, revalidation；"dual worker services: parallel isolated checkouts, node-loss takeover and no double dispatch" @ `8c8953088`） | 受控协议验证通过 | 双 Worker 验收含节点丢失接管与不重复派发；仍为 loopback HTTP fixture，跨主机/容器未验证（如实标注：不称真实多服务器）。 |
| R3.8 | `src/live/worker-guard.ts:8-11`（workerIsolationBoundary 显式声明） | live-guard.test.mjs（"isolation boundary is declared explicitly and never overstated"） | 未实现 | 隔离后端（凭据/网络/进程限制）不存在：文件级守卫已实现并显式声明不称 OS 沙箱（如实标注）。 |
| R3.9 | `src/live/coordinator.ts`（集成租约）、`src/live/workspace.ts`（MERGE_HEAD+refs 锁探测） | live-project.test.mjs（"integration lease defers merging behind a live holder"、"verify rejects stale integration generations; takeover requires converged git"、"git lock probe detects real worktree locks"、"resume during a pause drain restarts the dispatch loop (m4rev-F004)"） | 受控协议验证通过 | 跨 Runner 集成互斥经租约+陈旧代拒绝；MERGE_HEAD/refs 真锁探测来自审核修复 `385ce83c1`。 |
| R3.10 | `src/live/project-runner.ts`（integrationTail）、`src/live/workspace.ts`（失败保留现场） | live-project.test.mjs（"failed integration leaves a tracked, resolvable repair entry"、"an integration failure is contained: later tasks integrate and a repaired task reintegrates (m4rev-F001)"） | 受控协议验证通过 | 集成失败围限+可追踪修复入口已建（M4 + 审核修复 m4rev-F001）。 |
| R3.11 | `src/live/workspace.ts`（id=digest(goalRun, taskId, attempt) 含 goal 维度） | live-project.test.mjs（"goal identity separates workspaces when a later goal reuses taskIds"） | 受控协议验证通过 | 工作区身份含 goal/run 维度（M4），taskId 复用不再碰撞。 |
| R3.12 | `src/scheduler.ts`（block/recoverExpired、旧租约拒绝）、`src/live/remote-worker.ts`（重启 unknown） | scheduler.test.mjs（expired lease rejects old results / unknown side effects block recovery / cancellation releases scheduler） | 受控协议验证通过 | — |
| R3.13 | `src/live/worker-service.ts`（独立部署入口：配置、心跳通告、收敛关闭） | live-remote.test.mjs（"worker service: executable entry, status announcements and convergent shutdown"） | 受控协议验证通过 | 可执行部署入口已交付（M4）：token 走 env 不入文件、SIGTERM 收敛关闭、状态通告；双 Worker 验收测试覆盖。 |

### 3.5 R4 Skill 加工与治理

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R4.1 | `src/live/skill-repository.ts`（install 全字节归档+限额）、`src/capabilities.ts`（readOriginal 显式） | live-skills.test.mjs（install archives full bytes）、capabilities.test.mjs（raw skills absent from automatic browsing） | 受控协议验证通过 | 替换 Pi 默认被动发现的接线已随宿主集成实际运行；显式 /skill:name 调用保留。 |
| R4.2 | `src/live/compilers.ts`（编译提示词：全文、去重、互斥分支、不发明工具）、`src/live/skill-repository.ts:167` | live-skills.test.mjs（fixture 编译器路径）、capabilities.test.mjs（分支条件） | 受控协议验证通过 | 编译质量依赖真实模型，未验证（fixture 编译器）。 |
| R4.3 | `src/live/skill-repository.ts:105`（installAuto）、`runtime.ts:543-560`（/skills install 接线 groupClassifier，需 compilerModelId 或显式 GROUP） | live-skills.test.mjs（"installAuto classifies the group from full documents and reports related sources (R4.3)"） | 已接入 | 自动归组已接入安装流程（M2 `3f32cf25b` + 接线 `31a56510e`）；无 compilerModelId 时要求显式 GROUP。 |
| R4.4 | `src/capabilities.ts`（browse/branches、activate 完整约束）、`src/live/skill-repository.ts` | capabilities.test.mjs（activating returns only selected phase bindings）、live-skills.test.mjs | 受控协议验证通过 | — |
| R4.5 | `src/live/skill-repository.ts`（candidate→publish→rollback）、`src/capabilities.ts`（版本不可变） | live-skills.test.mjs（source is not discoverable until trusted publication / source changing rejects stale candidate）、live-skills.test.mjs（"updates do not replace a running activation; both revisions stay resolvable"） | 受控协议验证通过 | 运行中版本固定已测（M2）。 |
| R4.6 | `src/live/skill-repository.ts:167-186`（绑定双通道：typed `bindings` + operator 文档；未批准绑定拒绝） | live-skills.test.mjs（"compile carries approved tool bindings and rejects unapproved ones (R4.6)"） | 受控协议验证通过 | 提示与输入一致（M2）；备注：runtime `/skills compile` 命令目前不传 approvedBindings（空绑定=合法无工具 Skill），绑定经编程通道传入。 |
| R4.7 | `src/live/skill-repository.ts:95-111`（collectFiles：symlink 拒绝、nlink>1 硬链接拒绝、路径规范、限额）、worker 写入侧链接检查 `src/live/worker-guard.ts` | live-skills.test.mjs（"symbolic links not traversed"、"hard-linked files are rejected during Skill installation" @ `65084e069`：硬链接拒绝+移除别名后单链接文件可正常安装；平台不支持硬链接时 skip） | 受控协议验证通过 | 安装侧硬链接检查已交付（`65084e069`）；Windows 空格路径靠"JSON 配置注入"规避；大小上限已有。 |
| R4.8 | 安装路径无脚本执行点（`skill-repository.ts` 只读归档）；编译提示词禁止执行 | live-skills.test.mjs | 受控协议验证通过 | 设计性保证。 |
| R4.9 | `src/live/skill-repository.ts:196`（publish 验证回调+证据类型）、`runtime.ts:563-573`（ui.confirm 人工确认 + structural+human-review 双证据） | live-skills.test.mjs（"publication requires distinct evidence kinds and records them (R4.9)"） | 已接入 | 发布不再恒 passed:true：要求不同类证据并记录（M2）；运行时发布证据=structural（编译期 schema 校验）+human-review（操作者确认），无自动化行为测试。 |
| R4.10 | `src/live/skill-repository.ts:220-251`（rollback/uninstall/staleVersions/重建标记）、`runtime.ts:574-579`（uninstall/stale/rollback 动词） | live-skills.test.mjs（"uninstall removes the source, candidates and derived runtime versions (R4.10)"、"affected rebuild flags published versions whose source set changed (R4.10)"、"updates do not replace a running activation; both revisions stay resolvable"） | 已接入 | 卸载、受影响重建、运行中版本固定均已实现并接线（M2 + 接线）。 |

### 3.6 R5 岗位授权与 MCP

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R5.1 | `src/capabilities.ts`（Role.grants）、`src/live/skills-host.ts`（ResourceRule/enforceResource） | capabilities.test.mjs（every invocation checks current grants and exact account/resource） | 受控协议验证通过 | — |
| R5.2 | `src/live/skill-repository.ts:129`（publishMcp 确定性 Skill）、`runtime.ts:492-521`（/mcp refresh/operations/resolve 接线） | live-mcp.test.mjs、live-skills.test.mjs（Skill activation registers real MCP tools lazily） | 受控协议验证通过 | /mcp 命令已接线 runtime 并随宿主集成运行；内核发布+激活已测。 |
| R5.3 | `src/live/skills-host.ts`（activate 按分支/阶段注册、未激活直调拦截） | capabilities.test.mjs（unauthorized required tool does not silently disappear）、live-skills.test.mjs、host 侧 tool_call 门禁 | 受控协议验证通过 | — |
| R5.4 | `src/capabilities.ts`（authorizeInvocation 每次调用）、`src/live/mcp.ts`（call 前刷新 schema） | capabilities.test.mjs（interface drift prevents activation）、live-mcp.test.mjs | 受控协议验证通过 | — |
| R5.5 | `src/live/skills-host.ts`（bindingName=digest(toolId,accountId,resourceId)、闭包绑定） | live-skills.test.mjs（"same tool bound to two resources keeps distinct metadata and closures (R5.5)"、"two skills sharing one binding keep independent availability (R5.5 review fix)" @ `3752b2b6c`） | 受控协议验证通过 | describe() 元数据多资源覆盖与共享绑定闭包问题已由 M2+审核修复关闭。 |
| R5.6 | `src/live/mcp.ts`（握手/分页/通知/SSE/限额/超时/404 会话失效、重连护栏） | live-mcp.test.mjs（"real stdio MCP process: initialize, discover and call"、"cancellation propagates to the server; ping is answered; notifications surface (R5.6)"、"bounded reconnect policy retries connection establishment only" @ `3752b2b6c`） | 受控协议验证通过 | 自研客户端已覆盖全部已用协议面（stdio/streamable-HTTP、协商至 2025-11-25、分页、取消、ping、通知，真实进程级测试）；**官方 SDK 评审已结案：不采纳**（2026-09-27 独立评审：零功能缺口，0 vs 17直接/94传递依赖含 express/hono/jose 全栈，cross-spawn 范围含历史恶意报告版本，outcome 三分类为 AX4/p5 对账承重墙）；重评触发：需要流恢复/OAuth/host 侧服务端/spec 超越 2025-11-25；届时采纳需精确钉版+锁文件审计（cross-spawn ≥7.0.6）+保接口包装。 |
| R5.7 | `src/live/skills-host.ts`（currentRole 每次取值）、browse 只读 | capabilities.test.mjs（returned data cannot mutate grants）、live-skills.test.mjs | 受控协议验证通过 | — |
| R5.8 | `src/live/skills-host.ts`（超限→resultRef）、`src/live/skill-repository.ts`（readResult 分页+权限关联） | live-skills.test.mjs（capability factory 不调用未绑定方法） | 受控协议验证通过 | 默认 32 KiB 内联、超出转引用；字段级读取未实现（分页为字符偏移）。 |
| R5.9 | `src/live/operations.ts:13-68`（at-most-once、等价未决阻塞、resolve 核对、100k 回执上限） | live-operations.test.mjs（replays committed result / unknown side effect blocks equivalent fresh call） | 受控协议验证通过 | 操作 ID 为 digest(会话,callId) 派生；重试新调用生成新 ID 但被等价指纹阻塞，效果等价。 |
| R5.10 | `src/live/worker-guard.ts`（bash/powershell 门禁+writeScopes）、`runtime.ts:586-595`（worker tool_call 守卫接线）、`runtime.ts:598-603`（worker baseTools 收敛） | live-guard.test.mjs（"worker shell gate stays closed unless allowWorkerShell is explicitly enabled (R5.10)"） | 已接入 | 接线已随宿主集成路径运行；allowWorkerShell 显式开启语义已实现并测。 |
| R5.11 | `runtime.ts:110-112`（deploymentMode 配置校验）、`runtime.ts:599`（传入 installCapabilities） | live-skills.test.mjs（"production-isolated mode refuses local transports and endpoint assertions at the capability host (R5.11)"）、live-mcp.test.mjs（"deployment modes: trusted-local vs production-isolated boundaries (R5.11)"） | 受控协议验证通过 | 可信本地/生产隔离两模式已定义并强制（M2）：生产隔离拒绝本地传输与端点断言；默认 trusted-local。 |
| R5.12 | MCP 出站：`skills-host.ts`（参数等于约束）；网页侧 `src/web-read.ts`（审批+SSRF 边界） | capabilities.test.mjs（参数越界拒绝路径）、web-read.test.mjs（见 R7.6） | 受控协议验证通过 | 网页读取出站策略已实现（R7.6，默认关闭+显式主机审批）。 |

### 3.7 R6 记忆与 PostgreSQL

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R6.1 | `src/memory.ts`（kind/三视图字段、contextPack L0/L1/L2）、`src/live/layered-memory.ts`（projection 关联 sourceRevision） | memory.test.mjs（context pack byte-bounded, provenance-bearing）、live-memory.test.mjs（generated L0/L1 does not replace full evidence） | 受控协议验证通过 | 未强求三份：写入者提供 abstract/overview，提炼任务生成派生视图。 |
| R6.2 | `src/memory.ts:66`、`133-147` | memory.test.mjs（unauthorized scope rejected）、live-memory.test.mjs（other project cannot search/list/delta） | 受控协议验证通过 | — |
| R6.3 | `index.ts`（before_agent_start 召回装配）、`runtime.ts:514-515`（hostAssemblyTrigger：session_start(reason:"resume")→session_resume、session_tree→node_change、model_select→model_change、session_compact→compaction；经 injectMemoryContext 复用注入） | live-memory.test.mjs（"context assembly covers model change, compaction and node switch"、"host assembly trigger mapping covers resume and tree navigation without false positives" @ `65084e069` 含负例）、host.test.mjs（recall 相关） | 受控协议验证通过 | 五触发全接线（启动/接手经 index.ts，resume/node_change @ `65084e069`）；负例测试确认其他 start reason 不触发装配（仅本地分支语义）。 |
| R6.4 | `index.ts`（去重+词法查询）、`src/live/layered-memory.ts`（delta 游标、pack 预算、事件级召回） | live-memory.test.mjs（"event recall packs each changed record once per page"、"delta paging does not lose simultaneous writes"） | 受控协议验证通过 | 事件级召回已实现（M3）；词法基线检索保留（任务书允许作为基线）。 |
| R6.5 | `index.ts`（input 捕获：source 过滤、secretLike 拒绝、32k 截断） | host.test.mjs（auto capture excludes extension prompts, credentials…） | 受控协议验证通过 | 基础入口路径；默认开启。 |
| R6.6 | `runtime.ts:439-459`（tool_execution_end 捕获→controlledToolCapture，超大/敏感转受控引用） | runtime-host.integration.mjs（durable memory and semantic maintenance） | 受控协议验证通过 | 接线随宿主集成测试实际运行；超大/敏感不再直接丢弃（见 R6.7）。 |
| R6.7 | `runtime.ts:697-712`（tool_execution_end→controlledToolCapture，超大/敏感经 saveRaw→SkillRepository.storeResult 落受控存储）、`src/live/skill-repository.ts:48-56,489-520`（ResultOwner 显式 owner：skill=role+skill+binding 或 principal=principal+role+工具调用身份；readResult 每次重校验授权）、`src/controlled-results.ts`（分页） | memory.test.mjs（内联/受控引用、敏感不入摘要三则）+ live-skills.test.mjs（"controlled results page for their owner and deny revoked or foreign identities (R6.7)"、"controlled tool capture persists raw output through the repository under the caller identity (R6.7)" @ `65084e069`：跨进程重开后撤权/换角色/异主体即拒） | 受控协议验证通过 | owner 建模+持久化+撤权即拒已交付（`65084e069`）：引用 id 非 bearer token，grant/skill/role 撤销后读取立即拒绝；记忆条目保持 digest-only，原文仅经受控存储读取。 |
| R6.8 | `src/live/layered-memory.ts`（领取租约/两段提交/提交重校验；模型调用在 store.update 外） | live-memory.test.mjs（withdrawal while an extractor runs cannot resurrect / fabricated quotations fail closed） | 受控协议验证通过 | 默认 attempts<3、每次唤醒 maxJobsPerWake=2（runtime 配置）。 |
| R6.9 | `src/live/layered-memory.ts`（失败分类/退避重试/死信/人工重排）、`runtime.ts:461-472`（/memory-maintain dead\|retry\|abandon） | live-memory.test.mjs（"failed extraction retries with backoff and then succeeds"、"backoff delays reclaim and exhausted retries become dead with manual entries"、"a dead job can be requeued manually and then completes"） | 受控协议验证通过 | 失败分类、重试与人工处理入口已实现并接线（M3 + 审核修复 `fec2f3609` 死信队列）。 |
| R6.10 | `src/memory.ts`（recall 拒绝为新证据、inference 不得自确认/constraint）、`layered-memory.ts`（quote 字面校验） | memory.test.mjs（recalled text not accepted / model inference cannot claim confirmation）、live-memory.test.mjs | 受控协议验证通过 | — |
| R6.11 | `src/memory.ts`（tombstone）、`src/live/layered-memory.ts`（撤回传播任务/投影）、`src/postgres.ts`（DB tombstone+outbox） | memory.test.mjs（withdrawal idempotent / suppresses re-ingestion / paraphrases from same source）、postgres.test.mjs（"outbox consumer applies events, deletes only accepted rows and keeps failures queued"） | 受控协议验证通过 | outbox 消费者已实现并有确定性测试（M3）。 |
| R6.12 | `src/memory.ts`（候选不可自确认） | memory.test.mjs（候选不可自确认） | 受控协议验证通过 | "经验生成 Skill 候选"通道未实现，负向约束已满足。 |
| R6.13 | `sql/memory-v1.sql`（全表+RLS）、`src/postgres.ts`（事务/advisory lock/重放/outbox；PostgresMemory 逐记录权威） | postgres.integration.mjs（real PostgreSQL: atomic memory, CAS, RLS and withdrawal；7ec8592ec 起即导入 PostgresMemory）+ postgres.test.mjs | **真实服务已验证** | CI postgres job @ 542feb6f6 通过（run 36317857198：PostgreSQL 18 临时库（CI postgres:18 @ a50116df1 后；17 时期证据见历史）+受限角色，覆盖 M3 PostgresMemory 路径）；真实业务库未触（见第 5 节待授权）。 |
| R6.14 | `examples/postgres-extension.mjs`（TLS/CA/池/超时/strip URL ssl 参数）、`sql/*.sql` 头注（迁移账号分离） | postgres.integration.mjs（受限角色/迁移升级子用例） | 仅内核 | 备份/恢复流程未实现（运维项）；凭据委派服务未实现。 |
| R6.15 | `src/live/store.ts`（PostgresStateStore 仅控制态）、`src/postgres.ts`（PostgresMemory 逐记录权威）、显式迁移 | postgres.test.mjs（"explicit migration moves snapshot authority into per-record rows, verifies and cuts over"、"migration refuses unexplainable tombstones instead of copying them silently"）、live-memory.test.mjs（"layered memory delegates item authority and keeps only control state"） | 受控协议验证通过 | 数据权威统一：逐记录 PostgresMemory + StateStore 控制态，含显式迁移与 reconcile（M3 `2b8b2cd39` + 审核修复 `fec2f3609`）；集成测试对真实临时库执行 sql/memory-v1.sql + runtime-v2.sql 迁移（CI @ 542feb6f6 绿），快照→逐记录显式迁移为确定性测试覆盖。 |
| R6.16 | `index.ts`（Intl.Segmenter 分词）、`src/postgres.ts:68`（PG 全文 tsvector+GIN）、`sql/memory-v1.sql:47` | memory.test.mjs（search 约束）、live-memory.test.mjs（事件召回） | 仅内核 | pgvector 未实现且无装饰性开关（如实）；检索为词法基线（含 PG 全文路径，CI @ 542feb6f6 已绿）；中文/代码符号/路径检索专项测试未补。 |
| R6.17 | `runtime.ts:206`（ResilientBackend）、`runtime.ts:317,442,726`（init/settle/shutdown flush） | live-memory.test.mjs（"unavailable database leaves explicitly uncommitted local records that flush later"、"concurrent flush serializes so no queued operation is lost"、"a poison head is dead-lettered instead of blocking the queue forever" @ `fec2f3609`） | 受控协议验证通过 | 本地待同步队列已实现（缓冲为显式 pending 回执，串行 flush+死信，不丢失）；剩余缺口："关键检查点未提交则暂停执行边界"未接线。 |
| R6.18 | `index.ts`（env 开关）、`runtime.ts`（config 三开关 + `/memory-maintain` 命令 @ runtime.ts:716-742）、`index.ts`（主动工具） | host.test.mjs、live-memory.test.mjs | 已接入 | env 层在基础入口可用；/memory-maintain 全动词：缺省批次、`dead`、`retry <id>`、`abandon <jobId|requestId>`（先试死信任务，再落到 pending 死信回执）、`pending`（死信+未提交队列报告，需 database 配置）——后两项 @ `96f8d1375`（wire-rev-F006）；项目/岗位继承层级未实现。 |

### 3.8 R7 搜索

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R7.1 | `index.ts`（命令+工具，未动本地工具集）、`src/search.ts`（独立适配） | host.test.mjs（disabled search has no model tool） | 受控协议验证通过 | — |
| R7.2 | `src/search.ts`（固定端点/头/限额、provider 校验）、`index.ts`（env 配置） | search.test.mjs（11 用例：固定端点头、限额、畸形响应、取消不触网、"only implemented providers are reported and selectable" 等） | 受控协议验证通过 | HTTP fixture（fetch 注入）；无真实密钥联网验证（待授权）。 |
| R7.3 | `src/search.ts`（retrievedAt/truncated/错误不伪造） | search.test.mjs（malformed payload not reported as zero hits / truncated snippets marked） | 受控协议验证通过 | — |
| R7.4 | `index.ts`（默认关闭）、`search.ts`（无密钥报错）、`web-read.ts:403-413`（网页读默认关闭 PI861_WEB_READ_ENABLED） | search.test.mjs（disabled or missing-key does not call backend）、web-read.test.mjs（disabled or unapproved reads never reach the network） | 受控协议验证通过 | 工具描述明示不外发私有内容（提示层约束）。 |
| R7.5 | `src/search.ts`（限长/取消）、`src/web-read.ts`（限长/超时/取消） | search.test.mjs（oversized body stopped / cancelled never reaches network）、web-read.test.mjs（同型用例） | 受控协议验证通过 | — |
| R7.6 | `src/web-read.ts`（主机审批/SSRF/重定向重审/重绑防护/限长/超时/压缩/内容类型/线性提取）、`runtime.ts:478-501`（pi861_web_read 接线，默认关闭） | web-read.test.mjs（21 用例，含 "SSRF guard blocks private, loopback, metadata, mapped and embedded addresses"、"each redirect hop is re-approved"、"a transport that connects to an unvalidated address is aborted (rebinding guard)"、"extractText stays linear on adversarial markup padding (M5 review fix)"、"teredo and protocol-default ports are refused (M5 review fix)" @ `bf221703e`） | 受控协议验证通过 | 网页正文提取与网络边界防护已交付（M5 `1303783ea` + 审核修复 `bf221703e` + 接线 `31a56510e`）；真实外部站点未验证（默认关闭，待授权）。 |
| R7.7 | `src/controlled-results.ts`（受控引用+分页）、`index.ts:314,333`（searchPayload）、`runtime.ts`（webReadResults 分页） | search.test.mjs（"long search results become paged references instead of inline JSON"）、web-read.test.mjs（"controlled results page long payloads instead of inlining them"） | 受控协议验证通过 | 大结果转 resultRef 引用+分页读取（M5 + 接线）。 |

### 3.9 R8 /goal

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R8.1 | `index.ts`（基础入口全动词）、`src/goal.ts` | goal.test.mjs（12 用例）、host.test.mjs、live-project.test.mjs（"project goal verbs cover edit, budget, explain and status"、"resume on a crash-orphaned active goal restarts dispatch (wire-rev-F003)" @ `96f8d1375`） | 受控协议验证通过 | 完整 runtime `/goal` 动词集已补齐（runtime.ts:947 GOAL_VERBS：status/pause/resume/accept/clear/edit/budget/explain/failures/unblock）；F003 @ `96f8d1375`：resume 对 crash 孤儿 active goal 容错（直接重启派发而非报错），重复 resume 幂等 no-op。 |
| R8.2 | `src/goal.ts`（report 校验）、`index.ts`（goal_report 工具） | goal.test.mjs（no evidence cannot request completion） | 受控协议验证通过 | — |
| R8.3 | `src/goal.ts`（预算单调/空转暂停）、`index.ts`（用户输入暂停） | goal.test.mjs（run budget monotonic / unproductive continuation stops） | 受控协议验证通过 | — |
| R8.4 | `index.ts`（单飞 continuation）、`runtime.ts:231-234`（managedGoal 抑制双注册）、runtime 统一队列 | host.test.mjs（refill after settlement） | 已接入 | 基础入口受控通过；runtime 路径已随宿主集成运行，专项统一队列运行时测试未建。 |
| R8.5 | `src/goal.ts`（恢复降级 paused+清 token） | goal.test.mjs（restoring interrupted work is passive） | 受控协议验证通过 | — |
| R8.6 | `runtime.ts:609-657`（buildRunner 持久 Runner：create/resume、集成工作区复用、本地+远程 Worker、planner 检查真实源码） | live-project.test.mjs（内核链路）、runtime-host.integration.mjs | 已接入 | 完整 runtime 入口可运行（宿主集成通过）；端到端 /goal 链路证据待 goal-e2e 集成测试（AX10）。 |
| R8.7 | `src/scheduler.ts:35`（explainConcurrency）、`src/live/coordinator.ts:331`（/goal explain）、`runtime.ts:607`（explain 动词） | scheduler.test.mjs（"explainConcurrency names each unsaturated-concurrency reason"） | 已接入 | 未满并发原因解释视图已交付并接线（M4 + 接线 `31a56510e`）。 |
| R8.8 | `src/goal.ts`（review→accept、settle 去重） | goal.test.mjs（duplicate settle / completion only requests review） | 受控协议验证通过 | 自动检查证据（workspace.check）与人工 accept 在完整链路中区分（live-project）。 |

### 3.10 验收反例（AX）

| 编号 | 测试入口（计划/现有） | 状态 | 说明 |
| --- | --- | --- | --- |
| AX1 | scheduler.test.mjs（"newly unlocked work starts before an unrelated slower task ends"）、live-project.test.mjs（"AX1 second half: an idle runner is woken by rolling appends without recreation"） | 受控协议验证通过 | 两半（A 验收后 C 先于 B 启动；空闲后追加唤醒）均已有受控测试（M4）。 |
| AX2 | scheduler.test.mjs（"a submitted but unverified dependency does not unlock dependent work"、"rejected verification blocks and never marks work complete"）、live-project.test.mjs（"an integration failure is contained: later tasks integrate and a repaired task reintegrates (m4rev-F001)"、"failed integration leaves a tracked, resolvable repair entry"） | 受控协议验证通过 | 未验收不解锁+拒绝即阻塞+集成失败围限与修复重集成均有测试；"审核失败→自动生成关联返工任务"的显式链路未实现（返工经修复入口路径）。 |
| AX3 | routing.test.mjs、live-models.test.mjs、runtime-host.integration.mjs | 受控协议验证通过 | 前两者 @ a667d206d 本地 251/251 计入；runtime-host 集成随 L4 3/3（发布宿主 0.86.1，本地）。 |
| AX4 | routing.test.mjs（"AX4/p1-text-mid-stream: a cut text stream never becomes a tool call and the lost generation cannot pollute the retry"、"AX4/p2-args-mid-stream: half-received arguments end undispatchable and the MCP server receives zero calls"）、live-operations.test.mjs（"AX4/p3-pre-dispatch-cancel: cancelling between complete arguments and journal admission leaves zero side effects and a safely retryable request"、"AX4/p4-dispatch-unconfirmed: stream loss after a committed side effect journals unknown, blocks equivalent redispatch and never repeats the effect"）、live-mcp.test.mjs（"AX4/p5-receipt-lost: a committed side effect with a dropped receipt reconciles through a trusted query and never re-executes" + fixture `mcp-receipt-loss.mjs`，全部 @ `612facfe4`） | 受控协议验证通过 | 断流五位置受控矩阵已建（文本中断/参数半收/派发前取消/派发未确认/回执丢失，位置→行为逐一验证）；仍为缓冲派发边界内的模拟，真流式未接（见 R2.10）。 |
| AX5 | live-skills.test.mjs（"two generic debug sources compile into one deduplicated Skill with mutually exclusive branches (AX5)"）+ skills-host.integration.mjs（"AX5 host skills: auto-grouping merges two generic debug sources, branches are mutually exclusive, default prompts stay clean, updates pin revisions and rollback restores" @ `612facfe4`，真实 Pi RPC 宿主全链，本地 3/3 之一） | 受控协议验证通过 | 宿主级全链已建（双源归组去重/互斥分支/默认提示无源描述与秘密泄漏/更新 pin/回滚）；**回滚栅栏已修复**（`f78fed496`）：SkillState.revoked 持久撤销集，activate 命中撤销集即拒并提示当前活跃 revision；回滚到某版本解除其旧撤销；运行中激活钉住语义不变（R4.10）；宿主断言已翻转（撤销 revision 激活被拒）。 |
| AX6 | live-mcp.test.mjs、live-skills.test.mjs、宿主集成测试 | 受控协议验证通过 | 未激活不暴露、激活必需项、撤权、schema 变化、隐藏名直调均有内核测试；跨账户/重复绑定细项已由 M2 R5.5 测试覆盖。 |
| AX7 | live-memory.test.mjs、postgres.integration.mjs、live-remote.test.mjs（"dual worker services: parallel isolated checkouts, node-loss takeover and no double dispatch"） | 受控协议验证通过 | 换会话恢复、私有不泄漏、撤回不复活、跨 Worker 节点丢失接管均覆盖；跨主机仍为 loopback fixture。 |
| AX8 | postgres.test.mjs（requestId 确认）、live-memory.test.mjs（"failed extraction retries with backoff and then succeeds"、"backoff delays reclaim and exhausted retries become dead with manual entries"、"a dead job can be requeued manually and then completes"） | 受控协议验证通过 | 提炼失败恢复（重试/死信/人工重排）已实现（M3）；本地镜像冒充共享提交的防护已有（R6.17）。 |
| AX9 | live-project.test.mjs（"integration lease defers merging behind a live holder"、"verify rejects stale integration generations; takeover requires converged git"、"resume during a pause drain restarts the dispatch loop (m4rev-F004)"）、live-remote.test.mjs | 受控协议验证通过 | 双协调者/进程恢复的单一执行权经集成租约+陈旧代拒绝+resume 排空覆盖（M4 + 审核修复 `385ce83c1`）；goal 全链路重启 e2e 仍待 AX10。 |
| AX10 | goal-e2e.integration.mjs（"AX10 goal e2e: /goal plans, two real worker subprocesses execute, skills and MCP serve results, memory persists, checks gate integration and an independent audit accepts (deterministic local provider fixture; not model-quality evidence)" @ `612facfe4`） | 受控协议验证通过 | 端到端闭环已建：真实 Pi 0.86.1 RPC 宿主加载 runtime 扩展，/goal→确定性本地 planner fixture→两个真实 Worker 子进程隔离 git 工作区→真实本地 MCP server+宿主安装 Skill→检查门→独立审计读 git 对象（非自报告）→受控集成落 git→/goal accept；本地两连跑绿。deterministic fixture 边界已在测试名与文件头注明（不证模型质量）；未纳入 CI 清单。 |

### 3.11 可选增强（O）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| O1 pgvector | 未实现 | 无装饰性开关（检索为关键词/PG 全文基线，如实标注）。 |
| O2 网页正文提取 | 受控协议验证通过 | M5 交付（`src/web-read.ts` extractText：线性上限、script 尾剥离），测试见 R7.6。 |
| O3 多搜索后端 | 未实现 | SearchProvider 接缝 + supportedSearchProviders() 已建（M5），仅 "brave" 实现（fetch 注入为测试缝）。 |
| O4 源码宿主验证 | 受控协议验证通过 | CI job `pi-host-source` @ 542feb6f6 全绿（run 36317857198：tsgo 全量检查 + 源码宿主两个集成测试）；本地 @ a667d206d `tsgo --project tsconfig.host-source.json` 退出 0。已知限定：tsc 5.9.3 无法检查该配置（上游 tui ES2024 正则 flag），tsgo 为权威门（workflow 注释已载）。 |

## 4. 状态分布（@ a667d206d，109 条）

| 状态 | 条数 | 占比 |
| --- | --- | --- |
| 受控协议验证通过 | 94 | 86.2% |
| 真实服务已验证 | 1 | 0.9%（R6.13，PostgreSQL 18 临时库（CI postgres:18 @ a50116df1 后；17 时期证据见历史）：CI @ 542feb6f6 绿 + e3f07a789 历史） |
| 已接入 | 9 | 8.3%（G8、R4.3、R4.9、R4.10、R5.10、R6.18、R8.4、R8.6、R8.7） |
| 仅内核 | 2 | 1.8%（R6.14、R6.16） |
| 未实现 | 3 | 2.8%（R3.8、O1、O3） |
| 阻塞 | 0 | 0% |

本版证据链：M1-M5 模块交付（`42d0fc580`/`3f32cf25b`/`2b8b2cd39`/`74ef9b4ee`/`1303783ea`）+ 五轮审核修复（`0566a2d8e`/`3752b2b6c`/`fec2f3609`/`385ce83c1`/`bf221703e`）+ 双 Worker 验收（`8c8953088`）+ 统一接线 `31a56510e` + 接线复审 `96f8d1375`（F001-F006）+ 缺口修复 `65084e069`（R6.3/R6.7/R4.7）+ G6 收口 `d2bff94d4` + P3 反例 `612facfe4`（merge `a667d206d`）；四层验证 251/251（deterministic）+ 3/3（发布宿主集成，本地 @ a667d206d）+ AX10 e2e 两连跑绿；CI @ 542feb6f6 5 job 全绿（run 36317857198）。

与上版（@ 4edc8b6d5）分布变化：受控 87→94（R4.7/R1.5/R2.8/AX4/AX5/AX10/O4 升入），已接入 12→9，仅内核 5→2，未实现 4→3。

读法提醒：

1. "受控协议验证通过"中相当一部分条目的证据来自内核/基础入口确定性测试；runtime 完整入口已随宿主集成（3/3）实际运行，AX10 端到端（goal 全链）已有两连跑绿证据（本地，未入 CI）。
2. 没有任何条目获得"真实付费模型/真实搜索/跨主机多节点"验证；真实用量归因仅 fixture；postgres 已在 CI 对真实临时库验证但真实业务库未触（见第 5 节）。
3. 未实现与仅内核条目（R3.8 OS 沙箱、R6.14 运维流程、R6.16 pgvector/检索专项、O1、O3）与已知限制（R2.10 真流式、R1.9 planner 按会话计量）为后续工作清单输入；AX5 回滚栅栏缺陷已修复（f78fed496）。

## 5. 待授权清单（单列，不与受控证据混淆）

以下验证均需用户显式授权后才能推进，任何条目在授权前不得声称通过：

| 项 | 现状 |
| --- | --- |
| 真实付费模型验收 | 未执行：全部模型路径为确定性本地 provider fixture（含 AX10）；真实用量归因/降级/接管仅 fixture 验证 |
| 真实搜索后端 | 未执行：Brave 路径仅 HTTP fixture（fetch 注入）；无真实密钥联网验证 |
| 跨主机多节点 | 未执行：双 Worker/远程服务均为 loopback HTTP fixture；未验证真实多机/容器 |
| 真实业务数据库 | postgres 新路径 CI 已绿（@ 542feb6f6，真实临时 PostgreSQL（现已 18）+ 受限角色，run 36317857198），但未接触真实业务库（数据量/并发/运维流程均未验证） |
