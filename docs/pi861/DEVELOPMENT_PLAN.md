> **由 codex（gpt-6-astra / model_reasoning_effort="max"）生成于 2026-09-22，基线 e3f07a789**
> （分支 `feat/pi861-runtime-v1`，HEAD `e3f07a789b7648f26ec72ce65fa5856046dbd6d3`）
>
> 生成命令：`codex exec -m gpt-6-astra -c model_reasoning_effort="max" -s read-only`（read-only 沙箱，只读规划，codex 未修改任何仓库文件）。
> 需求依据：`docs/pi861/HANDOFF_PROMPT_2026-09-22.md`。以下为 codex 输出的完整计划原文。

<!-- codex-plan-start -->
**一、执行基线与阶段安排**

本计划基于分支 `feat/pi861-runtime-v1`、HEAD `e3f07a789b7648f26ec72ce65fa5856046dbd6d3` 的实际源码。已完整阅读指定任务书、根 AGENTS.md、三份历史计划/验证文档、扩展入口、全部 `src/`、`test/`、`sql/` 文件及相关工作流。

本次仅做只读规划，未修改文件，未安装依赖，未运行构建、类型检查或测试。已有的 AGENTS.md 未提交改动和未跟踪任务书保持原状。以下命令均属于后续开发执行步骤。

路径约定：下文 `src/`、`test/`、`sql/` 均相对 `extensions/pi861/`；拟新增文件明确标注“新增”。现有文件行号对应上述 HEAD。

| 阶段 | 交付目标 | 前置条件 | 退出条件 |
|---|---|---|---|
| P0 | 修复 runtime 解析错误，恢复完整检查链和宿主加载 | 当前基线 | 四层检查分别通过；发布宿主与源码宿主均实际运行测试 |
| P1 | 建立需求台账，落地共享契约及宿主组合边界 | P0 | 契约可编译、边界测试通过、文件所有权明确 |
| P2 | 五模块纵向开发 | P1 | 各模块完成入口、持久化、恢复、权限及验收链 |
| P3 | 跨模块集成、十条反例及端到端闭环 | 对应模块就绪 | 十条反例全部实际执行通过，故障恢复有证据 |
| P4 | 独立审核、文档定稿、可复现交付 | P3 | 未参与开发的子代理复核通过；R1–R8 状态与证据完整 |

后续由 ZCode 主代理协调子代理开发；独立审核者不得参与被审核项的开发。重新调用 Codex 制定或调整计划时，使用项目规定的：

```text
codex exec -m gpt-6-astra -c model_reasoning_effort="max"
```

开发仅在功能分支及其派生任务分支进行，采用独立 worktree；远程开发节点采用独立检出。共享契约、组合入口、根依赖、锁文件和 CI 由指定协调子代理维护。按实际并发槽位滚动分配任务，提前完成的子代理领取下一项就绪任务或进入独立审核，不等待整批结束。

---

**二、P0：修复 runtime 并恢复四层检查链**

**1. 按真实位置处理 TS1005**

任务书记录的 `runtime.ts(212,307)` 是 **第 212 行、第 307 列**，不是两个独立报错行。

当前 [runtime.ts:212](C:/Albert/project/pi861/extensions/pi861/runtime.ts:212) 的 `memory.put` 调用在关闭 `source` 和 `item` 后，缺少外层请求对象的闭合。应拆成可审查的多行结构，补齐对象闭合，并保留工具结果的来源、请求身份和写入语义。

[runtime.ts:307](C:/Albert/project/pi861/extensions/pi861/runtime.ts:307) 是 `installCapabilities` 参数对象的尾部，应一起核对；当前源码不能支持“该行还有第二处独立 TS1005”的结论。修复后继续处理编译器实际报告的全部类型、API 和运行错误。

**2. 消除宿主适配的检查盲区**

当前覆盖情况：

- 根 [tsconfig.json:57](C:/Albert/project/pi861/tsconfig.json:57) 和 [biome.json:27](C:/Albert/project/pi861/biome.json:27) 未包含扩展目录。
- 扩展 [tsconfig.json:14](C:/Albert/project/pi861/extensions/pi861/tsconfig.json:14) 检查 `index.ts` 和 `src/**/*.ts`，未包含 `runtime.ts`。
- [tsconfig.host.json:3](C:/Albert/project/pi861/extensions/pi861/tsconfig.host.json:3) 才包含完整 runtime。
- 当前 CI 在 [pi861-runtime.yml:95](C:/Albert/project/pi861/.github/workflows/pi861-runtime.yml:95) 执行真实宿主类型检查，之后才运行两个宿主测试。

