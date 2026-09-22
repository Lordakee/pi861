# Pi861 验收矩阵（ACCEPTANCE_MATRIX）

- 首版日期：2026-09-22（P1 阶段交付）。
- **状态绑定代码版本：`e3f07a789b7648f26ec72ce65fa5856046dbd6d3`（`feat/pi861-runtime-v1`）**。后续每次状态更新必须重新绑定当时的代码 SHA，并注明测试所对应的版本。
- 需求条目定义见 [REQUIREMENTS.md](REQUIREMENTS.md)；本文记录每条的代码入口、测试、证据与当前状态。
- 路径约定：代码入口均相对 `extensions/pi861/`，行号为 e3f07a789 版本（P0 修复合入后行号会变化，更新时须重新核对）。

## 1. 当前版本的检查链事实（证据基线）

CI run <https://github.com/wmqfl861/pi861/actions/runs/35687924923>（对应 e3f07a789 推送）：

| 检查 | 结果 | 对本矩阵的含义 |
| --- | --- | --- |
| deterministic（`tsc --noEmit`（不含 runtime.ts）+ `node --test test/*.test.mjs`） | 通过 | 内核与基础入口（index.ts）的协议/安全行为有当前版本证据；16 个 `*.test.mjs` 文件、约 123 个用例全部通过（另有 3 个集成测试文件不在此 job 内）。 |
| postgres（真实临时 PostgreSQL 17 + 受限角色） | 通过 | `postgres.integration.mjs` 在真实数据库上通过；PostgreSQL 事务语义可标"真实服务已验证"。 |
| repository-check（根 `npm run check`） | 通过 | 根仓检查通过。 |
| pi-host（`tsc --project tsconfig.host.json`（**含 runtime.ts**）→ 两个宿主集成测试） | **失败** | `runtime.ts(212,307): error TS1005`（memory.put 外层对象缺一个闭合括号，经本地复核确认：该行 6 个 `{`、5 个 `}`，其中 3 对属模板插值，对象括号 3 开 2 闭）。**两个宿主集成测试（pi-host.integration.mjs、runtime-host.integration.mjs）在当前版本未运行，不能计通过。** |

由此得出本矩阵最重要的限定：

- 一切仅经 `runtime.ts` 完整入口才可达的功能（模型运行时接线、/mcp、/skills、完整 /goal、Worker 守卫），其**端到端状态为"阻塞"**（阻断原因：runtime.ts 编译失败，P0 修复中）；其内核部分的受控测试证据在备注中注明。
- 历史通过记录（[VERIFICATION.md](VERIFICATION.md)，绑定 90295c195 及更早）只覆盖基础入口宿主冒烟，不作为当前 HEAD 的 runtime.ts 证据。
- **fixture 证明协议与安全行为，不证明真实模型任务质量。** 目前没有任何真实付费模型、真实搜索密钥或跨主机多节点的验证。

## 2. 状态 taxonomy（定义）

| 状态 | 定义 |
| --- | --- |
| 未实现 | 无代码，或仅有类型/占位/被丢弃的输入；需求行为不存在。 |
| 仅内核 | 实现在 `src/`（或 `src/live/`）核心并有确定性测试，但未连接任何宿主入口，或连接面不完整。 |
| 已接入 | 已连接 `index.ts` 或 `runtime.ts` 入口且可在模拟环境运行，但当前版本没有端到端受控证据（或证据仅覆盖部分子句）。 |
| 受控协议验证通过 | 在绑定版本的确定性/fixture/临时数据库测试中通过（协议与安全行为层面）。 |
| 真实服务已验证 | 对真实外部服务（真实数据库、真实模型、真实搜索后端、跨主机节点）验证通过并绑定版本证据。 |
| 阻塞 | 依赖未就绪（当前主要是 P0：runtime.ts 编译失败）或需外部授权才能推进/验证。 |

## 3. 需求×入口×测试×状态

