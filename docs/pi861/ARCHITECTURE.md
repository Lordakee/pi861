# Pi861 架构说明（ARCHITECTURE）

- 首版日期：2026-09-22（P1 阶段交付）。基于实际代码 `e3f07a789b7648f26ec72ce65fa5856046dbd6d3`（`feat/pi861-runtime-v1`）编写；行号相对 `extensions/pi861/`。
- 本文描述**当前真实存在的结构**，并标注计划中的演进方向（见 DEVELOPMENT_PLAN.md P1 共享契约与 P2 五模块）；不把计划当作已实现。

## 1. 分层总览

```
┌──────────────────────────────────────────────────────────────────┐
│ 入口层（宿主适配）                                                  │
│  index.ts    基础组合入口：/goal(基础)、记忆、搜索；窄端口 PiHost      │
│  runtime.ts  完整运行入口：配置文件驱动，接线全部 live 服务（当前 P0   │
│              修复中：TS1005 编译错误，见 HANDOFF.md）                 │
├──────────────────────────────────────────────────────────────────┤
│ 服务层 src/live/（可组合的真实实现：进程、HTTP、SQL、文件锁）          │
│  model-runtime  compilers  layered-memory  store  skill-repository │
│  skills-host  mcp  operations  coordinator  project-runner         │
│  pi-rpc  remote-worker  workspace  worker-guard  line-process      │
├──────────────────────────────────────────────────────────────────┤
│ 内核层 src/（纯 TypeScript、无 I/O 依赖的策略与状态机，确定性可测）     │
│  routing（模型策略/故障）  scheduler（任务图）  goal（目标状态机）      │
│  memory（记忆契约+LocalMemory）  capabilities（能力目录）             │
│  postgres（SQL 适配契约）  search（搜索适配）                          │
└──────────────────────────────────────────────────────────────────┘
```

依赖方向严格自上而下：入口 → live → 内核。内核不 import live；live 不 import 入口（唯一例外：`src/live/skills-host.ts:1` 从 `index.ts` 导入窄端口类型 `PiContext/PiHost`——该类型本身无运行时依赖）。

两类入口的关系（防双注册）：

- `package.json:8`（`pi.extensions: ["index.ts"]`）默认自动加载基础入口。
- `runtime.ts` 是完整入口，要求可信绝对路径 `PI861_CONFIG`（`runtime.ts:44-51`）；它内部调用 `installPi861` 并以 `managedGoal` 抑制基础入口的旧 Goal 注册（`runtime.ts:92`：有 `project` 配置且非 Worker 时为 true），保证同一宿主只有一个 Goal 所有者、一套记忆采集。
- 已知问题（P0 范围）：`runtime.ts:92,305` 用 `pi as unknown as PiHost` 双重断言适配宿主，须替换为显式适配函数；且该文件当前不能通过类型检查。

## 2. 模块清单与边界