开发动作：

1. 为所有生产入口建立 lint/typecheck/test 覆盖表，包括 `runtime.ts`、基础组合入口、PostgreSQL 示例及后续 Worker 服务入口。
2. 将扩展生产代码纳入格式和 lint 检查，保留独立核心检查与实际宿主检查两层职责。
3. 核对现有窄端口与真实 `ExtensionAPI`，重点检查事件重载、工具参数 schema、执行参数、Provider 流事件和生命周期。真实工具定义见 [types.ts:452](C:/Albert/project/pi861/packages/coding-agent/src/core/extensions/types.ts:452)。
4. 用明确的宿主适配函数及输入校验取代入口中的双重断言依赖。不得新增 `any`、`ts-ignore`、双重断言或扩大排除项来消除诊断。
5. 若已发布宿主与当前源码存在接口差异，分别实现和验证明确的适配边界，记录支持范围。

**3. 确定唯一完整入口**

当前包清单 [package.json:8](C:/Albert/project/pi861/extensions/pi861/package.json:8) 自动加载 `index.ts`；完整 runtime 在 [runtime.ts:92](C:/Albert/project/pi861/extensions/pi861/runtime.ts:92) 又调用基础安装函数，并按 `managedGoal` 控制旧 Goal 注册。

目标安排：

- `runtime.ts` 成为文档和包配置中明确的完整运行入口，要求可信的绝对路径 `PI861_CONFIG`。
- 保留 `index.ts` 的有意功能和基础组合用途；明确其独立使用模式及与完整 runtime 的互斥关系。
- 增加重复安装保护，保证同一宿主只有一个 Goal 所有者、一个模型控制器和一套自动记忆采集。
- 固定初始化顺序：配置校验 → 可信身份与存储 → 预算/操作回执 → 模型服务 → 记忆与能力服务 → Goal/Worker → 会话恢复。
- 关闭时先停止派发并取消所属工作，再等待受控收敛，最后关闭 MCP、子进程和数据库连接。

**4. 分别恢复四层检查**

后续在 Node `>=22.19.0`、隔离依赖和测试环境中执行：

| 层 | 执行位置与命令 | 必须证明 |
|---|---|---|
| ① 根检查 | 仓库根目录：`npm run check` | 完整输出通过；检查自动格式化造成的实际差异 |
| ② 扩展独立 tsc | 扩展目录：`node ../../node_modules/typescript/bin/tsc --noEmit --project tsconfig.json` | 核心和窄端口严格类型检查通过 |
| ③ 实际 Pi 类型 | 保留现有 `tsconfig.host.json` 对隔离安装 Pi 0.86.1 的检查；新增源码宿主类型配置，复用根路径映射 | 完整入口分别匹配已发布宿主和当前工作树源码类型 |
| ④ 实际宿主测试 | 扩展目录：`node --experimental-strip-types --test test/pi-host.integration.mjs test/runtime-host.integration.mjs` | 两个测试文件均实际执行，失败数和跳过数均为零 |

同时运行扩展确定性测试：

```text
node --experimental-strip-types --test test/*.test.mjs
```

执行环境准备沿用 `npm ci --ignore-scripts` 和模型目录生成规则；由生成器准备模型目录并记录摘要，不手改 `models.generated.ts`。根检查包含 `biome --write`，因此必须在隔离工作区检查并审查其改动。

**5. 补齐两种真实宿主验证**

当前 CI 仅安装已发布 Pi 0.86.1；两个宿主测试均在缺少 `PI861_TEST_PI_CLI` 时跳过。

- 保留发布宿主验证。
- 新增当前工作树源码宿主验证，复用 [pi-test.sh:57](C:/Albert/project/pi861/pi-test.sh:57) 的 `tsx --tsconfig` 启动方式。
- 将测试宿主启动配置扩展为可表达命令、参数数组和必要环境的契约，以支持源码启动。
- 两种宿主使用独立的依赖解析环境，记录实际 CLI 路径、宿主版本或源码 SHA。
- CI 缺少必要宿主配置时明确失败，不能把 skip 计为成功。
- 保留现有四个 CI job，补充任务分支触发、相关根配置变更触发及日志产物。源码启动路径用于满足工作树验收，不安排未经请求的 `npm run build`。