### 3.1 通用横切（G）

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| G1 | `src/memory.ts:61`（checkPrincipal）、`runtime.ts:67-90`（principal/Role 来自配置）、`index.ts:154-159` | memory.test.mjs（tenant/principal 校验）、host.test.mjs（外部 backend 显式 scope） | 受控协议验证通过 | runtime 侧加载因 P0 阻塞；模型输出无任何授权通道（设计上不存在）。 |
| G2 | `src/memory.ts:149`（replay）、`src/live/coordinator.ts:23-34`（receipts）、`src/live/operations.ts:16` | memory.test.mjs（重放幂等/意图冲突）、live-project.test.mjs、live-operations.test.mjs | 受控协议验证通过 | 三处均实现 requestId+intent hash 回执。 |
| G3 | `src/memory.ts:173`（expectedRevision）、`src/capabilities.ts:70,101`（不可变 digest）、`src/live/coordinator.ts:52`（expectedVersion） | memory.test.mjs、capabilities.test.mjs、live-project.test.mjs（versioned append） | 受控协议验证通过 | — |
| G4 | `src/live/operations.ts:26-29`（unknown 阻塞）、`src/scheduler.ts:180-187,237`（恢复需核对）、`src/live/remote-worker.ts:49,98,141`（unknown） | live-operations.test.mjs、scheduler.test.mjs、live-remote.test.mjs | 受控协议验证通过 | — |
| G5 | `src/live/layered-memory.ts:110-162`（两段提交）、`src/live/store.ts:12`（锁内禁外部调用约束） | live-memory.test.mjs（withdrawal while extractor runs） | 受控协议验证通过 | — |
| G6 | `runtime.ts:92`、`runtime.ts:305`（`pi as unknown as PiHost` 双重断言）、`runtime.ts:180`（单断言） | — | **阻塞** | P0 任务：以明确宿主适配函数+输入校验取代双重断言；`extensions/tsconfig.json:14` 不含 runtime.ts、根 tsconfig/biome 不含扩展目录属检查盲区，一并修复。内核（src/）无违规。 |
| G7 | 测试实现本身（无密钥路径；`SearchOptions.fetch`、fixtures 注入） | search.test.mjs（disabled/missing-key 不触网）等 | 受控协议验证通过 | 过程性条目：约束测试编写方式。 |
| G8 | `runtime.ts:71`（urlEnv）、`runtime.ts:284`（tokenEnv）、`examples/postgres-extension.mjs` | — | 已接入 | 设计约束无专项测试；配置文件中不出现明文密钥。 |

### 3.2 R1 多模型执行策略

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R1.1 | `src/routing.ts:2-12`（ModelTarget：id/revision/provider/model/quality/costRank/contextWindow/capabilities/enabled） | routing.test.mjs（配置校验） | 仅内核 | 缺账户/端点故障域、计费参数、数据出站边界字段；子 Agent 策略继承未实现。 |
| R1.2 | `src/live/compilers.ts:24`（routeClassifier）、`runtime.ts:133-139`（接线 intakeId/enableRouting） | live-models.test.mjs（fixed route classifies once…） | **阻塞** | 内核受控通过；接待分类经完整 runtime 入口运行需 P0 修复。direct 模式语义由分类器一次决策返回，未再启动第二个路由 Agent。 |
| R1.3 | `src/live/model-runtime.ts:44-133`（classified/pending/mode 状态机）、`runtime.ts:176`（setTask） | live-models.test.mjs（fixed 分类的单次性+升级）、routing.test.mjs | 受控协议验证通过 | 完整入口运行被 P0 阻塞（同上）。 |
| R1.4 | `src/routing.ts:62-79`（eligible 硬过滤+costRank 排序）、`src/live/compilers.ts:27`（提示词质量原则） | routing.test.mjs（quality, context, capability, allowlist hard filters） | 受控协议验证通过 | 提示词对真实模型的有效性未验证（fixture 生成器测试）。 |
| R1.5 | `src/live/model-runtime.ts:91-105`（setTask/report 仅枚举信号）、`runtime.ts:177-184` | — | 仅内核 | `pi861_model_route` 的 reason 在 `runtime.ts:181` 被丢弃；路由器只见任务文本，无阶段/证据摘要（任务书明确点名）。 |
| R1.6 | `src/live/model-runtime.ts:112-119`（escalate 升级路径） | live-models.test.mjs（escalates on a concrete gap） | 仅内核 | 降级（回切到更低价模型）无明确条件实现；升级在安全边界执行。 |
| R1.7 | `src/routing.ts:26-32,145-150,187-241`（开关/探测/边界）、`runtime.ts:185-192`（/model-policy） | routing.test.mjs（disabled failover/failback、备用保持、探测要求）、live-models.test.mjs | 受控协议验证通过 | 运行中修改命令（/model-policy）接线在 runtime（P0 阻塞）；全局默认→Agent→子 Agent 继承层级未实现（单配置源）。 |
| R1.8 | `runtime.ts:105-129`（direct/generator 经 budget.reserve）、`runtime.ts:266`（plannerSession） | — | **阻塞** | 辅助调用计入请求次数预算（接线存在但 runtime 未编译通过）；只读 plannerSession 为独立 Pi 子进程，其模型调用不经 RequestBudget（缺口，M1 任务）；辅助调用不经故障恢复状态机。 |
| R1.9 | `src/live/model-runtime.ts:27-41`（RequestBudget）、`runtime.ts:91`、`src/live/model-runtime.ts:140-141,154`（requests/probes 计数） | live-models.test.mjs（global request allowance atomic/idempotent） | 仅内核 | 仅请求次数计量（默认上限 1000）；输入/输出/缓存 token、费用未计量（wrapper provider 固定返回 0 usage）；未知用量标记未实现。 |

