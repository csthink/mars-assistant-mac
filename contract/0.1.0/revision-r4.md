# Runtime Contract v0 r4 阶段 2 同步修订

日期：2026-09-14。输入为 [Contract 0.1.0-draft.3](README.md)（schema.json SHA-256 `df7873fdaf5b3c77fc9aed7085b294bf61f445ec9ec92a0a7f26066c53ff91c6`）、[architecture r3 与 Contract draft.4 修订范围确认书](../assistant-hp-stage4-architecture-contract-revision-scope-20260914.md)第 3.2 节、[阶段 2 本地执行 r2](../assistant-hp-mvp-stage2-local-execution-20260912.md)“权限及执行配置”“两种执行端口与正式评审”“执行身份、单写者与恢复”，以及 [OD-156 核对报告](../od156-overall-review-20260914.md)差异 D-04 至 D-06 与 KB-195。Mars 按 OD-269 批准修订，授权在原目录以 0.1.0-draft.4 候选形式修订正文、schema 生成源、示例与本记录；不包含协议冻结、实际 Runtime、生产实现、跨仓修改或 spec 签署。draft.3 的静态校验报告副本见 [validation-draft3.json](../evidence/runtime-contract-draft4-20260914/validation-draft3.json)，四份生成物摘要见 [draft3-digests.txt](../evidence/runtime-contract-draft4-20260914/draft3-digests.txt)。

修订候选为 [Contract 0.1.0-draft.4](README.md)。下表记录每项条款的来源、schema 变化、正文位置和示例，不是实现验收。

| 条款 | 依据 | schema 变化 | 正文位置 | 示例 |
| --- | --- | --- | --- | --- |
| K-01 ExecutionProfile 扩展 | KB-195；阶段 2 r2“候选新增字段”表 execution profile 行 | `ExecutionProfile` 新增必填 `trustModel`（闭集，首期只有 `current-user`）、`purpose`（闭集 chat、widget-generation、coding-implementer、review）、`programIdentity {launcher, binaryDigest, version}`（新增 `ProgramIdentity`）、`nativeApprovalPolicy`（闭集 auto-deny、expected-range-gate、trusted-ui-prompt）、`configurationDigest`、`capabilities[]`、`limitations[]`；`ExecutionProfileRef` 不变 | 安装、身份与协商（profile 段） | `execution-profile-current-user-valid`、`execution-profile-unknown-trust-model-rejected`、`execution-profile-missing-program-identity-rejected`；R5 流程与 profile 关系示例的 offered 已迁移 |
| K-02 ExecutionStart 执行绑定 | KB-195；阶段 2 r2 ExecutionIntent.executionBinding / constraints 行 | `ExecutionStart` 新增必填 `executionBinding`（新增 `ExecutionBinding {profileDigest, agent, model, modelVendor, routeVendor, credentialRef, configurationRevision}`）与 `constraints[]`（新增 `ExecutionConstraint {kind, value, enforcer, guarantee}`，guarantee 闭集 interface-enforced、agent-declared，enforcer=agent 必为 agent-declared） | 方法及数据结构，`host.execution.start` 段 | `execution-start-binding-and-constraints-valid`、`execution-start-missing-binding-rejected`、`execution-start-agent-constraint-claimed-enforced-rejected`、`execution-start-os-enforced-guarantee-rejected`；关系正反例 `binding-consistent-valid`、`binding-profile-digest-mismatch-rejected`、`binding-model-mismatch-rejected`（validate.mjs 新增 `binding` 谓词） |
| K-03 PhysicalExecution 结果补齐 | KB-195；阶段 2 r2 Execution 结果行；r2/r3 真实批次的进程记录 | `PhysicalExecution` 新增必填 `requestIdentity {operationId, requestDigest, profileDigest}`、可空 `supervisor`（新增 `ProcessIdentity {pid, startTime, image}`）、`approvalDecisionRefs[]`、可空 `exit`（新增 `ProcessExit {code, signal, pipesClosed}`）、`observationCompleteness`（complete、partial、unknown）；completed 必有 exit；unknown 不得为 complete | 物理执行边界与 Host 不承诺项首段 | `physical-execution-completed-without-exit-rejected`、`physical-execution-unknown-complete-observation-rejected`、`physical-execution-missing-request-identity-rejected`；既有五个 PhysicalExecution 示例已迁移 |
| K-04 preflight 与两阶段启动 | KB-195；阶段 2 r2 两种执行端口表 preflight/start 行、启动次序 | 新增方法 `host.execution.preflight`（R→H，无操作身份；params 为 scope、profile、连接、绑定与约束，result 为 supported/unsupported、检查清单与 reason）；`PhysicalExecution.state` 新增 `reserved`，queued/reserved 下 actualBinding、accounting、exit 必为 null | 新增“执行预约、放行与共享观察记录”节；方法目录新增一行 | `execution-preflight-params-valid`、`execution-preflight-with-operation-identity-rejected`、`execution-preflight-unsupported-result-valid`、`physical-execution-reserved-valid`、`physical-execution-reserved-with-binding-rejected`；R3 流程在 start 前增加 preflight、start 后增加读到 reserved 的 `host.execution.get` |
| K-05 共享物理观察记录 | KB-195；阶段 2 r2“持久预约与物理观察” | 新增文档 schema `ExecutionRecord`（recordVersion、seq、executionRequestId、executionId、intent/profile 摘要、executionPort、bootId、uid、supervisor、target、processGroup、children、nativeSession、released、observedAt、cancelRequestedAt、exit、observationErrors、result）；target 为 null 时 released 必为 false 且 exit 为 null | “执行预约、放行与共享观察记录”节 | `execution-record-valid`、`execution-record-released-without-target-rejected`、`execution-record-missing-supervisor-rejected`、`execution-record-pid-only-target-rejected` |
| K-06 Reviewer Profile/Receipt 适用范围 | KB-195；阶段 2 r2 Reviewer Profile / Receipt 行 | `ProfileRequirement` 新增可选 `applicability`（新增 `ReviewerApplicability {executionPort, purpose, trustModel, profileDigest, configurationRevision, credentialRevision}`） | 安装、身份与协商（executionProfileRequirements 段） | `profile-requirement-review-applicability-valid`、`profile-requirement-applicability-unknown-trust-rejected` |
| K-07 permissionProfileDigest 与 LaunchAuthorization 语义 | D-06；OD-209；C-12 | 无字段变化；生成源注释改为受信任本地执行配置摘要 | 所有权与通用性；安装、身份与协商；方法及数据结构；升级与冻结中的“隔离”措辞 | 无新增 |
| K-08 方法目录与校验 | 本件 | `methods.json` 由生成源新增 `host.execution.preflight`；`validate.mjs` 候选标识改为 draft.4，文档列表与输入摘要加入本记录，新增 `binding` 关系谓词 | README 方法目录与配套链接 | 方法目录计数由校验器按行数核对 |