**P0 退出条件：**语法、类型、入口重复注册和宿主运行问题全部解决；四层检查均有对应版本的完整日志。旧测试若需调整，必须记录原安全不变量由哪些同等或更强断言继续覆盖。

---

**三、P1：先建立台账，再落地共享契约**

**1. 开发前建立五份文档首版**

在 P0 后、模块开发前，新增：

- `docs/pi861/REQUIREMENTS.md`
- `docs/pi861/ACCEPTANCE_MATRIX.md`
- `docs/pi861/ARCHITECTURE.md`
- `docs/pi861/CONFIGURATION.md`
- `docs/pi861/HANDOFF.md`

将原 R1–R8 与任务书补充要求拆成可追踪子条目，如 `R2.1`、`R2.2`。每条记录当前入口、缺口、负责人、测试和完成证据；后续按阶段持续更新。

状态采用任务书规定的：**未实现、仅内核、已接入、受控协议验证通过、真实服务已验证、阻塞**。状态绑定代码版本；历史 VERIFICATION 不作为当前 HEAD 的通过证据。

**2. 共享契约的文件与职责**

新增 `src/contracts/`，将现有类型演进为以下跨模块契约。先交付类型、运行时校验、版本规则和必要适配，随后各模块实现具体服务。

| 编号 | 契约及建议文件 | 必须固定的语义 | 消费模块 |
|---|---|---|---|
| C1 | `identity.ts`、`configuration.ts` | 可信主体、岗位、授权 scope、出站策略；tenant/project/goal/run/task/attempt 身份；配置版本及继承 | 全部 |
| C2 | `lifecycle.ts` | 暂停、取消、恢复、会话代际、租约和执行权；迟到结果拒绝；可持久事件及唤醒规则 | 模型、记忆、调度、MCP |
| C3 | `budget.ts` | 全任务树容量；请求尝试预留与结算；输入/输出/缓存用量、费用、探测及辅助调用；未知用量状态 | 全部 |
| C4 | `storage.ts` | `requestId`、预期版本、事务回执、提交未知状态、outbox、分页与增量游标；存储锁内禁止外部调用 | 记忆、调度、Skill、操作回执 |
| C5 | `capability.ts`、`operation.ts` | Skill 固定版本、分支/阶段绑定；服务/账户/资源/schema 身份；稳定业务操作 ID 与核对状态 | Skill/MCP、模型、调度 |
| C6 | `memory.ts` | 用途、范围、读取深度三维模型；来源链、修订、派生物、撤回、必要上下文装配 | 记忆、模型、调度 |
| C7 | `artifact.ts`、`acceptance.ts` | 受控产物引用、完整性、来源、分页、权限；结构检查、行为检查、独立审核和人工接受的证据分类 | 搜索、Skill、记忆、调度、验收 |

关键约束：

- 身份与授权由可信宿主或服务端产生；模型提供的 tenant、role、scope 等字段不能授予权限。
- 配置区分行为偏好与权限上限。明确全局默认、项目/岗位设置、Agent 覆盖、子 Agent 继承和运行中修改规则；授权范围不自动扩大。
- 每次实际模型尝试先预留预算，再结算；无法取得用量时保留“未知/待核对”，采用有界保守处理。
- 生命周期和副作用状态分开：取消等待不等于外部操作未发生。
- 接口、事件和持久数据都有版本；冲突显式返回，禁止默默覆盖。

**3. 解除并行开发的共享文件冲突**

`runtime.ts`、`index.ts`、`compilers.ts`、`src/contracts/`、根配置、依赖及 CI 由协调子代理管理。模块通过独立服务/安装入口提供能力，由协调子代理完成组合接线。

如需拆分 `compilers.ts`，在本阶段按模型分类、Skill 编译、记忆提炼、项目规划四项职责完成纯移动，再分配所有权，避免五个模块同时改同一文件。

**P1 退出条件：**契约在严格类型检查下成立；身份伪造、版本冲突、重复请求、租约过期、预算耗尽和撤权行为有可复用契约测试；五模块能够在独立 worktree 中开发。

---

**四、P2：五模块纵向并行开发**