### 3.3 R2 故障接管与回切

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R2.1 | `src/routing.ts:91-92,120-125`（preferred/active 分离） | routing.test.mjs、live-models.test.mjs | 受控协议验证通过 | — |
| R2.2 | `src/routing.ts:145-150`（关 failback 清探测）、`187-205`（fail 仅在 failoverEnabled 时切换） | routing.test.mjs（disabled failover never calls backup / disabled failback issues no probes） | 受控协议验证通过 | — |
| R2.3 | `src/routing.ts:187-241`（分类/退避/Retry-After/稳定确认/边界回切）、`src/routing.ts:258-297`（有限重试+截止）、`runtime.ts:55-64`（HTTP→FailureKind 映射） | routing.test.mjs（retry-after and backoff、deadline fences、buffered inference switches once、unclassified error 不换模型） | 受控协议验证通过 | "首响应/进展"细分截止未实现（当前只有每次尝试总超时 requestTimeoutMs）；熔断以健康退避近似。 |
| R2.4 | `src/routing.ts:181-186`（cancel 不触发接管）、`170-179`（迟到结果拒绝）、`src/live/operations.ts`（unknown 核对） | routing.test.mjs（late successful output cannot revive、user cancellation never starts a backup） | 受控协议验证通过 | — |
| R2.5 | `src/routing.ts:199-205`（无合格备用返回 false→上抛）、`src/live/model-runtime.ts:75-79`（checkpoint 持久化） | routing.test.mjs（no authorized model / no eligible backup 路径） | 受控协议验证通过 | "保存进度暂停"目前表现为 checkpoint 持久化+错误上抛（wrapper 报错文本）；任务级"暂停并保存检查点"的显式状态未完整。 |
| R2.6 | `src/routing.ts:41-46,207-231`（实例内 health+单飞探测+requiredProbeSuccesses）、`src/live/model-runtime.ts:149-160`（maxProbeRequests） | routing.test.mjs（two successful probes required、new preferred invalidates old probe） | 仅内核 | 健康状态仅在本 ModelRecovery 实例内，无跨配置/账户/故障域共享健康服务，无背压。 |
| R2.7 | `runtime.ts:105-129`、`runtime.ts:264-270` | — | **阻塞** | 任务书点名复核路径：direct/generator 不经 inferWithRecovery（无故障接管）；plannerSession 完全独立（无预算）。修复需在 P0 后（M1.6）。 |
| R2.8 | `runtime.ts:177-184`（execute 丢弃 reason） | — | 未实现 | 工具已注册（signal 枚举+reason 参数）但 `modelRuntime.report(parameters.signal)` 未使用 reason。 |
| R2.9 | `src/live/model-runtime.ts:76-90`（policyHash 校验+generation 递增）、`runtime.ts:140-144`（会话分支恢复） | live-models.test.mjs（backup state and request accounting survive a runtime replacement） | 受控协议验证通过 | — |
| R2.10 | `runtime.ts:157-175`（缓冲 wrapper）、`src/routing.ts:33-40,170-179`（尝试归属） | routing.test.mjs（迟到/取消）、live-models.test.mjs | 受控协议验证通过 | 缓冲设计使半截工具参数不可能被派发（无流式增量）；真流式演进（文本增量归属、工具参数完整校验后派发）未实现，属 M1.7。 |

