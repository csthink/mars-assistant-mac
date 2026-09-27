# Runtime Contract v0 r3 条款整理修订

日期：2026-09-14。输入为 [Contract 0.1.0-draft.2](README.md)（schema.json SHA-256 `06a67c0e79837fb7752529aa1eb5b8462b5a1edd7b6cbe2ce72493e045c0e6fd`）、[阶段 4 条款整理范围确认书](../assistant-hp-stage4-clause-consolidation-scope-20260914.md)第 4.1 节，以及阶段 3 的实验证据。Mars 按 OD-265 批准整理，授权在原目录以 0.1.0-draft.3 候选形式修订正文、schema 生成源、示例与本记录；不包含协议冻结、实际 Runtime、生产实现、跨仓修改或 spec 签署。draft.2 的三份生成物摘要保留在各实验的固定输入记录中，本目录不再保存 draft.2 副本；draft.2 的静态校验报告副本见 [validation-draft2.json](../evidence/runtime-contract-draft3-20260914/validation-draft2.json)。

修订候选为 [Contract 0.1.0-draft.3](README.md)。下表记录每项条款的来源、schema 变化、正文位置和示例，不是实现验收。

| 条款 | 依据 | schema 变化 | 正文位置 | 示例 |
| --- | --- | --- | --- | --- |
| C-01 领域关联 | KB-128、KB-184；E-06 r1 至 r3 中 Host 只能从 host.context.capture 复制的“执行简报”定位 Task worktree | `ExecutionStart` 新增必填 `domainNodeRef`、`roleIntent`，可空 `targetBinding {resourceHandle, relativePath}`；新增 `TargetBinding`、`RELATIVE_PATH` 模式（无前导斜杠、无 `.`/`..` 段） | 方法及数据结构，`host.execution.start` 段 | `execution-start-domain-binding-valid`、`execution-start-missing-role-rejected`、`execution-target-traversal-rejected`；R3 流程的执行请求已带新字段并重算 requestDigest |
| C-02 实际绑定 | KB-188；r2/r3 真实批次读回 `claude-opus-5[1m]` 与 `claude-opus-5` | `PhysicalExecution` 新增可空 `actualBinding {model, source, observedModels}`；模型标识用 `MODEL_TEXT`（1 至 256 字符原文）而非 ID 模式；`ExecutionStart.model` 保持请求值 | 同上；“厂商归属由领域按已登记映射判断” | `physical-execution-actual-binding-valid`、`physical-execution-empty-model-rejected` |
| C-03 订阅生命周期 | KB-185；E-06 r1 G7/G8 双投递 | `runtime.events.subscribe` 结果新增可空 `replacedSubscriptionId` | 快照、事件与竞争 | `subscribe-replaced-valid` |
| C-04 机械码 | E-06 r1 结果报告第 6 节 G3 | `Action` 新增 `disabledCode`（enabled=false 必为 ID，enabled=true 必为 null）；`Operation` 新增可空 `resultCode`（accepted/running 必为 null） | Projection、证据与合法操作；幂等、未知结果与取消 | `action-disabled-with-code-valid`、`action-disabled-without-code-rejected`、`action-enabled-with-code-rejected`、`operation-failed-with-result-code-valid`、`operation-accepted-with-result-code-rejected` |
| C-05 PendingItem 规则 | E-06 r1 第 6 节 G3、G7 | 无 | Projection 段 PendingItem 规则句 | 既有 `pending-valid`、`processed-history-valid` |
| C-06 graph/trace 字段 | E-06 r1 第 6 节 G2 | graph 节点可选 `kind`、边可选 `semantics`、trace 条目可选 `section` | Projection 段 View 规则 | `graph-kind-and-semantics-valid`、`trace-section-valid` |
| C-07 取消对应 | KB-183；E-06 r1 G5 | `PhysicalExecution` 新增可空 `stopReason` 闭集（cancelled、timeout、tool-call-budget、output-limit、signal），stopped 必填、queued/running/completed 必为 null | 幂等、未知结果与取消 | `physical-execution-stopped-timeout-valid`、`physical-execution-completed-with-stop-reason-rejected`、`physical-execution-stopped-without-reason-rejected` |
| C-08 对象级 revision | E-06 r1 第 6 节 G3 | 无 | 快照、事件与竞争首段 | 无新增 |
| C-09 新化身恢复 | E-06 r1 第 6 节 G5 | 无 | 幂等、未知结果与取消末段 | 无新增 |
| C-10 事后止损与核算 | KB-189；r2/r3 Host 进程记录、R2-01、R2-10 | `ExecutionStart.budget` 新增可选 `maxOutputBytes`、`cleanupSeconds`；`PhysicalExecution` 新增可空 `accounting {toolCalls, runSeconds, outputBytes, waited, pidGoneAfterExit}` | 物理执行边界与 Host 不承诺项 | `execution-start-domain-binding-valid`（预算）、`physical-execution-actual-binding-valid`（核算） |
| C-11 执行端口证据结构 | R2-07；KB-193 修正后的 r3 真实批次 | 无（由执行 profile 登记） | 物理执行边界与 Host 不承诺项第二段 | 无新增 |
| C-12 已知限制 | KB-189、KB-190、OD-209、KB-137 | 无 | 物理执行边界与 Host 不承诺项第三段 | 无新增 |