| 模块 | 文件 | 职责 | 明确不做 |
| --- | --- | --- | --- |
| 模型策略内核 | `src/routing.ts` | ModelTarget 资格过滤、初选、ModelRecovery（preferred/active、健康、探测、尝试归属）、inferWithRecovery（仅缓冲无副作用推理的重试） | 不包工具执行重试；不做网络 |
| 模型运行时 | `src/live/model-runtime.ts` | ModelRuntime（分类一次/重评估/升级/预算/探测定时器/checkpoint）+ RequestBudget（全局请求配额） | 不直接持有凭据；传输由注入的 infer 回调承担 |
| 模型传输 | `runtime.ts:105-129`（direct/generator） | 经宿主 modelRegistry 发起真实模型请求、HTTP 状态→FailureKind 映射 | 无流式增量（缓冲完整响应）；direct 不经恢复状态机（已知缺口 R2.7） |
| 辅助编译器 | `src/live/compilers.ts` | routeClassifier/skillCompiler/memoryExtractor/projectPlan/chooseSkillGroup 的提示词与输出校验（parseObject） | chooseSkillGroup 未接线（R4.3） |
| 任务图内核 | `src/scheduler.ts` | TaskBoard：状态机（queued/running/review/done/blocked）、租约、依赖环、写入范围互斥、完成驱动补位 drainReadyTasks | 不提供网络/进程/持久化（由 persist 回调注入） |
| 项目协调者 | `src/live/coordinator.ts` | ProjectState 持久化、幂等回执、claim/heartbeat/submit/verify/control、append（计划追加，未接线） | 不执行任务 |
| 项目执行器 | `src/live/project-runner.ts` | 驱动本地/远程 Worker、检查、受控集成（integrationTail 串行）、失败保留现场 | 空闲即退出（R3.3 缺口）；无审核返工流 |
| Pi RPC 会话 | `src/live/pi-rpc.ts` + `line-process.ts` | 行协议子进程、prompt、waitForSettled（等待 pi861.run-settled.v2 事件）、禁用 auto_retry | 不共享可写目录 |
| 远程 Worker | `src/live/remote-worker.ts` | HTTP 服务端/客户端、强 token、任务契约校验、bundle 传输、unknown 状态收敛 | 无独立部署入口（R3.13） |
| 工作区 | `src/live/workspace.ts` | 独立 worktree、变更范围校验、检查命令、提交、bundle 导入导出、专用集成 worktree | 不是 OS 沙箱（R3.8） |
| Worker 守卫 | `src/live/worker-guard.ts` | 原生文件工具路径/链接/writeScopes 检查、Shell 门禁 | 不约束操作员选定的检查程序与 MCP 服务端 |
| 目标状态机 | `src/goal.ts` | 基础 /goal 的创建/派发/结算/接受/预算（次数）生命周期 | 不是 Token 预算；不跨会话自动续跑 |
| 记忆契约 | `src/memory.ts` | MemoryBackend 接口、principal/scope 校验、LocalMemory（幂等/版本/撤回 tombstone）、contextPack | 单进程参考实现 |
| 分层记忆 | `src/live/layered-memory.ts` | 在 StateStore 上组合权威记录+派生视图+提炼任务+增量（changes/delta） | failed 任务不重领（R6.9 缺口） |
| SQL 记忆 | `src/postgres.ts` + `sql/memory-v1.sql` | PostgresMemory：同事务写 items/versions/outbox/receipts、RLS、advisory lock、requestId 重放 | 不自动迁移；凭据不进模型 |
| 状态存储 | `src/live/store.ts` + `sql/runtime-v2.sql` | StateStore 抽象：FileStateStore（目录锁+临时文件+rename+fsync）/ PostgresStateStore（JSONB 单键读改写） | 锁内不得调用外部服务 |
| 能力目录 | `src/capabilities.ts` | SkillCatalog：原始归档不可变、发布校验、分支/阶段激活、authorizeInvocation | 不执行来源脚本；不是权限来源（Role 才是） |
| Skill 仓库 | `src/live/skill-repository.ts` | 安装归档（限额/symlink 拒绝）、编译候选、发布/回滚、资源分页、结果引用 | 自动归组未接线；发布验证回调当前恒真（R4.9） |
| 能力宿主 | `src/live/skills-host.ts` | pi861_capabilities 工具、懒注册+activeTools 收敛、tool_call 门禁、恢复激活、替换被动 Skill 发现 | 元数据 Map 以 toolId 为键（多资源同工具绑定覆盖，R5.5 备注） |
| MCP 客户端 | `src/live/mcp.ts` | stdio/HTTP(SSE) 传输、握手/分页/通知/限额、schemaHash 漂移检测、不重放 tools/call | 非 OAuth broker；自研协议实现（R5.6） |
| 操作日志 | `src/live/operations.ts` | at-most-once 派发回执、等价未决阻塞、operator resolve 核对 | 不宣称外部系统严格只执行一次 |
| 搜索 | `src/search.ts` | Brave 适配（固定端点/头/限额/截断/取消）+ record() 工具函数 | 不做网页读取（R7.6） |

## 3. 数据所有权

### 3.1 持久状态（StateStore 键，`runtime.ts:76-99`）

配置 `database` 时全部落 PostgreSQL（`pi861_runtime_state` 表，键=`projectId:名字`），否则落 `stateDirectory` 下 JSON 文件（0700）。每个键单一所有者：

| 键 | 内容 | 唯一写入者 | 读者 |
| --- | --- | --- | --- |
| `projectId:memory` | LayeredMemoryState（权威记忆+投影+提炼任务+changes） | LayeredMemory（经 store.update 事务） | 同左、恢复路径 |
| `projectId:skills` | SkillState（原始归档/候选/版本/active/结果引用） | SkillRepository | skills-host、/skills、/mcp |
| `projectId:operations` | 操作回执账本 | OperationJournal | /mcp operations、resolve |
| `projectId:budget` | 全局请求配额（limit/used/intents） | RequestBudget | direct() 每次模型请求 |
| `projectId:project` | ProjectState（目标/计划/看板/执行契约/回执） | ProjectCoordinator | ProjectRunner、/goal |
| `integration.json`（`runtime.ts:274-276`） | 集成 worktree 身份 | /goal 处理器 | ProjectRunner |

