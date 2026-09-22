# Pi861 runtime — 0.1.0-alpha.1

首批实现，不是完整生产平台。计划位于 `docs/pi861/IMPLEMENTATION_PLAN.md`。
这一扩展不替换 Pi 默认工作流，不自动安装其他编排器，也不加载外部 Agent 产品。

## 当前交付边界

| 部分 | 状态 |
| --- | --- |
| `/goal` | 已实现 Pi 生命周期适配、次数限额、暂停/恢复/修改、证据报告、人工接受；通过模拟宿主测试及真实 Pi 0.86.1 无模型 RPC 加载/命令冒烟；真实模型目标推进仍未验证。 |
| 联网搜索 | 已实现 Brave HTTP 适配与命令，默认关闭；固定地址、超时、取消、大小限制、来源和截断信息。HTTP 用模拟响应测试，未使用真实 API Key。 |
| 自动记忆 | 已实现用户输入候选记录、关键词召回、手动确认/撤回、分层读取预算及分支恢复。尚无模型驱动的长期经验提炼、向量索引和自动摘要。 |
| PostgreSQL | SQL 迁移与事务适配已实现，支持外部连接池；事务契约及真实 PostgreSQL 17 集成测试通过。不是完整认证服务。 |
| 模型路由/故障恢复 | 可执行、已测试的选择策略、状态机和缓冲推理适配接口；尚未拦截 Pi 真实流式生成，也未连接健康探测定时器。 |
| 持续任务调度 | 可执行的单所有者任务图、租约、写入范围和完成驱动补位，支持注入真实 Worker；尚未提供跨节点网络服务或进程/工作区沙箱。 |
| Skill/MCP | 已实现原始归档、发布版本、分支条件、工具绑定与调用时授权检查的内核；尚未接入 Pi 默认 Skill 发现、LLM 整合器和真实 MCP 传输。 |

不要将后四项核心实现误读为启动扩展就自动具备完整多模型/多节点系统。

## 启动

有两个互斥的入口；同一宿主进程只能加载其中一个，重复加载会被拒绝并报错。

完整运行入口是 `runtime.ts`（也是本包清单 `pi.extensions` 指向的入口）。
它要求可信的绝对路径 JSON 配置，启动时按固定顺序初始化：
配置校验 → 身份与存储 → 预算/操作回执 → 模型服务 → 记忆与能力服务 → Goal/Worker → 会话恢复；
关闭时先停止派发并取消所属工作，等待受控收敛，最后关闭 MCP 客户端与数据库连接。

```sh
PI861_CONFIG=/absolute/path/to/pi861-config.json pi -e ./extensions/pi861/runtime.ts
```

`index.ts` 保留为基础组合入口，只增加目标、记忆和可选搜索工具，没有更改 Pi 默认工具集合：

```sh
pi -e ./extensions/pi861/index.ts
```

不要同时加载 `runtime.ts` 与 `index.ts`（或任何其他自动续跑 `/goal` 编排器）；
`installPi861` 会检测同一宿主上的第二次安装并使其加载失败，避免出现两套
`/goal`、自动续跑、记忆采集或模型控制器。

## 目标命令

```text
/goal 实现导出功能，提供测试证据，不部署
/goal status
/goal pause
/goal edit 实现导出功能，并增加权限检查
/goal budget 30
/goal resume
/goal accept
/goal clear
```

默认最多 20 次扩展派发。`budget` 是累计上限，修改或恢复不清空已使用次数。
这个上限不等于全部模型请求数/Token 预算：Pi 回合内部的工具循环和原生重试还未纳入全局计费层。

模型通过 `pi861_goal_report` 提交当前运行 token、进度、后续工作及证据引用。
提交完成只进入 `review`；`/goal accept` 是用户确认，不等于自动测试已经验证证据。
连续两次没有有效进度报告会暂停；文字变化本身仍不是强验证，次数上限是兜底。
用户输入会暂停自动推进；中止、报错、会话恢复不自动重新执行。
扩展依赖宿主运行，不是关闭 Pi 后继续执行的守护进程。

## 搜索

Linux/macOS：

```sh
export PI861_WEB_SEARCH_ENABLED=1
export BRAVE_SEARCH_API_KEY='<由环境或密钥管理器注入>'
pi -e ./extensions/pi861/index.ts
```

PowerShell：

```powershell
$env:PI861_WEB_SEARCH_ENABLED = '1'
$env:BRAVE_SEARCH_API_KEY = '<由环境或密钥管理器注入>'
pi -e ./extensions/pi861/index.ts
```

使用 `/web-search PostgreSQL row level security` 或模型工具 `pi861_web_search`。
查询会发送到 Brave；不要包含私有代码、凭据或未经授权的个人资料。
默认禁用；没有密钥时报错，不伪造结果。首版未实现网页全文读取与其他搜索供应商。
HTTP 参数按 Brave 官方接口编写：
https://api-dashboard.search.brave.com/app/documentation/web-search