| 模块 | 主责需求 | 独占开发范围 | 集成交付依赖 |
|---|---|---|---|
| M1 模型可靠性路由 | R1、R2 | 路由、模型运行服务及对应测试 | C1–C5；记忆上下文、调度证据 |
| M2 Skill 与 MCP | R4、R5 | 能力目录、Skill 仓库、MCP、操作回执及测试 | C1–C5、C7；M1 辅助模型服务 |
| M3 记忆与 PostgreSQL | R6 | 记忆服务、存储适配、SQL、迁移及测试 | C1–C4、C6–C7；M1 提炼调用 |
| M4 调度与 Goal 多节点 | R3、R8 | 调度、Goal、Worker、工作区与集成流程 | C1–C7；M1/M2/M3 实际适配 |
| M5 搜索与验收 | R7；跨 R1–R8 验收 | 搜索、网页读取、受控验证脚本与跨模块测试 | C1–C3、C7；其余模块入口 |

共享契约就绪后五项均可开始。开发时可使用确定性替身验证契约，模块交付和 P3 验收必须连接实际实现。

**M1：模型可靠性路由——R1、R2**

**目标：**主执行、接待分类、规划、Skill 编译、记忆提炼和健康探测共用可靠性与预算机制。

**文件与入口：**`src/routing.ts`、[model-runtime.ts:44](C:/Albert/project/pi861/extensions/pi861/src/live/model-runtime.ts:44)、`compilers.ts` 的路由部分，以及 runtime 的 Provider、`pi861_model_route`、`/model-policy` 接线。

当前 [runtime.ts:105](C:/Albert/project/pi861/extensions/pi861/runtime.ts:105) 的 `direct` 预留请求次数后直接请求模型；`generator` 使用同一路径，但不经过主执行恢复状态机。只读规划子会话另有调用路径。`pi861_model_route` 在第 181 行只传递 signal，丢失 reason。

**契约依赖：**C1 的模型身份和出站范围；C2 的安全边界与尝试执行权；C3 的统一预算；C4 的回执；C5 的未决操作状态。

开发任务：

1. 完整模型配置加入账户/端点故障域、版本、能力、上下文与输出限制、计费和出站约束。接待调用一次返回“直接完成结果”或“固定/动态执行决策”。
2. 路由输入包含当前阶段、reason、验证结果、无进展证据和范围变化。固定模式保持正常执行稳定；动态模式按事件重评估。降级要求明确的阶段完成和质量条件。
3. 保持 preferred/active 分离；补全全局、Agent、子 Agent 和运行中修改下的 failover/failback 四组合。业务升级后的新 preferred 不被旧探测覆盖。
4. 补齐连接、首响应、进展和总截止时间，有限重试、退避、Retry-After、熔断和稳定恢复确认。取消、服务拒绝和不合格备用走明确暂停或终止路径。
5. 建立按配置/版本/账户/故障域共享的健康服务，探测单飞、有预算、有背压；关闭 failback 时停止仅服务于回切的探测。
6. 将所有辅助调用及 Pi plannerSession 纳入统一请求服务和计量。
7. 演进目前缓冲完整响应的 wrapper：文本增量有尝试归属；工具参数完整且验证通过后才可派发；旧尝试迟到输出不能获得执行权；未决副作用先核对。

**验收：**扩展 `routing.test.mjs`、`live-models.test.mjs` 和真实 runtime 宿主测试；通过反例 3、4，并证明辅助调用、缓存用量、失败尝试和探测均计入预算，无合格备用时保存检查点并暂停。

**M2：Skill 与 MCP——R4、R5**

**目标：**形成真实安装 → 自动归组 → 编译候选 → 验证发布 → 按需激活 → 每次调用鉴权 → 更新/回滚的完整流程。

**文件与入口：**`src/capabilities.ts`、[skill-repository.ts:47](C:/Albert/project/pi861/extensions/pi861/src/live/skill-repository.ts:47)、`skills-host.ts`、`mcp.ts`、`operations.ts`；宿主 `/skills`、`/mcp` 和 `pi861_capabilities`。

当前安装命令要求人工 GROUP；[compilers.ts:47](C:/Albert/project/pi861/extensions/pi861/src/live/compilers.ts:47) 的 `chooseSkillGroup` 未接入。编译器输入没有批准的工具绑定。`skills-host.ts` 的工具注册名未包含 Skill 激活身份，元数据映射仅以 toolId 为键，需要处理多账户和重复绑定。

**契约依赖：**C1 授权，C2 激活生命周期，C3 辅助调用预算，C4 持久发布与回执，C5 完整工具身份，C7 验证证据和受控结果引用。

开发任务：