## 生成、校验与示例迁移

`schema-source.py` 的 `VERSION` 改为 `0.1.0-draft.4`，`Context.protocolVersion` 与 `Manifest.manifestVersion` 随之只接受该值；schema.json 与 methods.json 由生成源重新生成（定义 100 → 110，方法 27 → 28）。examples.json 与 interaction-examples.json 的迁移由一次性脚本完成：43 处协议版本值改为 draft.4；5 个 ExecutionProfile 对象补 K-01 字段；12 个 ExecutionStart 形态对象补 `executionBinding` 与 `constraints`（agent、厂商与凭据引用按 connectionRef 推导，路径约束取自 targetBinding，工具约束标为 agent-declared）；5 个 PhysicalExecution 对象补 K-03 字段；R3 流程 `host.execution.start` 的 requestDigest 按 RFC 8785 规范化重新计算（`834b3fa3…` → `fd674a1e…`），引用该摘要的 profile 与 capture 关系示例同步更新；capability 的 `version` 字段是能力身份，保持 `0.1.0-draft.2` 不动。新增 21 个结构正反例与 3 个关系正反例见上表；R3 流程新增 2 次交换。校验入口不变：`python3 -B docs/design/runtime-contract-v0/schema-source.py --check` 与 `node docs/design/runtime-contract-v0/validate.mjs --write-report`。

## 对 draft.3 帧的兼容性