### 3.4 R3 持续调度与多节点

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R3.1 | `src/live/coordinator.ts:7-16`（ProjectState）、`src/scheduler.ts:3-29`（TaskRecord：status/artifacts/evidence/attempts/lease） | scheduler.test.mjs、live-project.test.mjs | 仅内核 | "持续小组"实体未建模（无 team/group 持续对象）；目标/计划/任务/尝试/产物/验收已分离。 |
| R3.2 | `src/scheduler.ts:244-259`（完成即补位）、`src/live/project-runner.ts:98-113` | scheduler.test.mjs（newly unlocked work starts before unrelated slower task ends）、live-project.test.mjs（actual child processes refill…） | 受控协议验证通过 | 本地子进程 fixture；跨进程/多机见 R3.7。 |
| R3.3 | —（`src/live/project-runner.ts:110` 在 running.size==0 时 break；`src/live/coordinator.ts:50` append 无调用方） | — | 未实现 | 空闲后追加任务无法唤醒；无持久唤醒机制（dev plan M4.2）；反例 AX1 后半因此不过。 |
| R3.4 | `src/scheduler.ts:114-137`（claim 全约束）、`62-93`（依赖环）、`42-45`（写入冲突） | scheduler.test.mjs（overlapping paths / slots, capabilities / expired retry-safe / dependency cycles） | 受控协议验证通过 | — |
| R3.5 | `src/live/coordinator.ts:50-57`（append + expectedVersion） | live-project.test.mjs（versioned append enforced） | 仅内核 | append 是程序方法，无滚动规划入口/低水位补充/依赖环增量检查的调用方。 |
| R3.6 | `src/live/coordinator.ts:21`（maxTasks）、`runtime.ts:91`（RequestBudget 全局共享 store）、`runtime.ts:278`（maxConcurrent 槽） | live-models.test.mjs（全局预算） | 仅内核 | 全任务树（含审核/返工/集成/远程）计量未区分；等待父任务释放名额机制未实现。 |
| R3.7 | `src/live/remote-worker.ts:33-146`（服务端/客户端、bundle+sha256、完整差异重验）、`src/live/workspace.ts:61-84` | live-remote.test.mjs（distinct repository, bundle transfer, revalidation） | 受控协议验证通过 | loopback HTTP fixture；跨主机/容器未验证（诚实标注：不称真实多服务器）；请求侧能力校验防自报。 |
| R3.8 | —（`src/live/worker-guard.ts` 仅路径/链接检查；`workspace.ts:12` 注明非 OS 沙箱） | live-guard.test.mjs（native worker paths constrained） | 未实现 | 隔离后端（凭据/网络/进程限制）不存在；文件级守卫已实现但不称沙箱。 |
| R3.9 | `src/live/project-runner.ts:82-92`（integrationTail 进程内串行链） | live-project.test.mjs（串行集成部分） | 仅内核 | 仅单 Runner 实例内串行；重复 `/goal resume` 双协调者/跨进程集成互斥未防护（dev plan M4.7）。 |
| R3.10 | `src/live/project-runner.ts:93-96`（block+workspace 保留）、`workspace.ts`（不清理） | live-project.test.mjs（scope check rejects…保留现场路径） | 受控协议验证通过 | 集成失败后的"可追踪修复入口"未建（阻塞任务需人工检查 worktree）。 |
| R3.11 | `src/live/workspace.ts:24-29`（id=digest(taskId,attempt)） | — | 仅内核 | 身份仅 taskId+attempt，无 goal/run 维度（任务书点名：下一目标复用 taskId 会碰撞）。 |
| R3.12 | `src/scheduler.ts:166-188`（block/recoverExpired）、`107-113`（旧租约拒绝）、`src/live/remote-worker.ts:49`（重启 unknown） | scheduler.test.mjs（expired lease rejects old results / unknown side effects block recovery / cancellation releases scheduler） | 受控协议验证通过 | — |
| R3.13 | `src/live/remote-worker.ts:33-107`（RemoteWorkerServer：token、容量、取消、收敛关闭） | live-remote.test.mjs | 仅内核 | 有类实现与测试，无可执行部署入口（启动脚本/服务化）、心跳通告与租约展示未接；worker 环境注入见 `runtime.ts:280-286`。 |

### 3.5 R4 Skill 加工与治理

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R4.1 | `src/live/skill-repository.ts:47-77`（install 全字节归档+限额）、`src/capabilities.ts:74-78`（readOriginal 显式） | live-skills.test.mjs（install archives full bytes）、capabilities.test.mjs（raw skills absent from automatic browsing） | 受控协议验证通过 | 替换 Pi 默认被动发现的接线在 `src/live/skills-host.ts:146-154`（runtime，P0 阻塞）；显式 /skill:name 调用保留。 |
| R4.2 | `src/live/compilers.ts:35-46`（编译提示词：全文、去重、互斥分支、不发明工具）、`src/live/skill-repository.ts:113-132` | live-skills.test.mjs（fixture 编译器路径）、capabilities.test.mjs（分支条件） | 受控协议验证通过 | 编译质量依赖真实模型，未验证（fixture 编译器）。 |
| R4.3 | `src/live/compilers.ts:47-52`（chooseSkillGroup 已存在） | — | 未实现 | 未接入安装流程；`/skills install` 要求人工 GROUP（`runtime.ts:237`），自动归组无调用方（任务书点名）。 |
| R4.4 | `src/capabilities.ts:105-116`（browse/branches）、`117-142`（activate 完整约束）、`src/live/skill-repository.ts:156-171` | capabilities.test.mjs（activating returns only selected phase bindings）、live-skills.test.mjs | 受控协议验证通过 | — |
| R4.5 | `src/live/skill-repository.ts:113-155`（candidate→publish→rollback）、`src/capabilities.ts:99-104`（版本不可变） | live-skills.test.mjs（source is not discoverable until trusted publication / source changing rejects stale candidate）、capabilities.test.mjs（new publications do not mutate pinned versions） | 受控协议验证通过 | "发布版本固定到运行中任务"（运行中不替换）未实现（任务在运行时不会自动重激活）。 |
| R4.6 | —（compile 输入 documents 无 ToolBinding 通道；`src/live/compilers.ts:40` 提示"只能用 operator 提供的绑定"但绑定未传入） | — | 未实现 | 任务书点名：不能提示模型用绑定却不传入。 |
| R4.7 | `src/live/skill-repository.ts:48-68`（symlink 拒绝、路径规范、限额）、worker 写入侧链接检查 `src/live/worker-guard.ts:21` | live-skills.test.mjs（symbolic links not traversed） | 仅内核 | Windows 空格路径靠"JSON 配置注入"规避（命令行分词会破坏）；安装侧硬链接未检查；大小上限已有。 |
| R4.8 | 安装路径无脚本执行点（`skill-repository.ts` 只读归档）；编译提示词禁止执行 | live-skills.test.mjs | 受控协议验证通过 | 设计性保证。 |
| R4.9 | `runtime.ts:248-249`（publish 的 validate 回调恒 `passed:true` + `user-reviewed:` 证据） | — | 未实现 | 任务书点名：不能始终 returned passed:true 称自动验收；行为测试与证据类型区分缺失（M2.4）。 |
| R4.10 | `src/live/skill-repository.ts:149-154`（rollback） | capabilities.test.mjs（版本不可变支撑） | 仅内核 | 卸载、受影响重建、运行中版本固定未实现。 |