1. 从真实包归档正文、脚本、二进制资源和版本清单；处理硬链接、符号链接、路径穿越、大小上限和 Windows 空格路径。安装不执行来源脚本。
2. 接入全文自动归组与相关已安装 Skill 匹配；人工分组保留为覆盖项。通用 Debug 实质去重，专项差异表达为互斥分支或兼容补充。
3. 目录和搜索共用结构化能力记录；激活加载完整必要约束。原始描述从默认提示和推荐中隐藏，保留显式访问。
4. 编译输入携带经批准的完整工具绑定。候选、结构校验、行为测试、人工审核、发布分别记录；替换当前确认后直接返回 `passed:true` 的证据表达。
5. 实现更新、卸载、受影响重建、回滚和运行中版本固定。安全撤权立即作用于调用与结果读取。
6. 完整工具身份涵盖服务、账户、资源、schema 和激活上下文，防止同名接口、多个 Skill 共用工具时覆盖闭包或借用授权。
7. 评审并锁定 MCP 协议实现，优先采用经过核查的官方 SDK；在现有客户端边界内补齐握手、分页、通知、schema 变化、取消、重连、大小限制及超时。每次调用同时验证参数与权限。
8. 以稳定业务操作 ID、持久回执和提供方核对机制控制副作用。大结果保存受控引用，支持分页/字段读取，撤权后引用同步失效。
9. 明确可信本地模式与生产隔离模式；原始 Skill、Shell、脚本和额外扩展均受相同岗位边界约束。

**验收：**扩展 `capabilities.test.mjs`、`live-skills.test.mjs`、`live-mcp.test.mjs`、`live-operations.test.mjs`；通过反例 5、6，以及反例 4 的 MCP 副作用场景。浏览和激活期间业务写入次数必须为零。

**M3：记忆与 PostgreSQL——R6**

**目标：**形成单一权威、多维授权、自动恢复、持续采集和可重试提炼的记忆服务。

**文件与入口：**`src/memory.ts`、`src/postgres.ts`、`live/layered-memory.ts`、`live/store.ts`、两个现有 SQL 文件、PostgreSQL 示例；宿主记忆生命周期、`pi861_memory`、`/remember`、`/memory-forget`、`/memory-maintain`。

当前 [store.ts:83](C:/Albert/project/pi861/extensions/pi861/src/live/store.ts:83) 整体读取 runtime JSON 状态，与 `PostgresMemory` 的逐记录 SQL 模型并存。[layered-memory.ts:119](C:/Albert/project/pi861/extensions/pi861/src/live/layered-memory.ts:119) 只领取 queued 或过期 running，失败分支第 156 行写入 failed 后不会重新领取。

**契约依赖：**C1 可信 scope，C2 租约与恢复事件，C3 提炼预算，C4 事务/回执/outbox，C6 来源与读取模型，C7 受控证据引用。

开发任务：

1. 以现有 `memory-v1.sql` 的逐记录模型为起点演进权威记忆 schema，保留正文、来源、版本、撤回和回执语义；将投影、提炼任务和增量事件纳入同一提交协议。
2. `LayeredMemory` 演进为服务层，生产查询、分页和增量由数据库执行。runtime JSON 状态仅承担适合的控制状态，不继续作为另一套记忆权威。
3. 提供从旧 Local/Layered 状态及两套 PostgreSQL 数据的显式迁移：记录来源、检测冲突、验证数量与摘要、保留备份、支持恢复；不长期双写两套真相。
4. 用途、范围和 L0/L1/L2 深度独立建模；补齐用户、小组、Agent、任务及批准跨项目共享。启动、接手、换模型、压缩后和换节点时直接装配固定约束与工作状态；长期经验再按事件召回。
5. 工具回执及时采集。超大或敏感结果保存受控引用和必要状态，替换当前直接丢弃的路径。
6. 提炼使用持久任务、领取租约、失败分类、`nextAttemptAt`、退避和有限重试；耗尽后有人工处理入口。模型调用在事务外执行，提交时重新验证源版本、撤回状态和租约。
7. 区分用户表达、观察、推断和验证事件；字面引用只证明引用存在。补齐纠正、冲突、替代、适用版本、过期和删除行为。撤回传播到摘要、缓存、索引和待运行任务。
8. 只有集成验收事件才能将分支成果发布为项目已采用事实；经验生成 Skill 候选仍走 M2 的发布流程。
9. 外部 PostgreSQL 配置覆盖验证 TLS、CA、池、超时、迁移账号、运行账号、备份和恢复。多节点 Worker 通过可信服务访问授权范围，数据库凭据留在服务端。
10. 完成关键词基线及中文、代码符号、路径检索。pgvector 单列增强任务；交付时若实现，必须绑定模型/维度/版本及迁移策略；未实现则明确标注。
11. 自动召回、采集、提炼、主动工具分别可控。数据库不可用时，本地待同步记录保持未提交；关键检查点未可靠提交则暂停对应执行边界。