| 变化 | 对 draft.3 记录的解释 |
| --- | --- |
| `Context.protocolVersion` 只接受 draft.4 | 不兼容：draft.3 帧不能按 draft.4 校验。阶段 3 实验没有 draft.3 帧记录，E-06 r1 至 r3 的帧继续按 draft.2 解释，见 [r3 修订记录](revision-r3.md) |
| `ExecutionProfile` 新增必填字段 | 不兼容：draft.3 的 profile 目录缺 trustModel、purpose、programIdentity、nativeApprovalPolicy、configurationDigest、capabilities、limitations；E-06 冻结候选中的 launcher 路径、摘要、版本、批准参数与配置摘要是这些字段的来源，位于候选文件而非 profile 对象 |
| `ExecutionStart` 新增必填 `executionBinding`、`constraints` | 不兼容：draft.3 的执行请求缺两字段；E-06 r2/r3 的冻结 argv、模型映射与 `ApprovalGate` 期望范围是其来源 |
| `PhysicalExecution` 新增必填 `requestIdentity`、`observationCompleteness` 与可空 `supervisor`、`exit`，新增 `approvalDecisionRefs`，`state` 新增 `reserved` | 需迁移：draft.3 报告缺这些字段；E-06 r2/r3 的 Host 进程记录（exitCode、signal、waited、pidGoneAfterExit、PID）与端口关闭记录已含同样内容 |
| 新增 `host.execution.preflight` 与 `ExecutionRecord` | 新增：draft.3 没有对应消息或文档；E-06 中 `verify_lab.py check` 一类启动前检查与 Host 进程记录是它们的实验形态，不是协议帧 |
| `ProfileRequirement.applicability` | 兼容：可选字段，不出现即按 draft.3 语义，评审资格仍由 hp 判定 |

实验证据不因本修订改写；重跑 E-06 程序不是本修订的一部分。

## 校验边界

[validate.mjs](validate.mjs) 校验结构、方法参数/结果、样例请求摘要、固定关系正反例、文档链接和签署输入摘要；`binding` 谓词只比较示例内字段相等，不证明 Host 真的核对了实际程序。关系谓词不实现 Runtime，不证明身份认证、授权有效期、写者锁、持久化、放行阻塞、实际时序或完整 RFC 8785 符合性。具体结果和输入摘要见 [validation.json](validation.json)。所有跨语言、操作系统、生产 Host 和 HarnessPlane gate 保持 NOT RUN；协议冻结保持 NOT APPROVED；draft.4 是候选，冻结与 OD-156 闭合另行批准。监督程序的启动阻塞与放行、ExecutionRecord 的独占创建与原子替换均为待验证实现。

## 基线更新（OD-272，同日）

spec 0.4 r1 DRAFT 在 seal `8765b34fd817954f36cc99e031957716000c367d` 落入 `docs/spec.md` 后，`validate.mjs` 的 `product-input-unchanged-*` 检查基线由 `adce8b5acdbdd7c53913679645b479901bd5b81e` 改为该 seal：检查名与语义不变（Contract 候选所对照的产品输入被固定），`validation.json` 的 `baseline` 字段随之更新并重跑 `--write-report`；proposal 与 prototype 自 `adce8b5` 起未改，签署输入摘要检查（signoff.json 指向 archive 副本）不受影响。0.4 只把 draft.3/draft.4 已吸收的条款写回规格，没有新增 Contract 字段或消息；draft.4 不因此变为 draft.5。0.4 的签署另行决定。

## 基线更新 2（OD-273，同日）

spec 0.4 r1 于 seal `380a3415a116d606e57818557066034993dff753` 签署（状态行与“0.4 修订与签署记录”节变化，条款不变）后，`validate.mjs` 的产品输入基线由 `8765b34fd817954f36cc99e031957716000c367d` 改为该签署 seal，签署输入摘要检查改读 `docs/design/evidence/spec-v04-signoff-20260914/signoff.json`（四个检查键不变：signed_spec 指向 `docs/archive/spec.v0.4.reviewed.md`，architecture_context 指向 `docs/archive/architecture.v0.3-r3.spec-v0.4-context.md`，proposal_context 与 prototype_acceptance 沿用 0.3 记录的文件）。`validation.json` 重跑；检查语义不变，Contract 仍为 draft.4 候选，未冻结。

## 承诺文字（OD-274，同日）

Mars 选择对 KB-137 采用“修订承诺”而非断电补证，并确认下列文字：已接受操作在进程中断与操作系统正常运行下可见且可恢复；设备断电后最后一批已接受操作可能丢失，丢失的操作由恢复流程按 unknown 处理，发起方以原操作身份与幂等键重新提交，不重复生效、不伪装成功；断电耐久不作为首期承诺，补证保留为后续项。 已写入 README“物理执行边界与 Host 不承诺项”第三段与验证方案“冻结与集成验收条件”；spec 下一版 DATA-03 的候选文字登记在[差异清单](../assistant-hp-stage4/spec-architecture-diff.md)第 1 节，spec 0.4 r1 签署字节不改。依据：E-02 只证明进程中断后的可见性与可恢复性；本机 Git 2.50.1 文档对 `core.fsyncMethod=fsync` 只写“fsync() 系统调用或平台等价物”，未做源码级 F_FULLFSYNC 确认；E-02 探针对状态文件使用 Python `os.fsync()`，macOS 上不强制刷写磁盘缓存。schema 与方法不变，仍为 draft.4。