### 3.6 R5 岗位授权与 MCP

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R5.1 | `src/capabilities.ts:32-36,49-52`（Role.grants）、`src/live/skills-host.ts:13-30,66-75`（ResourceRule/enforceResource） | capabilities.test.mjs（every invocation checks current grants and exact account/resource） | 受控协议验证通过 | — |
| R5.2 | `src/live/skill-repository.ts:78-108`（publishMcp 确定性 Skill）、`runtime.ts:219-232`（/mcp refresh 接线） | live-mcp.test.mjs、live-skills.test.mjs（Skill activation registers real MCP tools lazily） | 受控协议验证通过 | `/mcp` 命令接线在 runtime（P0 阻塞）；内核发布+激活已测。 |
| R5.3 | `src/live/skills-host.ts:77-119`（activate 按分支/阶段注册）、`155-160`（未激活直调拦截） | capabilities.test.mjs（unauthorized required tool does not silently disappear）、live-skills.test.mjs、host 侧 tool_call 门禁 | 受控协议验证通过 | — |
| R5.4 | `src/capabilities.ts:146-158`（authorizeInvocation 每次调用）、`src/live/mcp.ts:172-178`（call 前刷新 schema） | capabilities.test.mjs（interface drift prevents activation）、live-mcp.test.mjs | 受控协议验证通过 | — |
| R5.5 | `src/live/skills-host.ts:33`（bindingName=digest(toolId,accountId,resourceId)）、`90-116`（闭包绑定） | live-skills.test.mjs（懒注册+当前授权） | 受控协议验证通过 | 边界缺口：`skills-host.ts:54-65` describe() 的元数据 Map 以 toolId 为键，同一工具多资源绑定时互相覆盖（dev plan M2.6 点名），注册名本身不冲突。 |
| R5.6 | `src/live/mcp.ts:16-183`（握手/分页/通知/SSE/限额/超时/404 会话失效/SSE 提前结束=unknown） | live-mcp.test.mjs（real stdio MCP process: initialize, discover and call / unsafe plain HTTP rejected） | 仅内核 | 自研协议客户端（非官方 SDK）；取消传播、重连策略、通知全集需按 M2.7 评审官方 SDK 后补齐。 |
| R5.7 | `src/live/skills-host.ts:84,99`（currentRole 每次取值）、browse 只读 | capabilities.test.mjs（returned data cannot mutate grants）、live-skills.test.mjs | 受控协议验证通过 | — |
| R5.8 | `src/live/skills-host.ts:102-109`（超限→resultRef）、`src/live/skill-repository.ts:172-188`（readResult 分页+权限关联） | live-skills.test.mjs（capability factory 不调用未绑定方法） | 受控协议验证通过 | 默认 32 KiB 内联、超出转引用；字段级读取未实现（分页为字符偏移）。 |
| R5.9 | `src/live/operations.ts:13-68`（at-most-once、等价未决阻塞、resolve 核对、100k 回执上限） | live-operations.test.mjs（replays committed result / unknown side effect blocks equivalent fresh call） | 受控协议验证通过 | 操作 ID 为 digest(会话,callId) 派生而非纯"稳定业务操作 ID"；重试新调用生成新 ID 但被等价指纹阻塞，效果等价、语义待 M2.8 强化。 |
| R5.10 | `src/live/worker-guard.ts:7-23`（bash/powershell 门禁+writeScopes）、`runtime.ts:294-307`（worker baseTools 收敛） | live-guard.test.mjs | 仅内核 | 接线在 runtime（P0 阻塞）；allowWorkerShell 显式开启语义已实现。 |
| R5.11 | — | — | 未实现 | 可信本地模式与生产隔离模式未定义区分（M2.9）。 |
| R5.12 | MCP 出站：`skills-host.ts:66-75`（参数等于约束）；网页侧见 R7 | capabilities.test.mjs（参数越界拒绝路径） | 受控协议验证通过 | 网页读取出站策略整体未实现（R7.6）。 |