已知架构债务：`PostgresStateStore` 是键级 JSON 读改写，与 `PostgresMemory` 的逐记录模型并存（R6.15：权威未统一、无迁移）。`stateDirectory` 下另有 `sessions/`（Worker 会话目录）。

### 3.2 会话条目（appendEntry，随 Pi 会话分支持久化）

| customType | 写入者 | 用途 |
| --- | --- | --- |
| `pi861.goal.v1` | GoalController persist | 基础 /goal 状态（恢复用，恢复即被动降级 paused） |
| `pi861.memory.v1` | LocalMemory persist（基础入口无外部 backend 时） | 会话分支本地记忆快照 |
| `pi861.model-runtime.v2` | ModelRuntime save | 模型路由 checkpoint（policyHash 绑定） |
| `pi861.capabilities.v2` | skills-host save | 激活集合（恢复重激活） |
| `pi861.run-settled.v2` | runtime.ts:200-206 | Worker 会话结算信号（pi-rpc waitForSettled 轮询） |

### 3.3 PostgreSQL 表（`sql/memory-v1.sql`）

`pi861_memory_items`（正文+revision+fingerprint）、`pi861_memory_versions`（版本历史）、`pi861_memory_outbox`（index/withdraw 事件，消费者未实现）、`pi861_memory_tombstones`（撤回指纹）、`pi861_memory_receipts`（幂等回执）。全部 FORCE RLS：读按 `pi861.read_scopes`、写按 `pi861.write_scopes` 事务级 set_config；回执表仅本人 principal 可见。运行时角色非超级用户、非 BYPASSRLS；迁移由迁移账号执行。

### 3.4 所有权原则

- 身份（tenant/principal/scope/Role/grants）只能由配置与可信宿主产生（G1）；模型输出没有授权通道。
- 单一权威：记忆提交协议唯一（MemoryBackend）、任务控制权唯一（TaskBoard 单写者+租约）、预算权威唯一（RequestBudget store）、集成执行权唯一（integrationTail——当前仅进程内，见 R3.9 缺口）。
- 派生物（projections、outbox 事件、缓存）可重建，不作为新证据（recall 不能再入库，`memory.ts:82`）。

## 4. 关键生命周期

### 4.1 宿主会话（入口）

初始化顺序（`runtime.ts:66-99,130-149`）：读配置校验 → 建 stateDirectory/数据库池 → 构造五个 store 与服务 → installPi861（managedGoal 判定）→ session_start/session_tree 时 initialize（恢复模型 checkpoint、注册 provider、空闲时切 wrapper 模型）→ 各命令/工具注册。关闭顺序（`runtime.ts:308`）：停止派发（wakeController.abort）→ modelRuntime.close → projectRunner.pause → 等待 enrichment → 数据库池 end。Worker 模式（`PI861_WORKER=1`）额外挂 tool_call 守卫并收敛基础工具集。

### 4.2 模型请求尝试（`routing.ts` / `model-runtime.ts`）

call → choose（安全边界：未分类/待升级时先分类或升级，setPreferred 要求无在途尝试）→ atBoundary（回切判定：需无未决操作且探测就绪）→ inferWithRecovery 循环（beginAttempt → 传输 → succeed/fail/cancel）。generation 单调递增；迟到结果 `owns()` 拒绝；cancel 使 generation++ 且永不触发接管；探测（beginProbe/finishProbe）只在 failback 开启且 preferred≠active 时发生，连续 requiredProbeSuccesses 次成功才 ready。

### 4.3 任务与租约（`scheduler.ts` / `coordinator.ts` / `project-runner.ts`）

claim（依赖全 done+能力/角色/模型匹配+写入范围不冲突）→ running+lease(token,attempt,leaseUntil) → 心跳续租 → submit（产物→review）→ verify（接受→done 或拒绝→blocked）。租约过期：retrySafe 且未耗尽尝试→重新排队，否则 blocked"需核对"。ProjectRunner 在此之上做：真实 Pi 子进程执行 → 变更范围校验 → 检查命令 → （可选审核）→ 提交候选 commit → integrationTail 串行合并到专用集成 worktree → 集成后再检查 → verify。任何一步失败：block+保留现场，不重放。

### 4.4 提炼任务（`layered-memory.ts:110-163`）

put(user/tool 来源) → jobs 入队 queued → enrich：事务内领取（置 running+租约 token/expiresAt）→ **锁外**模型提炼 → 第二次事务提交（重校验 job token、item revision、撤回状态）→ 写 projection+done+change 事件。失败→failed（当前不再重领，R6.9 缺口）；来源更新→obsolete。

### 4.5 操作回执（`operations.ts`）