**验收：**扩展 `memory.test.mjs`、`live-memory.test.mjs`、`postgres.test.mjs` 和真实 `postgres.integration.mjs`；通过反例 7、8。额外验证摘要、计数、来源关系和证据引用均不泄漏未授权信息。

**M4：调度与 Goal 多节点——R3、R8**

**目标：**建立持续队列、滚动规划、全任务树容量管理、独立审核、受控集成和可恢复 Worker 服务。

**文件与入口：**`src/scheduler.ts`、`src/goal.ts`、`live/coordinator.ts`、`project-runner.ts`、`pi-rpc.ts`、`remote-worker.ts`、`workspace.ts`、`worker-guard.ts`；完整 runtime 的 `/goal`；新增可配置 Worker 服务启动入口。

已确认的关键缺口：

- [project-runner.ts:110](C:/Albert/project/pi861/extensions/pi861/src/live/project-runner.ts:110) 在无运行任务时退出。
- [coordinator.ts:50](C:/Albert/project/pi861/extensions/pi861/src/live/coordinator.ts:50) 有 append 方法，但未接滚动规划入口。
- `integrationTail` 仅在单个 Runner 实例内串行。
- [workspace.ts:26](C:/Albert/project/pi861/extensions/pi861/src/live/workspace.ts:26) 仅用 taskId/attempt 生成工作区身份。
- 完整 runtime 的 Goal 命令尚未提供旧基础入口已有的 edit/budget 行为。

**契约依赖：**C1–C7 全部；M1 提供受控规划/执行调用，M2 提供固定能力版本，M3 提供检查点与验收事实。

开发任务：

1. 分离 Goal、计划版本、持续小组、任务、尝试、产物和验收。计划未封口时允许空闲等待；真正完成按目标合同判定。
2. 增加持久唤醒机制：任务结束、验收、依赖解除、计划追加、节点恢复和人工解除阻塞均能重新派工。
3. 接入有授权和预算的滚动规划，支持低水位补充、任务调整、依赖环检查及计划版本冲突。
4. 全任务树统一容量和预算；规划、执行、审核、返工、集成及远程 Worker 都纳入计量。等待父任务可释放执行名额，但后代仍受总量约束。
5. 区分开发依赖与交付依赖；共享文件、端口、数据库和测试环境有资源预约或隔离。
6. 将独立审核、返工和集成变成受控任务。产物提交保持待验证；强依赖在对应验收条件满足后才解锁。审核积压产生背压。
7. 集成由单一有效执行者操作专用工作区，联合持久租约、代际号和工作区互斥保护。租约交接前确认旧 Git 进程已收敛，防止仅数据库拒绝旧回执而旧进程继续写工作区。
8. 集成失败保留现场，提供可追踪修复与重新验证入口；故障限制在对应集成流程，其他安全任务可继续验证或排队。
9. 工作区、远程请求、会话和产物统一纳入 goal/run/task/attempt 身份。恢复时拒绝旧节点迟到结果；安全任务从检查点恢复，未知副作用先核对。
10. 补齐 Worker 可启动服务、可信配置、认证、心跳/租约、容量通告、取消和收敛关闭。远程节点采用独立检出，以版本化任务协议及校验产物传递。
11. `/goal` 支持创建、状态、修改、暂停、恢复、取消/清除、预算和完成验收，并使用同一个项目队列。保留人工接受与自动验收的证据区别。
12. 明确隔离后端及凭据、网络、进程、文件限制；展示当前未满并发的具体原因。宿主关闭后的行为由部署模式决定，不能依赖扩展继续后台运行。

**验收：**扩展 `scheduler.test.mjs`、`goal.test.mjs`、`live-project.test.mjs`、`live-remote.test.mjs`、`live-guard.test.mjs`；通过反例 1、2、9。启动两个实际 Worker 进程，验证跨独立仓库传输、故障接管和重复命令防护。

**M5：搜索与验收——R7，并支撑 R1–R8**

**目标：**完成独立 Brave 搜索、受控网页读取及统一验收证据收集。