### 3.7 R6 记忆与 PostgreSQL

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R6.1 | `src/memory.ts:3,10-28`（kind/三视图字段）、`199-221`（contextPack L0/L1/L2）、`src/live/layered-memory.ts:40-46`（projection 关联 sourceRevision） | memory.test.mjs（context pack byte-bounded, provenance-bearing）、live-memory.test.mjs（generated L0/L1 does not replace full evidence） | 受控协议验证通过 | 未强求三份：写入者提供 abstract/overview，提炼任务生成派生视图。 |
| R6.2 | `src/memory.ts:61-70`、`133-137,143-147` | memory.test.mjs（unauthorized scope rejected）、live-memory.test.mjs（other project cannot search/list/delta） | 受控协议验证通过 | — |
| R6.3 | `index.ts:203-233`（before_agent_start 召回装配）、`index.ts:147-177`（会话恢复） | host.test.mjs（recall 相关） | 仅内核 | 覆盖启动/接手；"换模型、压缩后、换节点"装配场景未实现（M3.4）。 |
| R6.4 | `index.ts:210-221`（去重+词法查询）、`src/live/layered-memory.ts:99-109`（delta 游标）、`106-109`（pack 预算） | live-memory.test.mjs（delta paging does not lose simultaneous writes） | 仅内核 | 事件级召回模型未实现；当前为关键词基线（任务书允许作为基线）。 |
| R6.5 | `index.ts:184-202`（input 捕获：source 过滤、secretLike 拒绝、32k 截断） | host.test.mjs（auto capture excludes extension prompts, credentials…） | 受控协议验证通过 | 基础入口路径；默认开启。 |
| R6.6 | `runtime.ts:207-213`（tool_execution_end 捕获、64k/敏感过滤） | — | **阻塞** | 接线在 runtime（P0 阻塞）；超大（>64k）或含敏感模式的结果当前直接 return（丢弃），见 R6.7。 |
| R6.7 | —（无受控引用路径） | — | 未实现 | 超大/敏感工具结果应保存受控引用（M3.5）。 |
| R6.8 | `src/live/layered-memory.ts:110-163`（领取租约/两段提交/提交重校验；模型调用在 store.update 外） | live-memory.test.mjs（withdrawal while an extractor runs cannot resurrect / fabricated quotations fail closed） | 受控协议验证通过 | 默认 attempts<3、每次唤醒 maxJobsPerWake=2（runtime 配置）。 |
| R6.9 | `src/live/layered-memory.ts:118-119`（领取条件仅 queued 或过期 running；:156 failed 写入后不再被领取） | — | 未实现 | 任务书点名缺口：失败分类、重试与人工处理入口缺失（M3.6）；反例 AX8 因此不过。 |
| R6.10 | `src/memory.ts:71-86`（recall 拒绝为新证据、inference 不得自确认/constraint）、`layered-memory.ts:134-139`（quote 字面校验） | memory.test.mjs（recalled text not accepted / model inference cannot claim confirmation）、live-memory.test.mjs | 受控协议验证通过 | — |
| R6.11 | `src/memory.ts:179-195`（tombstone）、`src/live/layered-memory.ts:78-89`（撤回传播任务/投影）、`src/postgres.ts:104-113`（DB tombstone+outbox） | memory.test.mjs（withdrawal idempotent / suppresses re-ingestion / paraphrases from same source）、live-memory.test.mjs | 受控协议验证通过 | outbox 消费者（索引重建）未实现，排队事件≠索引已更新。 |
| R6.12 | —（无自动升格路径；无经验→Skill 候选通道） | memory.test.mjs（候选不可自确认） | 受控协议验证通过 | "经验生成 Skill 候选"通道未实现（M2/M3 接口），负向约束已满足。 |
| R6.13 | `sql/memory-v1.sql`（全表+RLS）、`src/postgres.ts:17-146`（事务/advisory lock/重放/outbox） | postgres.integration.mjs（real PostgreSQL: atomic memory, CAS, RLS and withdrawal）+ postgres.test.mjs | **真实服务已验证** | CI postgres job（PostgreSQL 17 临时库+受限角色）@ e3f07a789 通过；仅 loopback 测试库，未触用户业务库。 |
| R6.14 | `examples/postgres-extension.mjs`（TLS/CA/池/超时/strip URL ssl 参数）、`sql/*.sql` 头注（迁移账号分离） | postgres.integration.mjs（受限角色/迁移升级子用例） | 仅内核 | 备份/恢复流程未实现（运维项）；凭据委派服务未实现。 |
| R6.15 | `src/live/store.ts:60-92`（PostgresStateStore JSON 读改写）与 `src/postgres.ts`（逐记录模型）并存 | — | 未实现 | 两套数据模型权威未选定、无迁移（任务书点名；M3.1-3.3）。 |
| R6.16 | `index.ts:214-217`（Intl.Segmenter 分词）、`layered-memory.ts:55-62`（词法评分） | memory.test.mjs（search 约束） | 仅内核 | pgvector 未实现且无装饰性开关（如实）；中文/代码符号/路径检索专项测试未补。 |
| R6.17 | `index.ts:168-177`（外部 backend 失败→通知+memory 置空，不切本地）、`examples/postgres-extension.mjs:29` | host.test.mjs（no local fallback is created on a failed external write） | 受控协议验证通过 | "本地待同步队列"未实现（当前失败即丢弃+警告）；"关键检查点未提交则暂停执行边界"未接线。 |
| R6.18 | `index.ts:91-92`（env 开关）、`runtime.ts:39,92,194-218`（config 三开关+memory-maintain 命令）、`index.ts:311-327`（主动工具） | host.test.mjs、live-memory.test.mjs | 已接入 | env 层在基础入口可用；项目/岗位继承层级未实现。 |