## 生成、校验与示例迁移

`schema-source.py` 的 `VERSION` 改为 `0.1.0-draft.3`，`Context.protocolVersion` 与 `Manifest.manifestVersion` 随之只接受该值；schema.json 与 methods.json 由生成源重新生成。examples.json 与 interaction-examples.json 中的协议版本值、Action 的 `disabledCode`、Operation 的 `resultCode`、ExecutionStart 的三个新字段由迁移脚本一次性补齐，R3 流程 `host.execution.start` 的 requestDigest 按 RFC 8785 规范化重新计算（`78d06205…` → `834b3fa3…`），引用该摘要的关系正反例同步更新；capability 的 `version` 字段是能力身份，保持 `0.1.0-draft.2` 不动。新增 16 个正反例见上表。校验入口不变：`python3 -B docs/design/runtime-contract-v0/schema-source.py --check` 与 `node docs/design/runtime-contract-v0/validate.mjs --write-report`；[validate.mjs](validate.mjs) 的候选标识改为 draft.3 并把本记录纳入链接与输入摘要检查。

## 对 draft.2 帧的兼容性

| 变化 | 对 draft.2 记录的解释 |
| --- | --- |
| `Context.protocolVersion` 只接受 draft.3 | 不兼容：draft.2 帧不能按 draft.3 校验；E-06 r1 至 r3 的 Contract 帧记录继续按其运行时固定的 draft.2 摘要解释，各实验的 `inputs.json`、候选与证据索引保留 draft.2 三份生成物的摘要 |
| `ExecutionStart` 新增必填字段 | 不兼容：draft.2 的执行请求缺 `domainNodeRef`、`roleIntent`、`targetBinding`；E-06 中相同信息位于 host.context.capture 复制的“执行简报”快照内，属数据而非字段 |
| `PhysicalExecution` 新增必填可空字段 | 需迁移：draft.2 报告缺 `actualBinding`、`stopReason`、`accounting`；E-06 r2/r3 的 Host 已在结果证据中记录同样内容（actualBinding、stopReason、toolCalls、waited、pidGoneAfterExit） |
| `Action.disabledCode`、`Operation.resultCode`、`subscribe.replacedSubscriptionId` | 需迁移：draft.2 记录缺字段；E-06 的 disabledReason 前缀（如 `CAPACITY_EXHAUSTED: …`）与失败 reason 前缀是这些码的来源 |
| graph/trace 可选字段、预算可选字段 | 兼容：不出现即按 draft.2 语义 |

实验证据不因本修订改写；重跑 E-06 程序不是本修订的一部分，`prepare_lab.py` 一类脚本钉住的 draft.2 摘要在重跑时会按设计停止。

## 校验边界

[validate.mjs](validate.mjs) 校验结构、方法参数/结果、样例请求摘要、固定关系正反例、文档链接和签署输入摘要；关系谓词只检查示例之间的已声明绑定，不实现 Runtime，不证明身份认证、授权有效期、写者锁、持久化、实际时序或完整 RFC 8785 符合性。具体结果和输入摘要见 [validation.json](validation.json)。所有跨语言、操作系统、生产 Host 和 HarnessPlane gate 保持 NOT RUN；协议冻结保持 NOT APPROVED；draft.3 是候选，冻结与 OD-156 核对另行批准。
