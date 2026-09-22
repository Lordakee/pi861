# Pi861 交接说明（HANDOFF）

- 首版日期：2026-09-22（P1 阶段交付，随五份台账首版建立；后续每个阶段更新）。
- 代码基线：`e3f07a789b7648f26ec72ce65fa5856046dbd6d3`（分支 `feat/pi861-runtime-v1`，与 main `c7cdb460a` 隔离，未合并）。

## 1. 当前进度（截至本文写作时）

今日已完成：

1. **规则与任务书入库**：任务书落盘为 [HANDOFF_PROMPT_2026-09-22.md](HANDOFF_PROMPT_2026-09-22.md)，仓库级开发规则经 AGENTS.md 更新（当前为未提交的工作区改动，见第 2 节）。
2. **codex 开发计划生成**：[DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)（codex `gpt-6-astra`、read-only 沙箱、基于 e3f07a789 只读规划），确立 P0–P4 五阶段与 M1–M5 模块划分。
3. **P1 文档台账首版（本文所属交付）**：[REQUIREMENTS.md](REQUIREMENTS.md)（109 条编号需求）、[ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md)（需求×入口×测试×证据×状态，绑定 e3f07a789）、[ARCHITECTURE.md](ARCHITECTURE.md)、[CONFIGURATION.md](CONFIGURATION.md)、本文件。

进行中（并行子代理）：

- **P0：修复 runtime.ts 并恢复四层检查链**。目标：修复 `runtime.ts(212,307)` TS1005（memory.put 外层对象缺一闭合括号，经复核确认）及随后暴露的全部类型/API/运行问题；消除双重断言（`runtime.ts:92,305`）与检查盲区（`extensions/tsconfig.json` 不含 runtime.ts、根 tsconfig/biome 不含扩展目录）；恢复"根检查 / 扩展独立 tsc / 真实 Pi 类型 / 实际宿主测试"四层，并补源码宿主验证。**本文档批次未触碰 extensions/ 下任何文件。**

## 2. 工作区状态（本文写作时）

- 分支 `feat/pi861-runtime-v1`，HEAD `e3f07a789`。
- 工作区改动：`AGENTS.md` 已修改（未提交）；`docs/pi861/HANDOFF_PROMPT_2026-09-22.md`、`docs/pi861/DEVELOPMENT_PLAN.md` 未跟踪；本批次新增五份台账文档（REQUIREMENTS / ACCEPTANCE_MATRIX / ARCHITECTURE / CONFIGURATION / HANDOFF，均未提交）。
- **本批次遵守约束：未修改 extensions/、packages/、根配置与任何测试文件；未创建提交、未 push。**
- 无未推送的服务器端提交记录需要说明（文档均在工作区）。

## 3. 重现方式（当前版本可执行的检查）

环境：Node >=22.19.0；`npm ci --ignore-scripts`；全仓检查前需 `npm --prefix packages/ai run generate-models`。

| 层 | 命令（cwd） | 当前预期结果 @ e3f07a789 |
| --- | --- | --- |
| ① 根检查 | `npm run check`（仓库根） | 通过（CI repository-check 已证） |
| ② 扩展独立 tsc | `node ../../node_modules/typescript/bin/tsc --noEmit --project tsconfig.json`（extensions/pi861） | 通过（不含 runtime.ts——P0 将消除该盲区） |
| ③ 真实 Pi 类型 | `tsc --project tsconfig.host.json`（对照已发布 Pi 0.86.1） | **失败：runtime.ts(212,307) TS1005**（P0 修复中） |
| ④ 实际宿主测试 | `PI861_TEST_PI_CLI=… node --experimental-strip-types --test test/pi-host.integration.mjs test/runtime-host.integration.mjs` | 因 ③ 失败无法运行；不可计通过 |
| 确定性测试 | `node --experimental-strip-types --test test/*.test.mjs` | 通过（16 个 .test.mjs 文件约 123 用例，CI deterministic 已证） |
| SQL 集成 | 见 README（loopback pi861_test 专用变量） | 通过（CI postgres：真实 PostgreSQL 17） |

CI 基线 run：<https://github.com/wmqfl861/pi861/actions/runs/35687924923>（deterministic / postgres / repository-check 通过，pi-host 失败）。

## 4. 下一步（按 DEVELOPMENT_PLAN 顺序）

1. **P0 完成**（并行子代理）：修复合入后，更新 ACCEPTANCE_MATRIX 中被标"阻塞"的 6 条 P0 相关条目（G6、R1.2、R1.8、R2.7、R6.6、R8.6）与行号引用，重跑四层检查并记录新 SHA。
2. **P1 剩余**：落地共享契约 `src/contracts/`（C1–C7）；解除并行开发的共享文件冲突（runtime.ts/index.ts/compilers.ts/根配置/CI 归协调子代理；如拆 compilers.ts 先做纯移动）。
3. **P2 五模块纵向开发**（M1 模型可靠性 / M2 Skill 与 MCP / M3 记忆与 PostgreSQL / M4 调度与 Goal / M5 搜索与验收），优先消化 ACCEPTANCE_MATRIX 中的"未实现"19 条与"仅内核"23 条（即 M1–M5 工作清单输入）。
4. **P3 集成与十条反例**（AX1–AX10，当前 3 受控 / 4 仅内核 / 3 未实现）。
5. **P4 独立审核与文档定稿**（未参与开发的子代理复核）。

## 5. 阻断项

| 阻断 | 影响 | 解法 |
| --- | --- | --- |
| runtime.ts TS1005（212:307） | 完整入口不可运行；pi-host CI 失败；6 条需求端到端阻塞 | P0 修复（进行中） |
| 双重断言与检查盲区 | 类型安全证据不完整（G6） | P0：显式适配函数 + 覆盖表 |
| 真实模型/真实搜索/获准 MCP 验收未授权 | 相关条目只能停在"受控协议验证通过"，不得虚报 | 任务书规定：默认关闭的验收脚本 + 明确凭据变量/预算/清理，待用户授权后运行 |
| 跨主机多节点环境未具备 | R3.7 只到 loopback fixture | 需要独立检出/主机环境后执行 M4 验收 |
| Windows/Linux 差异覆盖不全 | 平台特定行为（路径大小写、文件锁恢复等）未验证 | P3 按具备执行条件的平台分别标注"未验证" |

## 6. 台账使用约定

- 每次状态变更必须：绑定新代码 SHA、更新 [ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md) 对应行、必要时同步 [REQUIREMENTS.md](REQUIREMENTS.md)（不得降低范围）。
- 未跑与 skip 不计通过；fixture 只证协议与安全，不证真实模型任务质量。
- 历史报告 [VERIFICATION.md](VERIFICATION.md) 保留为历史证据（绑定 90295c195 及更早），不作为当前 HEAD 通过证明。