### 3.8 R7 搜索

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R7.1 | `index.ts:296-310`（命令+工具，未动本地工具集）、`src/search.ts:1`（独立适配） | host.test.mjs（disabled search has no model tool） | 受控协议验证通过 | — |
| R7.2 | `src/search.ts:45-94`（固定端点/头/限额）、`index.ts:81-84`（env 配置） | search.test.mjs（9 用例：固定端点头、限额、畸形响应、取消不触网等） | 受控协议验证通过 | HTTP fixture（fetch 注入）；无真实密钥联网验证（待授权）。 |
| R7.3 | `src/search.ts:3-9,76-93`（retrievedAt/truncated/错误不伪造） | search.test.mjs（malformed payload not reported as zero hits / truncated snippets marked） | 受控协议验证通过 | — |
| R7.4 | `index.ts:81-84`（默认关闭）、`search.ts:46-47`（无密钥报错） | search.test.mjs（disabled or missing-key does not call backend） | 受控协议验证通过 | 工具描述明示不外发私有内容（提示层约束）。 |
| R7.5 | `src/search.ts:24-43,49-57` | search.test.mjs（oversized body stopped / cancelled never reaches network） | 受控协议验证通过 | — |
| R7.6 | — | — | 未实现 | 网页正文提取与网络边界防护（M5.2-5.4）。 |
| R7.7 | —（大结果引用机制在 Skill/MCP 侧已有，搜索结果未接） | — | 未实现 | 搜索结果当前为内联 JSON；长网页内容依赖 R7.6。 |

### 3.9 R8 /goal

| 编号 | 代码入口 | 测试 | 状态 | 缺口 / 备注 |
| --- | --- | --- | --- | --- |
| R8.1 | `index.ts:250-274`（基础入口全动词）、`src/goal.ts:41-210` | goal.test.mjs（12 用例）、host.test.mjs | 受控协议验证通过 | 完整 runtime `/goal`（`runtime.ts:254-291`）仅有 status/pause/resume/accept/clear，缺 edit/budget（dev plan M4.11）。 |
| R8.2 | `src/goal.ts:107-117`（report 校验）、`index.ts:275-295`（goal_report 工具） | goal.test.mjs（no evidence cannot request completion） | 受控协议验证通过 | — |
| R8.3 | `src/goal.ts:82-106,143-154`（预算单调/空转暂停）、`index.ts:184-192`（用户输入暂停） | goal.test.mjs（run budget monotonic / unproductive continuation stops） | 受控协议验证通过 | — |
| R8.4 | `index.ts:103-130`（单飞 continuation）、`runtime.ts:92`（managedGoal 抑制双注册）、`runtime.ts:253-293`（统一队列） | host.test.mjs（refill after settlement） | 已接入 | 基础入口受控通过；完整 runtime 统一队列接线被 P0 阻塞。 |
| R8.5 | `src/goal.ts:50-65`（恢复降级 paused+清 token） | goal.test.mjs（restoring interrupted work is passive） | 受控协议验证通过 | — |
| R8.6 | `runtime.ts:253-293`（planner→projectPlan→coordinator→Runner） | live-project.test.mjs（内核链路：真实子进程+检查+集成） | **阻塞** | 端到端经完整 runtime 入口需 P0 修复；只读 planner 检查真实源码（--tools read,grep,find,ls）。 |
| R8.7 | —（onProgress 仅事件流） | — | 未实现 | 未满并发原因解释视图（M4.12）。 |
| R8.8 | `src/goal.ts:118-155,194-201`（review→accept、settle 去重） | goal.test.mjs（duplicate settle / completion only requests review） | 受控协议验证通过 | 自动检查证据（workspace.check）与人工 accept 在完整链路中区分（live-project）。 |