**文件与入口：**[search.ts:45](C:/Albert/project/pi861/extensions/pi861/src/search.ts:45)、`index.ts` 的搜索入口；新增网页读取服务、受控结果引用适配及验收脚本。保留 Pi 原生 grep/find/ls/read。

**契约依赖：**C1 岗位和出站授权，C2 取消，C3 请求额度，C7 来源、分页、缓存与证据。

开发任务：

1. 优先完成 Brave 的配置、命令、模型工具和错误链；抽象可替换后端接口，准确列出实际支持的供应商。
2. 搜索和网页读取每次重新验证权限及出站策略，结果包含来源 URL、访问时间、范围、缓存状态和截断/完整性。
3. 网页读取限制协议、主机和端口，逐次检查重定向及 DNS/IP；防护内网、元数据地址、IPv6 映射和 DNS 重绑定，避免检查地址与实际连接地址脱节。
4. 有界读取响应、解压结果和正文；支持超时、取消、受控引用、分页或按字段读取。内部 MCP 端点采用单独批准策略。
5. 无配置、无凭据和供应商故障时返回明确不可用状态；外部内容保持不可信数据属性。
6. 提供统一验收运行器，记录代码版本、命令、环境、测试结果和证据摘要；检查命令来自可信配置，实际运行于对应产物。
7. 提供默认关闭的真实模型、真实搜索和获准 MCP 验收脚本，列出凭据变量、预算、数据范围及清理步骤。

**验收：**扩展 `search.test.mjs`，新增网页读取及网络边界测试；完成无真实凭据的 HTTP fixture 验证，并参与反例 10。M5 编写验收脚本不等于获得独立审核资格。

---

**五、P3：集成、故障注入与十条反例**

优先逐条接通纵向流程，再运行完整组合：

```text
可信配置与身份
→ Goal / 计划
→ 预算与派工
→ 实际 Pi Worker
→ 模型路由 + Skill/MCP
→ 记忆与操作回执
→ 产物检查
→ 独立审核 / 返工
→ 受控集成
→ 目标验收与项目记忆发布
```

任务书第 9 节的十条反例按以下方式验收；表内新增测试名称为计划文件。

| 编号 | 必须验证的反例与断言 | 测试入口 | 责任与需求 |
|---|---|---|---|
| 1 | A/B 并行，记录 `A.accepted < C.started < B.finished`；队列空闲后追加任务，无需重新创建 Runner 即被唤醒。使用可控屏障验证顺序。 | `scheduler.test.mjs`、`live-project.test.mjs` | M4；R3 |
| 2 | A 提交产物但未验收时 C 不可领取；审核失败产生关联原尝试和证据的返工，验收前不发布完成事实。 | `live-project.test.mjs`；新增审核/返工集成测试 | M4、M3；R3、R6、R8 |
| 3 | failover/failback 四组合；连续探测与预算耗尽；首选变更；运行中关闭开关；取消与旧响应迟到。 | `routing.test.mjs`、`live-models.test.mjs`、`runtime-host.integration.mjs` | M1；R1、R2 |
| 4 | 在文本、工具参数中途、派发前、派发后及工具成功但回执丢失处断流；半截参数不执行，已成功操作不重复，未知结果进入核对。 | 新增流式故障测试；`live-operations.test.mjs`、`live-mcp.test.mjs`、真实宿主测试 | M1、M2、M4；R2、R5 |
| 5 | 实际安装两份通用 Debug 和一份专项 Skill；自动归组、去重、分支选择、更新和回滚；默认提示无原始描述，运行中版本固定。 | `live-skills.test.mjs`；新增 Skill 宿主集成测试 | M2；R4 |
| 6 | 未激活不暴露全量 MCP 工具；激活后只有必需项；撤权、跨账户、同名接口、多 Skill 重复绑定、schema 改变和隐藏名直调均受控。 | `live-mcp.test.mjs`、`live-skills.test.mjs`、宿主集成测试 | M2；R5 |
| 7 | 自动记录和提炼后，换会话/模型/节点恢复必要状态；私有内容不经摘要或检索泄漏；撤回后旧任务、缓存和索引不能复活内容。 | `live-memory.test.mjs`、`postgres.integration.mjs`、跨 Worker 测试 | M3、M1、M4；R6 |
| 8 | 提炼暂时失败后有限重试成功，耗尽后可人工处理；数据库提交回执丢失后以同一 requestId 确认，不重复提交；本地待同步不冒充共享提交。 | `postgres.test.mjs`、真实 PostgreSQL 故障注入测试 | M3；R6 |
| 9 | 重复 Goal 创建/恢复、进程重启、计划版本冲突、旧节点恢复时，只有一个有效协调者和集成执行者；无重复派工/集成。 | `live-project.test.mjs`、`live-remote.test.mjs`；新增 Goal 恢复集成测试 | M4；R3、R8 |
| 10 | 在临时真实 Git 仓库，从 `/goal` 经规划、两个实际 Pi Worker、Skill/MCP、记忆、检查、审核和受控集成完成任务；验证实际代码行为及集成提交。 | 新增 `goal-e2e.integration.mjs`，复用并扩展现有 fixtures | M1–M5；R1–R8 |