## 记忆

- 默认自动记录用户输入为 `candidate`，不是自动确认事实。
- 自动召回为有界关键词基线，明确标为不可信历史数据；不把记忆当作新指令或授权。
- `pi861_memory` 支持 search/read/note；模型笔记保持候选状态。
- `/remember 内容` 显式保存用户确认的项目记忆。
- `/memory-forget <id>` 撤回记录；历史快照与备份可能保留，不等于物理清除。
- `PI861_AUTO_RECALL=0` / `PI861_AUTO_CAPTURE=0` 分别关闭自动召回和采集。
- `PI861_PROJECT_ID` 指定稳定项目身份；未设置时使用 cwd 哈希，只适合本地试验。
- `PI861_AGENT_ID` 指定主体标识；生产应由认证服务确定，不由模型填写。

**默认 LocalMemory 仅使用当前 Pi 会话分支的快照。** 可恢复同一会话，
不提供新会话/多节点全局共享。长会话快照数量和大小仍需后续增量存储改造。
跨会话共享应配置外部 PostgreSQL backend；断连时不会悄悄切成另一份本地权威库。

`abstract` / `overview` 首版为标记过的截取，不是 LLM 自动摘要。
`contextPack` 按 UTF-8 字节控制，不声称精确 Token 数。原文与来源仍可查询。
仅有启发式敏感内容过滤，不是完整秘密检测或防提示注入保证。
源标识应指向具体事件/条目；撤回会阻止相同文本和同一旧来源重新写入。
访问后端的身份由可信宿主提供；RLS 不意味着掌握数据库凭据的人不能更改会话设置。

## 外接 PostgreSQL

1. 在专用数据库或受控 schema 中，用迁移账户执行 `sql/memory-v1.sql`。
2. 为运行时使用非超级用户、非 BYPASSRLS 的账户；授予相关表必要的 SELECT/INSERT/UPDATE。
3. 将迁移权限与运行权限分离。不要把数据库连接串交给模型。
4. 在自己的组合扩展中创建连接池和 `PostgresMemory`，再调用 `installPi861`。

`examples/postgres-extension.mjs` 提供完整组合方式，需由宿主安装 `pg`，
CI 验证配方固定使用 `pg@8.16.3`，不自动修改根项目依赖。该例从自身位置导入本扩展，
迁移文件不由它自动执行。设置 `PI861_DATABASE_URL`、`PI861_TENANT_ID`、
`PI861_AGENT_ID`、`PI861_PROJECT_ID`，使用 `pi -e ./extensions/pi861/examples/postgres-extension.mjs`。
远程默认验证 TLS，可通过 `PI861_PG_CA_FILE` 配置信任 CA；仅显式启用的 loopback 连接可使用明文。

写入、版本、outbox 与提交回执使用同一事务；请求响应丢失后以同一 requestId 重试。
冲突不自动覆盖。RLS 默认拒绝缺少范围的查询，应用层也限制 tenant/scope。
outbox 已写入，但消费者/摘要/向量重建尚未实现；不要将排队事件当作索引更新完成。

## 开发和验证

不需要模型密钥即可运行确定性测试：

```sh
cd extensions/pi861
node --experimental-strip-types --test test/*.test.mjs
# 在完整根依赖已安装的环境：
../../node_modules/.bin/tsc --noEmit
```

SQL 集成测试是单独入口，默认跳过。它只接受 loopback 的 `pi861_test` 数据库，
在其中创建并清理随机命名的 schema 和受限角色；需要专门测试账户的建角色权限。
不要将生产数据库凭据用于测试。

```sh
PI861_ALLOW_TEST_DATABASE=1 \
PI861_TEST_POSTGRES_URL=postgresql://postgres:test-only@127.0.0.1:5432/pi861_test \
PI861_TEST_DRIVER_ROOT=/path/to/isolated-pg-install \
node --experimental-strip-types --test test/postgres.integration.mjs
```

已在 GitHub Actions 通过根 `npm run check`、真实 Pi 无模型冒烟与 PostgreSQL 集成，
并单独通过 97 项确定性测试和扩展类型检查。锁定的源码版本及测试范围见
[`验证报告`](../../docs/pi861/VERIFICATION.md)。这些检查不等于真实多模型/多节点业务验收。

全仓检查前需按原仓库生成模型目录类型：

```sh
npm ci --ignore-scripts
npm --prefix packages/ai run generate-models
npm run check
```

无模型 Pi 宿主冒烟可独立运行：

```sh
PI861_TEST_PI_CLI=/path/to/pi-coding-agent/dist/bundle/cli.js \
node --experimental-strip-types --test test/pi-host.integration.mjs
```

## 参考及许可

本批为独立编写的新代码，未复制 OpenViking、gbrain 或第三方编排插件源码。
借鉴项目的概念、接口边界与测试场景，不继承未验证的性能或安全承诺。
按仓库许可处理；后续引入外部代码另行核对锁定版本及许可证。
