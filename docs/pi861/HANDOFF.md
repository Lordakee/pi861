# Pi861 交接说明（HANDOFF）

- 首版日期：2026-09-22（P1 阶段交付；本版为 P4 定稿全量重写）。
- 本轮开发基线：起始 `d28044896`（P0 复核后文档重绑）→ 最终 `a667d206dabf5e99df742bc594a3ac16361d4a54`（merge: P3 反例测试），共 34 个提交（`git log --oneline --reverse d28044896..a667d206d`）。

## 1. 分支与推送状态（@ 定稿时）

| 分支/远端 | 指向 | 状态 |
| --- | --- | --- |
| `pi861-p2-integration`（当前分支，HEAD） | `a667d206d` | 本地领先 origin 4 个提交（`65084e069`/`d2bff94d4`/`612facfe4`/`a667d206d`），**未推送** |
| `pi861-p3-ax` | `612facfe4` | P3 反例测试任务分支，已并入 `a667d206d` |
| `feat/pi861-runtime-v1`（本地与 origin 同指） | `542feb6f6` | 已推送；CI run [36317857198](https://github.com/Lordakee/pi861/actions/runs/36317857198) **5 job 全绿**（deterministic / postgres / repository-check / pi-host / pi-host-source） |
| `origin/pi861-p2-integration` | `542feb6f6` | 与 origin/feat/pi861-runtime-v1 同指；待快进/推送到 `a667d206d` |
| `main`（origin） | `a621f8582` | 本轮全部工作与 main 隔离，未合并（遵守任务书边界） |

## 2. 完成清单（按模块，提交可追溯）

| 模块 | 交付提交 | 审核修复/验收 |
| --- | --- | --- |
| M1 模型可靠性（aux 统一恢复/计量、三段截止、增量缓冲、共享健康域） | `42d0fc580` | 审核 `0566a2d8e`（m1rev-F001/F004）、merge `8e73af6a4` |
| M2 Skill 与 MCP（自动归组、真工具绑定、发布证据四分类、部署边界、自研 MCP 客户端） | `3f32cf25b` | 审核 `3752b2b6c`（R5.5 双资源/共享绑定、有界重连） |
| M3 记忆与 PostgreSQL（提炼恢复/死信、受控引用、权威统一、显式迁移、outbox、缓冲队列） | `2b8b2cd39` | 审核 `fec2f3609`（串行 flush、死信队列、reconcile） |
| M4 调度与 Goal（持久唤醒、集成租约、工作区身份、worker-service 部署入口、复审池） | `74ef9b4ee` | 审核 `385ce83c1`（m4rev-F001/F002/F004）、双 Worker 验收 `8c8953088`、merge `5e2982d8b` |
| M5 搜索与验收（有界网页读取、SSRF/重定向/重绑防护、受控分页、provider 接缝） | `1303783ea` | 审核 `bf221703e`（线性提取、teredo、默认端口）、merge `d45b981b4` |
| 统一接线（M1-M5 服务接入 runtime.ts/index.ts） | `31a56510e` | CI 源码宿主 job `19b2dd709`、清理健壮性 `4edc8b6d5` |
| 接线复审（wire review） | `96f8d1375` | F001 主路径预留盐防跨实例重放；F002 路由证据进分类器提示词 + pi861_model_route 可选 phase/verificationPassed 透传（含宿主集成断言）；F003 active goal 孤儿 resume 容错；F005 受控引用过期先修剪；F006 /memory-maintain pending/abandon |
| 上游测试适配（CI 回绿基线） | `91eace93f`/`0d5011d33`/`bf89e07ff`/`542feb6f6` | 模型目录漂移与慢冷服务器适配；@ `542feb6f6` CI 5 job 全绿 |
| 缺口修复 | `65084e069` | R6.3 宿主触发映射（session_resume/node_change+负例）；R6.7 受控结果 owner 建模+撤权即拒；R4.7 安装侧硬链接拒绝 |
| G6 根检查收口 | `d2bff94d4` | 根 tsconfig/biome 纳入 pi861（runtime.ts 仍归 tsconfig.host.json）；`npm run check` 全链绿 |
| P3 反例测试（AX4/AX5/AX10） | `612facfe4`、merge `a667d206d` | AX4 断流五位置受控矩阵；AX5 宿主级 Skill 生命周期（含回滚栅栏缺陷记录）；AX10 goal 端到端 |
| 文档台账 | `8ed755104`/`021e5be99`/`cb07929d6` + 本版 P4 | 验收矩阵两次重绑 + 配置同步 + 本次定稿 |

台账状态：[ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md) 绑定 `a667d206d`，109 条中受控协议验证通过 94 / 真实服务已验证 1（PostgreSQL 临时库 CI 绿）/ 已接入 9 / 仅内核 2 / 未实现 3。

## 3. 验证基线（四层，本地实测 @ a667d206d，Linux/Node 24）

| 层 | 命令（cwd=extensions/pi861） | 结果 |
| --- | --- | --- |
| L1 扩展独立 tsc | `node ../../node_modules/typescript/bin/tsc --noEmit --project tsconfig.json` | 0 错误 |
| L2 确定性测试 | `node --experimental-strip-types --test test/*.test.mjs` | **251/251**（spawn 密集的 live-remote 双 Worker 用例满负载首轮偶发超时，重跑即绿） |
| L3 宿主类型 | 安装 `@earendil-works/pi-coding-agent@0.86.1 typescript@5.9.3 @types/node@22.19.19` 到独立目录并符号链接为 `node_modules` 后 `node <该目录>/typescript/bin/tsc --project tsconfig.host.json --typeRoots <该目录>/node_modules/@types` | 0 错误 |
| L4 发布宿主集成 | `PI861_TEST_PI_CLI=<已发布 0.86.1>/dist/bundle/cli.js node --experimental-strip-types --test test/pi-host.integration.mjs test/runtime-host.integration.mjs test/skills-host.integration.mjs` | **3/3** |
| AX10 goal e2e | 同上宿主 + `test/goal-e2e.integration.mjs` | 两连跑绿（未入 CI 清单） |
| 根检查 | 仓库根 `npm run check` | 退出 0（含 pi861，自 `d2bff94d4`） |
| 源码宿主 tsgo | `../../node_modules/.bin/tsgo --project tsconfig.host-source.json` | 退出 0 |
| CI（远端） | run [36317857198](https://github.com/Lordakee/pi861/actions/runs/36317857198) @ `542feb6f6` | 5 job 全绿；`a667d206d` 的 4 个新提交待推送后验证 |

## 4. 最短复现步骤

```sh
npm ci --ignore-scripts                 # 仓库根
npm --prefix packages/ai run generate-models   # 生成 provider catalog（根检查与源码宿主必需）
# L1/L2：
cd extensions/pi861 && node ../../node_modules/typescript/bin/tsc --noEmit --project tsconfig.json
node --experimental-strip-types --test test/*.test.mjs
# L3/L4：先按 CI 方式安装隔离宿主（@earendil-works/pi-coding-agent@0.86.1 + typescript@5.9.3 + @types/node@22.19.19），
# 符号链接为 extensions/pi861/node_modules，再：
node <宿主目录>/node_modules/typescript/bin/tsc --project tsconfig.host.json --typeRoots <宿主目录>/node_modules/@types
PI861_TEST_PI_CLI=<宿主目录>/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  node --experimental-strip-types --test test/pi-host.integration.mjs test/runtime-host.integration.mjs test/skills-host.integration.mjs
```

SQL 集成（可选，同 CI postgres job）：`PI861_ALLOW_TEST_DATABASE=1` + `PI861_TEST_POSTGRES_URL`（仅 loopback pi861_test 库）+ `PI861_TEST_DRIVER_ROOT`，跑 `test/postgres.integration.mjs`。全仓非 e2e 测试用根目录 `./test.sh`（勿直接跑全量 vitest：含 e2e，且本机 4 vCPU 并行会饿死 spawn 密集用例）。

## 5. 待授权清单（单列，不与受控证据混淆）

| 项 | 现状 |
| --- | --- |
| 真实付费模型验收 | 未执行；全部模型路径为确定性本地 provider fixture（含 AX10），真实用量归因/接管仅 fixture 验证 |
| 真实搜索后端 | 未执行；Brave 仅 HTTP fixture，无真实密钥联网验证 |
| 跨主机多节点 | 未执行；双 Worker/远程服务为 loopback HTTP fixture |
| 真实业务数据库 | postgres 新路径 CI 已绿（真实临时 PostgreSQL 18 + 受限角色，run 36317857198），真实业务库未触 |

## 6. 未实现 / 已知缺陷清单

| 项 | 说明 |
| --- | --- |
| R3.8 OS 沙箱声明式边界 | 未实现：隔离后端（凭据/网络/进程限制）不存在；文件级 worker-guard 已显式声明不称 OS 沙箱 |
| AX5 回滚栅栏缺失 | SkillCatalog.activate 可解析任意归档版本：回滚后新激活已撤销 revision 仍被允许；翻转条件见 `test/skills-host.integration.mjs` 末段 Defect record 注释，待后续修复 |
| planner 按会话计量 | 外部 planner 会话按会话粒度记 1 次 unknown 用量（R1.9 备注，wire-rev-F004），按轮计量为后续增强 |
| tui ES2024 既有失败 | `tsconfig.host-source.json` 无法用 tsc 5.9.3 检查：上游 `packages/tui/src/utils.ts` 的 `v` 正则 flag 需 ES2024 target（TS1501，非 pi861 引入）；tsgo 为权威门（CI 与本地均绿，workflow 注释已载） |
| O1 pgvector | 未实现且无装饰性开关；检索为词法/PG 全文基线 |
| O3 多搜索后端 | SearchProvider 接缝已建，仅 "brave" 实现 |
| R6.14 运维流程 | 备份/恢复未自动化、凭据委派服务未实现（仅内核） |
| 其余受控内缺口 | R2.10 真流式（仍缓冲派发）、R1.1 策略逐层接线（内核能力已测，runtime 未暴露分层）、R6.17 "关键检查点未提交暂停执行边界"未接线、R5.6 官方 MCP SDK 评审未做、R6.16 中文/代码符号检索专项未补 |

## 7. 下一条操作建议

1. **推送 `a667d206d`**（快进 `origin/pi861-p2-integration` 与 `feat/pi861-runtime-v1`）以获得最后 4 个提交的 CI 覆盖；建议同时把 `skills-host.integration.mjs` 与 `goal-e2e.integration.mjs` 纳入 CI pi-host job 清单（当前 CI 只跑前两个宿主集成）。
2. 修复 AX5 回滚栅栏（`SkillCatalog.activate` 拒绝已撤销 revision）并翻转 `skills-host.integration.mjs` 末段断言。
3. P4 独立审核（未参与开发的子代理）按 [ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md) 逐行抽验后，再考虑真实模型/搜索/多节点授权项与 pgvector、R3.8 沙箱等增强。

## 8. 台账使用约定（沿用）

- 每次状态变更必须绑定新代码 SHA、更新 [ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md) 对应行、必要时同步 [REQUIREMENTS.md](REQUIREMENTS.md)（不得降低范围）。
- 未跑与 skip 不计通过；fixture 只证协议与安全，不证真实模型任务质量。
- 历史报告 [VERIFICATION.md](VERIFICATION.md) 保留为历史证据（绑定 90295c195 及更早），不作为当前 HEAD 通过证明。