run：事务内查重（同 intent 重放/冲突）→ 等价未决阻塞 → dispatched → 派发 → committed（结果≤128 KiB）或失败→ not_dispatched（仅当确定未派发）/unknown。unknown 的解除只能由 operator `resolve`（提供核对证据）。

### 4.6 Goal（`goal.ts`）

active ⇄ paused、active→review→completed、任意→cancelled。派发前持久化并消耗次数；结算看 stopReason 与进度报告；恢复会话时 active 强制降级 paused 并清除 runToken/report（被动恢复）。

## 5. 故障边界（当前实现的真实语义）

- **取消不证明副作用未发生**：`deadline.ts`（abortable 只取消等待）；MCP SSE 中断→`McpFailure unknown`（`mcp.ts:129`）；远程任务中断→state=unknown（`remote-worker.ts:98,141`）；子进程退出→"reconcile previously dispatched tools"（`pi-rpc.ts:26`）。
- **未知不重放**：inferWithRecovery 只包缓冲推理；tools/call 从不重试（`mcp.ts:177`）；Worker/验证器失败→block 而非重跑（`scheduler.ts:236-238`）；等价操作未决时拒绝新派发（`operations.ts:26-29`）。
- **存储失败不虚报**：persist 失败保持旧状态（goal.test"persistence failure leaves prior state untouched"）；PostgresMemory 未知 COMMIT 结果保留 requestId 可重试（`postgres.ts:41`）。
- **数据库不可用不产生第二真相**：外部 backend 失败→报错+置空，不切本地（`index.ts:168-177`）。
- 已知未覆盖：direct/generator 辅助调用与 plannerSession 无故障接管/预算（R2.7）；Runner 空闲退出后无唤醒（R3.3）；无 OS 级沙箱（R3.8）。

## 6. 权限边界（纵深，自外向内）

1. **配置层**：Role（skillIds+grants 精确到 toolId/account/resourceIds）、ResourceRule（equals 参数等值 / endpointConfined 断言 / readOnly 分类）、remoteWorkers token、allowWorkerShell、检查命令白名单（CheckCommand 仅 id 被计划引用，命令本体只在配置）。
2. **进程层**：Worker 模式 tool_call 守卫（路径不逃逸 worktree、写入限 writeScopes、symlink/硬链接写拒绝、Shell 默认禁）；LineProcess 永不 shell 插值；检查命令以受限 env（PATH/SystemRoot/PI861_WORKSPACE）运行。
3. **传输层**：MCP/远程 Worker 强制 HTTPS（显式允许的 loopback HTTP 除外）、redirect:error（凭证不转发）、URL 禁内嵌凭据、bearer token 长度≥24 且 timingSafeEqual。
4. **数据层**：PostgreSQL RLS（tenant+scope+principal 事务上下文）；记忆读写 scope 校验在应用层先于 SQL。
5. **提示层**：召回内容标注 UNTRUSTED；搜索结果标注为数据非指令；原始 Skill 仅显式调用。提示层不是安全边界，是附加标注。

## 7. 与 P1 共享契约（`src/contracts/`，计划）的映射

当前类型的演进落点（DEVELOPMENT_PLAN.md 第三节）：C1 身份/配置 ← memory.ts principal + RuntimeConfig；C2 生命周期 ← routing 尝试/探测 + scheduler 租约（需统一"迟到结果拒绝"语义）；C3 预算 ← RequestBudget（需扩到 token/费用/未知用量）；C4 存储 ← StateStore/PostgresMemory（需统一两套 PostgreSQL 模型）；C5 能力/操作 ← capabilities + operations；C6 记忆 ← MemoryBackend 三维模型；C7 产物/验收 ← workspace 证据 + Skill 验证证据（需分类）。契约落地前，本文所述边界即为各模块开发的对接面。

## 8. 已知架构限制（首版如实清单）

1. `runtime.ts` 编译失败（P0），所有仅经完整入口的能力当前不可运行。
2. 两套 PostgreSQL 数据模型并存，权威未统一（R6.15）。
3. 集成单执行权仅进程内（integrationTail），跨进程/重复 resume 无互斥（R3.9）。
4. 无隔离后端；worktree 与文件守卫不是 OS 沙箱（R3.8）。
5. 模型传输为缓冲式，无流式增量与工具参数渐进校验（R2.10 演进项）。
6. 健康状态不跨配置/账户共享，无探测背压（R2.6）。
7. Runner 空闲即退出，追加计划无唤醒路径（R3.3）。
8. 提炼 failed 任务永久滞留（R6.9）。
9. outbox 已写入但无消费者；索引/摘要重建链路未闭合（R6.11 备注）。
10. 扩展依赖宿主进程存活；宿主关闭后无后台运行（R8 边界，README 已声明）。