反例 10 中，模型使用本地确定性 provider；Pi 宿主、Worker 进程、Git 仓库、MCP 传输和临时 PostgreSQL 使用实际实现。报告明确标注这一组合，不将协议闭环作为真实模型质量验收。

附加集成要求：

- PostgreSQL 17 临时测试库：迁移升级、受限账号、并发版本冲突、跨 scope 拒绝、撤回、断连、提交确认、备份恢复。
- MCP：实际 stdio 子进程及本地 HTTP/SSE 服务，覆盖分页、通知、schema 漂移、取消和未知副作用。
- Linux 与 Windows：空间路径、路径大小写、链接、子进程终止及文件锁恢复。没有执行条件的系统标为未验证。
- 主进程、Worker、规划器和测试进程使用隔离环境与测试专用配置。
- 新增或修改的测试逐一运行；不直接运行全量 Vitest，不使用 `npm test` 作为入口。需要全仓非 e2e 回归时使用根 `./test.sh`。

**P3 退出条件：**十条反例全部执行并通过；四层检查在最终集成代码版本上重新通过；所有失败和恢复过程均可从日志、请求 ID、尝试身份及产物版本追踪。

---

**六、P4：文档定稿、独立审核与交付**

五份文档在 P1 建立，P2/P3 随实现更新，P4 按实际结果定稿：

| 文档 | 必须交付的内容 |
|---|---|
| `REQUIREMENTS.md` | R1–R8 及子条目；明确默认值、状态转换、继承、权限与故障行为；可选增强和未完成项单列 |
| `ACCEPTANCE_MATRIX.md` | 每条需求的入口、测试名、命令、代码 SHA、环境、证据链接和状态；十条反例逐项映射 |
| `ARCHITECTURE.md` | 五模块边界；唯一执行权、预算和存储权威；身份、数据所有权、生命周期、跨节点协议、隔离及恢复边界 |
| `CONFIGURATION.md` | 可验证 schema；配置优先级；模型/记忆开关；TLS/CA/角色；完整入口、Worker 启动和脱敏示例；升级、停机、恢复、回滚 |
| `HANDOFF.md` | 起始/最终 SHA、分支及工作区状态、未推送改动；完成/未完成/阻塞项；最短复现步骤及下一条操作 |

保留旧 `VERIFICATION.md` 的历史含义；新增验证记录绑定实际测试的代码 SHA。若最后仅修改文档，列明测试 SHA 与后续文档差异。

独立审核由未参与对应开发的子代理完成：

1. 按计划核对 R1–R8 和十条反例，检查实现、入口和证据是否一致。
2. 审查原测试删除/改写差异，确认安全不变量继续覆盖。
3. 从干净检出复现四层检查、临时 PostgreSQL、实际 MCP 和双 Worker 闭环。
4. 核对未决副作用、撤权、未知用量、旧租约、重复 Goal、迁移与回滚路径。
5. 审查依赖及许可证记录，区分原理借鉴、直接依赖和代码复制。新增外部依赖固定版本；涉及 undici 更新时先审阅目标版本发布说明。
6. 检查完整日志、退出码、通过/失败/跳过数量、运行环境、CI 链接和脱敏情况。

后续提交按通过验收的阶段组织，只暂存本次修改的显式路径，遵守锁文件与 hooks 规则。保留审查分支，由外部审核者决定合并；开发范围始终限定在功能分支及任务分支。

**最终交付门槛：**R1–R8 的可执行范围全部落到实际入口，十条反例和四层检查具有当前代码版本证据；真实服务验收单列。尚未获授权的真实模型、搜索或 MCP 验收标记为待授权，不计通过；任何其余未完成项均附具体阻断条件、已保存状态和可继续执行的下一步。