### 3.10 验收反例（AX）

| 编号 | 测试入口（计划/现有） | 状态 | 说明 |
| --- | --- | --- | --- |
| AX1 | `scheduler.test.mjs`、`live-project.test.mjs`（前半已覆盖） | 仅内核 | "A 验收后 C 先于 B 启动"受控通过；"空闲后追加任务唤醒"未实现（R3.3）。 |
| AX2 | `live-project.test.mjs`（未验收不解锁已覆盖）；返工集成测试未建 | 仅内核 | 审核失败→关联返工任务的流程未实现（M4.6）。 |
| AX3 | `routing.test.mjs`、`live-models.test.mjs`、`runtime-host.integration.mjs` | 受控协议验证通过 | 前两者 @ e3f07a789 CI 通过；runtime-host 集成当前版本未运行（P0 后补）。 |
| AX4 | 流式故障测试（未建）、`live-operations.test.mjs`、`live-mcp.test.mjs` | 未实现 | 无流式路径可断流；回执丢失核对已有内核覆盖（live-operations），断流五位置整体未实现（M1.7）。 |
| AX5 | `live-skills.test.mjs`（部分：归档/版本/回滚）；宿主集成测试未建 | 未实现 | 依赖 R4.3 自动归组接入（两份 Debug 去重场景）。 |
| AX6 | `live-mcp.test.mjs`、`live-skills.test.mjs`、宿主集成测试 | 受控协议验证通过 | 未激活不暴露、激活必需项、撤权、schema 变化、隐藏名直调均有内核测试；跨账户/重复绑定细项待 M2.6 补。 |
| AX7 | `live-memory.test.mjs`、`postgres.integration.mjs`、跨 Worker 测试（未建） | 受控协议验证通过 | 换会话恢复、私有不泄漏、撤回不复活已覆盖；"换模型/换节点（跨 Worker）"场景未建。 |
| AX8 | `postgres.test.mjs`（requestId 确认已覆盖）；提炼失败恢复未实现 | 仅内核 | failed 提炼任务不重领（R6.9）；本地镜像冒充共享提交的防护已有（R6.17）。 |
| AX9 | `live-project.test.mjs`、`live-remote.test.mjs`（版本冲突部分）；Goal 恢复集成测试未建 | 仅内核 | 双协调者/进程重启恢复的单一执行权未实现（R3.9）。 |
| AX10 | `goal-e2e.integration.mjs`（未建） | 未实现 | 端到端闭环依赖 P0+各模块；模型将用本地确定性 provider 并明确标注。 |

### 3.11 可选增强（O）

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| O1 pgvector | 未实现 | 无装饰性开关（检索为关键词基线，如实标注）。 |
| O2 网页正文提取 | 未实现 | M5 范围。 |
| O3 多搜索后端 | 未实现 | provider 字面量 "brave"；fetch 注入为测试缝。 |
| O4 源码宿主验证 | 阻塞 | P0 计划新增（复用 pi-test.sh 的 tsx --tsconfig 启动）；当前仅已发布 Pi 0.86.1 宿主验证。 |

## 4. 首版状态分布（@ e3f07a789，109 条）

| 状态 | 条数 | 占比 |
| --- | --- | --- |
| 受控协议验证通过 | 56 | 51.4% |
| 真实服务已验证 | 1 | 0.9%（R6.13，PostgreSQL 17 临时库） |
| 已接入 | 3 | 2.8% |
| 仅内核 | 23 | 21.1% |
| 未实现 | 19 | 17.4% |
| 阻塞 | 7 | 6.4%（G6、R1.2、R1.8、R2.7、R6.6、R8.6、O4——其中 6 条的直接阻断原因是 P0：runtime.ts 编译失败） |

读法提醒：

1. "受控协议验证通过"中相当一部分条目的受控证据来自内核/基础入口测试，其完整 runtime 接线要等 P0 合入后才能端到端运行（各条备注已注明）。
2. 没有任何条目获得"真实付费模型/真实搜索/跨主机多节点"验证；相关验收脚本属任务书第 9 节要求的默认关闭项，待授权。
3. 未实现与阻塞条目就是 P2 各模块（M1–M5）的工作清单输入。
