# Runtime Contract v0

候选：**0.1.0-draft.5，DRAFT，2026-09-15**。本文件是 Assistant 拥有的通用 Host Contract 候选；不是冻结版，也不是 HarnessPlane 已认可的领域 API。依据为 [spec 0.5 r1](../../spec.md)、[architecture 0.3 r4](../../architecture.md)（均已按 OD-294 签署）和[设计范围](design-review.md)；draft.3 按 OD-265 的阶段 4 条款整理把阶段 3 实验取得的十二项条款（C-01 至 C-12）写入候选，逐项依据与对 draft.2 帧的兼容性见[r3 修订记录](revision-r3.md)；draft.4 按 OD-269 把阶段 2 本地执行 r2 要求同步的 profile 字段、执行绑定、结果补齐、preflight 与预约/放行、共享观察记录及评审适用范围（K-01 至 K-08）写入候选，逐项依据与对 draft.3 帧的兼容性见[r4 修订记录](revision-r4.md)；draft.5 按 OD-295 把[修订候选登记](revision-candidates.md)的 RC-01 至 RC-11（升级恢复的释放修订、启动参数模板、协议发布 manifest 与 `contractDigest` 的定义、协商复核失败与平台不匹配的处理、发布记录 schema 的引用与一致性、失败与取消结果证据的返回、`retry-later` 恢复提示、tombstone 应答）写入候选，逐项依据与对 draft.4 帧的兼容性见[r5 修订记录](revision-r5.md)。文中的“必须/不得”描述候选协议的约束，不能作为实现已经符合的声明。

配套：[schema.json](schema.json)、[方法映射](methods.json)、[examples.json](examples.json)、[修订调用示例](interaction-examples.json)、[六项评审修订 r2](revision-r2.md)、[条款整理修订 r3](revision-r3.md)、[阶段 2 同步修订 r4](revision-r4.md)、[候选修订 r5](revision-r5.md)、[发布记录 schema 候选](release-record/README.md)、[验证方案](validation-plan.md)。schema 采用 JSON Schema draft-07；由 [schema-source.py](schema-source.py)生成，修改源文件后生成，不能手改输出。正文定义语义，schema 定义可校验的数据结构；二者冲突时拒绝候选冻结并修订，不由实现自行选一方。字段未列明不自动接受；领域数据只通过已协商的 Capability Contract schema 扩展。进度及待决事项只见 HANDOFF。

从仓库根目录执行 `python3 -B docs/design/runtime-contract-v0/schema-source.py --check` 核对生成一致性，执行 `node docs/design/runtime-contract-v0/validate.mjs` 做只读结构核对。需要记录新结果时加 `--write-report`，生成 validation.json；原失败报告必须先保留到独立证据位置，不覆盖失败。校验使用仓库已有 Ajv，不安装新依赖。该入口不运行真实 Runtime、模型或操作系统实验。

## 核心交互图

![Runtime Contract 双向交互](diagrams/contract-interactions.png)

[放大查看 HTML](diagrams/contract-interactions.html) · [矢量图](diagrams/contract-interactions.svg) · [draw.io 编辑文件，第 2 页](diagrams/runtime-architecture.drawio)。这是按职责组织的核心交互目录，不表示时间顺序或完整方法清单；普通应答、领域证据读取及停机升级细节以正文为准。整体组件与数据归属见[架构总览图](../../architecture.md#架构总览图)，图稿生成与检查见[图稿说明](diagrams/README.md)。

## 所有权与通用性

| 层 | 维护者 | 管理内容 |
| --- | --- | --- |
| Runtime Host Contract | Assistant | 安装身份、连接、协议选择、资源授权、物理执行、快照和事件容器、展示原语、操作结果、恢复和兼容规则 |
| Capability Contract | 明确登记的领域 owner，与 Assistant 共同核对外部表示 | 领域对象语义、输入输出 schema、允许的 action、领域前提、证据及符合性要求 |
| Runtime implementation | 对应 Runtime 仓库 | 语言、内部存储、事务、领域写者与恢复、实现模块及独立发布 |

Host 不根据 runtimeId 决定 workflow、Gate 或任务状态。领域对象使用不透明引用，Host 保存其来源和 projection；没有当前领域事实时不可用按钮不能被模型文字重新启用。官方来源不免除本地执行准入核对；首期在当前 macOS 账户信任边界内运行，操作系统级强隔离为后置项（OD-209）。Coding graph 与非 Coding list 必须经过相同连接、授权和恢复规则；非 Coding 示例不是知识库产品交付。

## 安装、身份与协商

Manifest 声明 `runtimeId`、`publisher`、`version`、包内入口、固定 argv、平台、协议候选集合、Capability 引用、权限 profile 及数据版本。禁止 shell 启动字符串、绝对入口、路径穿越、symlink、安装脚本和启动时下载依赖。实际解包还须核对重复路径、大小和摘要，schema 的字符串校验不能替代文件核验。Manifest 的 `platform` 或 `minimumOs` 与本机不匹配时在安装准入拒绝：不进入 staging 之后的步骤、不激活、不发出 `runtime.initialize`；安装记录的原因归 `UNSUPPORTED_VERSION`，目录项显示为不可用而不是可安装。`argv` 是启动参数模板：Host 只展开闭集占位符 `${runtimeRoot}`（每用户 Runtime 根，即共享安装根）、`${instanceDir}`（本实例运行目录）、`${contractDigest}`（协议发布 manifest 摘要）与 `${resourceHandle}`（Host 登记的不透明资源句柄），其余字节固定；连接参数只经该模板传给 Runtime 进程，不经环境变量或模板之外的追加参数。

发布记录在 bundle 外签名，绑定 archive SHA-256、manifest SHA-256、逐文件清单及发布者身份；archive 的自摘要不写进 archive 内的 manifest，避免循环。安装记录再绑定实际签名、执行配置摘要（`permissionProfileDigest`）和准入检查结果。协议发布 manifest（`contract-manifest.json`，由 `contract-manifest.py` 生成与核对）对规范内容文件的原字节逐项列摘要：正文、schema 生成源与输出、方法目录、`examples.json` 与 `interaction-examples.json` 两份规范示例、修订记录，以及作为独立文件维护的[发布记录 schema 候选](release-record/README.md)；manifest 自身、`fixtures/` 下的证据 transcript 及其冻结副本、验证方案不在被散列列表中。manifest 原字节的 SHA-256 为 `contractDigest`；`Context.contractDigest` 与 `Protocol.contractDigest` 必须等于该值。历史 transcript 中以 schema.json 单文件摘要或含验证方案的 manifest 摘要记录的值按 fixtures 索引的说明保留，不改写。发布记录与 Manifest 的同名字段 `runtimeId`、`version`、`platform`、`dataFormat`、`permissionProfileDigest` 必须逐项相等，`dependencies` 集合相等；任一不等在安装准入拒绝并以 `INTEGRITY_MISMATCH` 记录原因。本草案的示例摘要仅为合成值，不是可安装发布记录。

| 身份 | 分配者及寿命 |
| --- | --- |
| installationId | Host；一次持久安装身份，更新保持身份但改变 bundleDigest |
| instanceId | Host；一个资源范围的持久实例（进程分离是身份边界，不是隔离保证），重启保持，重新创建不可复用旧 ID |
| incarnationId | Host supervisor；每次实际进程创建更新，防止 PID 复用 |
| connectionId | Host；每条管道更新，所有后续消息绑定此值 |
| controlGeneration | Runtime；取得本实例领域控制权时持久递增，所有变更在领域提交前重核；与独立 CLI 的写者机制共用，不靠 connectionId 代替 fencing |
| scopeRef | Runtime；实例内领域读取/操作范围，Host 将其绑定已登记的资源身份，实际访问另行授权；不是项目名称或目录路径 |
| streamId / epoch / seq | Runtime；scope 的持久投影流；seq 为无前导零十进制字符串，单调递增，epoch 在无法延续日志时更新 |
| operationId / idempotencyKey | 命令发起方；发送前持久化，一次语义请求固定，跨连接保持 |
| request id | 每次 RPC 发起方；Host 用 `h:`、Runtime 用 `r:` 前缀，重传可以不同，不是持久去重键 |

初始化由 Host 发出 `runtime.initialize`，传入身份、安装时实测的 bundleDigest、按优先级排列的精确协议及摘要、能力集合、`launchAuthorization`、Host 已验证的 `executionProfiles` 和限制。LaunchAuthorization 仅证明本次进程启动通过安装与本地执行准入检查（程序身份、依赖、能力报告、认证状态、活动 bundle 兼容性），绑定真实连接、安装、实例、bundle、执行配置摘要及有效期；不含 scope，不授予用户资源读写，也不表述为进程隔离已建立。Runtime 选择第一个完全一致的协议身份，返回能力交集和精确执行 profile 引用；Host 复核后调用 `runtime.ready`。复核发现 `selectedProtocol` 不在提供集合内、能力交集含未提供的能力或 required 能力不匹配、`executionProfiles` 含未提供的 profile 时，Host 不调用 `runtime.ready`，关闭连接，协议健康置 `incompatible`，连接记录的原因为 `INTEGRITY_MISMATCH`；不自动重试握手，不按 Runtime 的返回值修正自己的目录。

双方 required capability 必须有精确 `id + version + schemaDigest` 匹配；optional 不匹配则禁用该部分。Manifest 的 `executionProfileRequirements` 声明每个 capability 依赖的 profile 身份，依赖缺失时必需能力阻止 ready，可选能力从协商结果移除。Initialize 提供的 profile 目录仅包含 Host 已安装验证的策略，Initialized 选择其子集；不得选择未提供的 profile。`permissionProfileDigest` 是 Runtime 受信任本地执行配置的摘要，绑定准入检查所核对的启动配置原字节（入口、含闭集占位符的 argv 模板、环境允许列表、依赖清单）；占位符展开后的实际值写入 Host 的安装与启动记录以及 `ExecutionRecord`，不进入摘要；首期不表述为进程隔离配置，字段名与摘要绑定保留。execution profile 是 Agent 的工具、资源及预算策略，二者不互换。执行 profile 摘要绑定完整本地策略原字节（含 argv 模板、环境允许列表及间接访问限制），目录中的 operations 和上限只是公开摘要，不能代替策略核验。相同 id 不同 digest 不兼容；不下载远程策略或 schema。每个 profile 还声明 `trustModel`（闭集，首期只有 `current-user`，表示该用途在当前 macOS 账户内按受信任程序运行）、`purpose`（chat、widget-generation、coding-implementer、review 之一，受限用途有独立 profile 身份，Coding 组合通过不提升其他用途）、`programIdentity`（固定 launcher 路径、二进制摘要与版本，解释器启动器与最终映像分别固定）、`nativeApprovalPolicy`（auto-deny 表示非交互否决原生权限申请，expected-range-gate 表示执行端口按期望范围逐字段比较原生批准请求，trusted-ui-prompt 表示交给 Host 可信界面或 CLI 明确呈现；闭集中没有 bypass 或自动批准）、`configurationDigest`（非秘密有效配置摘要）以及已验证 `capabilities` 与已知 `limitations`。`trustModel=current-user` 不扩大任何 Grant，不把不承诺项写成能力。评审类 capability 在 `executionProfileRequirements` 中可附 `applicability`，写明评审端口（embedded、standalone、any）、用途、信任边界、profile 摘要、配置与凭据 revision 的适用范围；Host capability PASS 只证明协商通过，不赋予评审资格，评审资格由领域按这些字段与自身检查判定。

首次连接严格按以下顺序：Host 先以可信目录选择登记不透明 resourceHandle；完成 initialize/ready 后调用 `runtime.scope.open(binding)`。ScopeBinding 是 Host 在真实连接上出具的有限绑定声明，绑定 installation/instance/bundle、resourceHandle 和 expiresAt；只允许分配/查询身份，不允许读取目录、初始化治理或创建领域任务。Runtime 持久保存 bindingRef 到 scopeRef 的映射并返回 inactive；同一 bindingRef 重试返回同一 scopeRef，改变其资源身份则拒绝。随后 Host 才按该 scopeRef 建立 Grant，并发送 `runtime.scope.authorize`；Runtime 通过 `host.grants.get` 核对当前身份、范围、revision 和期限后返回 active。零初始 scope 和零资源 grant 均可 ready；inactive scope 不得读取资源、快照或提交 action。

`scope.authorize` 替换当前 scope 的授权引用集合，空集合使其 inactive；每次调用重新核对 Host 当前授权，不能用迟到请求恢复旧 revision。Grant 撤销立即阻止新访问，失联不延长有效期，不依赖 authorize 通知到达才撤权。协议 ready 前仅允许握手及监督；ready 后、scope active 前仅允许身份绑定、grant 查询、授权和实例监督/升级恢复。ready 不受其他 scope 缺权影响。授权 scope 不匹配必须失败；open/authorize 重试不产生领域业务副作用。重新连接重新协商，scope 身份保持但授权重核，失去权限不自动重放。

进程状态为 `starting/running/stopping/stopped/failed`；协议健康为 `initializing/ready/degraded/incompatible`；scope 新鲜度为 `syncing/current/stale/missing`，三个字段分别管理。`running` 不表示领域完成，`ready` 不表示所有 scope 都可写。心跳以 5 秒为实验间隔，连续 3 次无响应即 degraded；不由此更改领域终态。

## 传输与消息边界

v0 绑定为子进程 stdin/stdout 上的双向 JSON-RPC 2.0，UTF-8，每帧一个紧凑 JSON 对象并以 LF 结束；字符串换行必须转义。stdout 仅协议，stderr 为受限诊断。拒绝 BOM、无效 UTF-8、重复 JSON key、batch、顶层数组、NaN/Infinity 和非对象 params。普通 JSON-RPC 成功/错误响应互斥，保留标准错误码；本 profile 只接受字符串请求 id，解析失败响应 id 可为 null。

收取方按字节累积到 LF，未完成帧同样受上限约束；不先完整分配超大对象再检查。每连接使用有界发送队列，写入背压时暂停生产；事件不得丢弃后仍宣称连续。通知只有 `runtime.event`，不能用通知请求带副作用的命令。独立读取循环处理双向请求，等待对方响应时不能阻塞自身对 broker 请求的响应。

| 参数 | r2 实验值 | 超限与验证要求 |
| --- | --- | --- |
| 一帧（含 LF） | 1,048,576 bytes | 关闭协议连接，保留 scope stale 和未决操作；不截断后继续解析 |
| JSON 深度 / 每容器成员数 | 32 / 1,000 | schema 之前检查；超限拒绝，不执行任何 action |
| 每方向在途请求 / 写缓冲 | 32 / 4 MiB | 超限明确 `RESOURCE_LIMIT` 或暂停读取；保留控制请求处理能力 |
| 未确认事件窗口 | 最多 128 帧且 4 MiB | 达到任一限制暂停事件发送；不能挤掉取消、结果查询和健康响应 |
| 快照页对象 / 单文本字段 | 最多 100 / 65,536 字符 | 大内容使用 EvidenceRef 分块读取；不为显示截断而改变真实候选摘要 |
| 初始化 / 普通 RPC 应答 | 10 秒 / 10 秒 | 超时是 transport 结果未知；业务长操作须快速返回持久 accepted |

这些数值是设计验证 profile，须与 architecture Q-08 一起测量后才能冻结。双方只能选择共同支持且不超过 Host 限额的配置；控制帧和事件分开排队并公平调度，不在应用线程同步解析无界内容。诊断沿用既有 7 天/50 MiB 上限，禁止输出秘密、原文和授权 token。

## 方法及数据结构

除 initialize 外，params/result 和 event 都带 `Context`：精确协议版本、contractDigest、installationId、instanceId、incarnationId、connectionId、controlGeneration。controlGeneration 由 initialized 返回，Host 不能自行增加以夺取控制权；Runtime 无法取得合法控制权时拒绝 ready。接收方必须先验证真实管道的绑定，再匹配 Context；这些字符串不是身份认证凭据。查询也核对 scope 访问授权。下表是当前候选的方法完整目录（r2 建立，r3 未增，r4 新增 `host.execution.preflight`），参数、结果对象除显式可选项外均必填。

| 方法、方向 | Context 之外的参数 | 成功结果及含义 |
| --- | --- | --- |
| `runtime.initialize` H→R | `Initialize` | `Initialized`；只选择候选，尚未开放操作 |
| `runtime.ready` H→R | 无 | `ready: true`；接受本次协商 |
| `runtime.health` H→R | 无 | `health`、`reason`；仅协议健康 |
| `runtime.scope.open` H→R | `binding: ScopeBinding` | `scopeRef, bindingRef, state: inactive`；幂等绑定身份，无资源读写 |
| `runtime.scope.authorize` H→R | `scopeRef, grantRefs` | `scopeRef, state: active/inactive`；核对并替换授权集合 |
| `runtime.snapshot.open` H→R | `scopeRef` | `SnapshotPage`；一致快照首屏与事件水位 |
| `runtime.snapshot.next` H→R | `scopeRef, snapshotId, pageToken` | `SnapshotPage`；同一 revision、水位和读取资格 |
| `runtime.events.subscribe` H→R | `scopeRef, snapshotId, streamId, epoch, afterSeq` | `subscriptionId, replacedSubscriptionId`；从水位之后重放，响应后才发事件；同一连接同一 scope 只有一条活动订阅，新订阅替换并点名旧订阅 |
| `runtime.events.ack` H→R | `subscriptionId, streamId, epoch, seq` | `acknowledgedSeq`；只可确认已落盘且实际投递的连续水位 |
| `runtime.event` R→H | `Event`，无 RPC id | 无响应；至少一次投递，需业务确认水位 |
| `runtime.action.invoke` H→R | `Invoke` | `Operation`；持久接受不等于生效 |
| `runtime.operation.get` H→R | `scopeRef, operationId` | `Operation` 或 `NOT_FOUND/RESULT_UNKNOWN`；不产生外部影响 |
| `runtime.operation.cancel` H→R | `scopeRef, targetOperationId, operationId, idempotencyKey, requestDigest` | 新取消 `Operation`，目标结果另查询；不存在或无权限不创建取消 |
| `runtime.quiesce` H→R | 同取消操作身份字段，另有 `reason`，没有 targetOperationId/scopeRef | `Operation`；实例停止接受新 action，保留查询；不得自动取消领域工作 |
| `runtime.shutdown` H→R | 同 quiesce | `Operation`；持久保存完成后才允许进程退出，管道结束不证明领域成功 |
| `runtime.upgrade.prepare` H→R | `UpgradePrepare` | `UpgradeState`；原子建立领域屏障并检查全部保护引用 |
| `runtime.upgrade.get` H→R | `operationId` | `UpgradeState`；恢复原准备结果，不新建屏障；释放后携带 `releasedDomainRevision` |
| `runtime.upgrade.release` H→R | 操作身份、`prepareOperationId, barrierRef, disposition, runningBundleDigest, dataFormat` | `Operation`；核对激活或恢复事实后释放屏障 |
| `host.decision.get` R→H | `scopeRef, decisionRef` | `DecisionRecord`；只读查询可信人工记录及撤销状态 |
| `host.context.capture` R→H | `ContextCapture` | `ContextCaptureReceipt`；持久接受复制请求，成功才返回 Host 快照映射 |
| `host.context.get` R→H | `scopeRef, operationId` | `ContextCaptureReceipt`；应答丢失仍可查询原映射 |
| `host.grants.get` R→H | `grantRefs` | 当前 `Grant[]`；不授予权限、不返回秘密 |
| `host.resource.read` R→H | `ResourceRead` | `ResourceChunk`；每块重核范围及修订，结果摘要按全部字节核验 |
| `runtime.resource.read` H→R | `ResourceRead` | `ResourceChunk`；读取领域方持有的固定证据，不授权任意路径 |
| `host.execution.preflight` R→H | `scopeRef, profileId, profileDigest, connectionRef, configurationRevision, executionBinding, constraints` | `status: supported/unsupported, profileDigest, checks, reason`；无模型调用的静态与协议能力检查，不创建操作或执行，不构成评审资格 |
| `host.execution.start` R→H | `ExecutionStart` | `Operation` 与可查询物理 `executionRef`；accepted 加 executionRef 表示持久预约（`PhysicalExecution.state=reserved`），不包含目标已放行或领域完成 |
| `host.operation.get` R→H | `scopeRef, operationId` | 原执行启动或取消的 `Operation`；应答丢失时无需先知道 executionRef，即可查询接受事实与执行引用 |
| `host.execution.get` R→H | `scopeRef, executionRef` | `PhysicalExecution`；由 Host 原生身份和适配器报告 |
| `host.execution.cancel` R→H | 取消身份字段及 `executionRef, scopeRef` | 取消 `Operation`；物理终态另核实 |

scope 解析、表单 schema 和 action 类型须由所选 capability 注册。Host 的文件/网络/系统扩展以后只能通过带版本的 broker 方法添加；本 r2 直接 broker 提供授权/人工记录查询、固定证据上下文复制、资源只读和 Agent 物理执行，Runtime 自己的持久领域目录由已核验的本地执行配置允许写入，该允许在当前账户信任边界内成立。文件/命令/网络副作用由已授权 execution profile 承载，其允许范围不因本目录存在而自动实现。控件既有能力接口保持自身规格，不借本 r2 缩减。

`host.execution.start` 的 profile 由 Host 安装并验证，Runtime 只能选已协商 profile，传连接引用、精确模型、上下文句柄、预算和目标资源。Host 核对所属 scope、配置 revision、已授权的请求内容及领域操作关联，禁止自由 shell 字符串。执行请求还必须显式携带领域关联：`domainNodeRef` 指明该执行所属的领域节点，`roleIntent` 指明角色意图（闭集由 Capability Contract 登记，Host 不解释其领域含义），`targetBinding` 指明已登记资源句柄下的相对工作树（可为 null，表示该执行不写任何工作树）。Host 只在 `targetBinding` 内授予文件写入与提交，并从 Grant 核对该路径属于已授权资源；相对路径不得含前导斜杠或 `..` 段。contextRefs 只承载证据数据，Host 不得从中解析执行目标或指令。`ExecutionStart.model` 是请求值（可以是 `installation-default` 一类占位），实际绑定的模型由 `PhysicalExecution.actualBinding` 从工具自身协议输出读回（`source` 标明来自初始化帧、结果帧或适配器报告），标识按原文保存，不受 ID 模式约束；厂商归属由领域按已登记的映射数据判断，Host 不假定品牌与厂商的对应。执行请求还必须携带 `executionBinding`：完整 profile 摘要、Agent、模型、模型厂商、路由厂商（可为 null）、凭据来源引用和配置 revision；其中 profileDigest、model、configurationRevision 必须与请求顶层同名字段相等。Host 核对实际程序、模型与路由与绑定相符，不符即拒绝，不按工具返回文字修正选择；凭据引用是非秘密引用，不携带秘密值。`constraints[]` 逐条记录资源、工具、网络、路径与预算约束，每条写明 `enforcer`（host、runtime、agent）与 `guarantee`：`interface-enforced` 表示 Host 或 Runtime 在自身受控入口强制核验，`agent-declared` 表示只是向受信任 Agent 声明并由其按能力执行；由 agent 执行的约束只能是 agent-declared，闭集中没有操作系统强制值，Receipt 不得把声明约束标成 OS 强制。profile 变更必须重新协商；在途执行固定原策略，新策略不得替换其身份。实际 argv 和环境由适配器根据已核验 profile 生成；尚无有效 Coding profile 时拒绝，不能复用普通问答允许状态。Provider 原生会话身份只在该连接适配器内部保存，通过 executionRef 查询脱敏结果。

## 执行预约、放行与共享观察记录

`host.execution.preflight` 是无模型调用的静态与协议能力检查：Host 核对 profile 摘要、程序身份、当次帮助文本或协议能力中的参数存在与取值、原生认证状态（不读取秘密）、连接配置 revision 与绑定相符，返回 supported 或 unsupported 及逐项检查结果。它不创建操作或执行，没有操作身份，不构成评审资格；standalone 端口的 preflight 不能继承 Host 环境的通过证明。unsupported 的组合返回不支持，不静默换 Agent 或模型。

`host.execution.start` 是持久预约。领域方先在自己的正式记录内持久保存领域操作与一次执行预约（executionRequestId、intentDigest、profileDigest、资源与工作树身份、controlGeneration、原执行端、恢复定位），不提前记录进程已启动；相同请求 ID 不同摘要拒绝。Host 或 LocalExecutionPort 作为该请求唯一物理执行写者，按“预约已持久化 → 独占物理记录 → 创建尚未放行目标 → 记录真实身份 → 放行执行”推进：accepted 加 executionRef 只表示预约已被 Host 持久接受，此时 `PhysicalExecution.state=reserved`，`supervisor` 可以已有身份而 `actualBinding`、`accounting`、`exit` 必为 null；目标只有在真实身份写入共享观察记录后才放行进入 running。放行前失联不得让目标开始业务；启动或放行确认缺失时 `observationCompleteness` 保守记 partial 或 unknown，领域按 recovery-required 处理。监督程序与启动阻塞机制属于待验证实现，本节的次序不是已具备的原子启动。

`PhysicalExecution` 的 `requestIdentity` 绑定原操作身份、请求摘要与 profile 摘要；`supervisor` 是监督者的 PID、启动时间与实际可执行映像；`approvalDecisionRefs` 引用该执行内被 Host 或端口接受的原生批准决定；`exit` 记录退出码或信号与管道是否结束；`observationCompleteness` 说明 Host 对该执行的观察是否完整。运行成功、进程退出与领域接受是三个不同事实：completed 只表示 Host 观察到目标完成并取得退出事实，不表示候选被领域接受；退出码、管道结束、PID 消失分别记录，任一项单独不证明进程已退出。

共享物理观察记录 `ExecutionRecord` 保存在目标资源 Git common directory 下的 `harness/executions/<executionRequestId>/`，供两入口在原 Host 不在线时核对物理身份。路径由规范化的内部请求 ID 派生，不能由模型提供。执行端启动的监督程序是该目录从独占创建到退出的唯一写者，以 `seq` 递增、摘要与原子替换保存；Host 与 LocalExecutionPort 只写各自协调记录，领域方与另一入口只读。监督程序死亡后的新观察由领域恢复操作写入自己的正式记录并引用旧记录摘要，不冒充原监督者。记录包含请求与执行身份、intent 与 profile 摘要、执行端、boot 身份、UID、监督者与目标的 PID/启动时间/映像、进程组、登记子进程、原生 session/turn 引用、是否已放行、观察时间、取消请求时间、退出、观察错误与结果摘要及 locator；不保存 Task 状态、人工 Gate、凭据、提示词或完整输出，也不替代领域 ref 或 Host 结果存储。目录权限只防意外误操作，不防同账户恶意改写（OD-209）。记录缺失不能单独证明从未启动，须结合原执行端完整接纳索引与放行协议；同一 boot/PID 但启动时间或映像不符视为身份冲突，不对新进程发信号。

## Projection、证据与合法操作

Snapshot 由 `ProjectionObject[]`、`Action[]` 和 `PendingItem[]` 组成。每页 objects、actions、pendingItems 数量之和不得超过协商的 pageObjects；每个数组也受 schema 上限约束。每个对象绑定 scope、对象引用和领域 revision，展示字段不决定领域转换。View 的 kind 只允许 list、document、graph、diff、trace；相应数据按已登记 schema 校验。图仅支持节点、边与显示状态，不含脚本或可改 workflow 的回写指令；Runtime 不可覆盖可信工具栏。graph 节点可带可选 `kind`、边可带可选 `semantics`、trace 条目可带可选 `section`，供领域用机械可读值表达节点类别、分支语义与条目分组，不把这些含义编码进 label；`stateLabel` 的取值集合由 Capability 登记（例如 current、visited、not-visited、terminated-here、published），Host 只展示。

`PendingItem` 是领域方提供的通用待处理投影，身份为 `(installationId, instanceId, scopeRef, itemRef)`。包含目标 objectRef、revision、capability、标题、稳定 typeId/展示 typeLabel、pending/processed 状态、pendingSince、updatedAt、processedAt、blocking、actionIds 及当时证据。typeId 在 capability 身份内解释，不从标题或领域 stateLabel 推断；pending/processed 只表示待处理事项的生命周期，不统一领域工作流状态。领域以节点为单位产生待处理事项时，typeId 取该节点的稳定 id、typeLabel 取节点标签，pendingSince 为进入该节点的时刻，processed 由决定生效的时刻确定并连同证据保留在快照中。仅 Runtime 能确认 processed，必须带 processedAt 且 blocking=false；Host 已读、通知、发送请求和物理执行结束均不能产生该状态。

pendingSince 来自领域正本，刷新、重启和缓存重建不得重置；重新打开同一事项保持身份并由领域方明确给出新的 pendingSince。各入口使用同一 itemRef/actionId；项目关系由 Host 将 scope 绑定到组织记录，共享仓库的多项目不能重复计数。未筛选的授权 scope 集合提供全局待处理数及阻塞数，筛选只改变列表。等待时长按 pendingSince 排序，同时间用完整事项身份稳定排序；processed 历史按 processedAt 排序。缺失或 stale scope 的计数必须标记不完整，不把未知计为零。快照包含仍在领域保留期内的 processed 历史；pending.remove 仅用于领域确认的撤回或保留期退出，不能代替 processed 事件。删除缓存后按同一快照和连续事件重建这些字段，不把通知记录作为来源。

`Action` 包含 capability 身份、actionId、目标对象、expectedRevision、candidateRef、payloadSchemaDigest、可用状态、禁用原因（人读文本）、禁用码（`disabledCode`，enabled=false 时必填、由 Capability 登记闭集，例如 `CAPACITY_EXHAUSTED`）及是否要求人工决定。candidateRef 为 null 只表示该操作无候选；涉及冻结、保留、发布或合并时领域契约必须要求非空。UI 提交绑定用户实际看过的候选和证据，不以重读最新候选自动替换用户决定。

Invoke 包含 operationId、idempotencyKey、requestDigest、scopeRef、actionId、objectRef、expectedRevision、candidateRef、grantRefs、payload 及 `decisionRef`。人工决定由 Host 可信 UI 建立本地不可变记录：先分配 decisionRef 和 domainOperationId，固定请求语义并计算 requestDigest，再持久保存 DecisionRecord 与待发送请求，同一事务提交后才发送 Invoke。记录绑定 method、请求摘要、action、对象、候选、revision、用户实际查看的固定 EvidenceRef、actorRef、来源和时间；模型、Runtime 与可执行预览不能创建记录。

Runtime 收到需人工决定的 Invoke，调用 `host.decision.get`；Host 从真实连接核对 installation/instance/scope 和该记录可见性，返回记录及当前 valid/revoked 状态，不返回身份秘密。Runtime 必须比较 decisionRef、domainOperationId=Invoke.operationId、method、requestDigest、action/object/candidate/expectedRevision，并核对领域要求的证据集合和摘要。取得记录只证明人工输入来源，还须在领域提交事务内重核当前候选及决定资格。Host 在派发新副作用前重核撤销状态；跨方没有原子撤销保证，已经提交的决定保留事实，不能因后续撤销改写历史。撤销是追加状态记录，不改原确认内容。

人工 action 的空记录、未知记录、模型文字确认、旧候选或不同请求摘要均拒绝，不自动替换用户看过的候选。非人工 action 可用 null。host.execution.start 的 decisionRef 若非空，须对应已接受的 domainOperationId；Host 对照自己保存的原 Invoke 与当前授权核对，不能把领域决定当作任意工具权限。执行请求有自己的 requestDigest，不与父 Invoke 摘要混同。Grant、人工来源证明和领域资格分别检查。

领域 payload schema 必须在协商集合中，准确绑定 digest；未知 schema 不尝试通用执行。Schema 内 `$ref` 仅允许已入库的本地引用，禁止远程引用、动态下载、表达式或脚本。领域可能要求更严格前提，本契约不将通用字段校验当作充分准入。

EvidenceRef 固定 authority（host/runtime）、scope、对象、revision、媒体类型、长度、摘要和不透明 resourceHandle；不是任意路径或 URL。handle 由资源权威分配并绑定接收方、实例、scope、revision 和权限。host.resource.read 仅接受 host authority，runtime.resource.read 仅接受 runtime authority；Host 不直接读取 Runtime 私有文件。文本按安全子集显示，HTML/原型资源使用独立受限预览。读取每块复核授权与固定 revision，旧 handle、来源缺失、摘要冲突或无权读取分别报告。ResourceChunk.digest 始终为完整内容摘要，Host/Runtime 在组装全部块后核验 bytes 与 digest；分块上限不能绕过每个能力声明的总量上限。历史证据必须属于所查看事件当时的版本，后续证据只能作为明确的后继引用。

Runtime 证据进入 Agent 上下文的完整链为：Runtime 持久化 ContextCapture 请求身份，调用 `host.context.capture(scopeRef, domainOperationId, sources, grantRefs, …)`；Host 先持久接受，再逐项通过 `runtime.resource.read` 读取已授权固定字节，核对长度、完整摘要及 source identity，在 Host 私有存储原子保存不可变快照和 source→snapshot 映射。成功的 ContextCaptureReceipt 才提供 `snapshots`；其他状态不得暴露部分结果。空 sources 可得到空映射，不能隐式加入其他上下文。

capture 应答丢失先用 `host.context.get(scopeRef, operationId)` 查询；无法证明未接受时不换键复制。查询成功取得 Host EvidenceRef 后，Runtime 才将其传给同一 domainOperationId 的 ExecutionStart.contextRefs。Host 在启动时校验快照出自成功 capture、安装/实例/scope/领域操作一致、当前 grant 有效、总字节与 profile 限额相符。复制不扩大授权，Host 快照继承来源权限约束；源撤权同时阻止快照的新读取/执行。读取失败、来源变化、跨 scope 或摘要不符均不启动 Agent。快照是上下文数据，不能冒充可信系统指令。不能将 Runtime 自报路径直接交给本地 Agent。

## 快照、事件与竞争

每个 scope 一个有序 projection stream；没有跨 Runtime 全局顺序。domain revision 仅作不透明前提比较，不能当数字排序。revision 是对象级的：只在该对象自身的行变化时推进，其他对象的提交不使它过期，项目级 action 不因某个任务的提交而失效。seq 用十进制字符串进行数值比较，时间戳仅供展示。

`snapshot.open` 原子取得一致快照及其 `(streamId, epoch, throughSeq)`，并保留该水位之后的重放日志。快照分页在同一 revision 上读取，pageToken 绑定调用方、scope、snapshotId、下页位置和期限，重复读取同页不得产生不同内容。r2 租约候选为 60 秒；分页成功可续租，建立订阅后由已确认 cursor 接替保护。过期返回 `RESYNC_REQUIRED`，不得拼接新旧页。

Host 把所有页保存到临时 projection 代次，确认末页、对象及事项身份唯一性、事项/action 的 scope 和目标一致性、图引用和一致水位后原子替换当前代次。随后从 throughSeq 订阅；中间发生的变化必须重放。同一连接对同一 scope 只有一条活动订阅：重同步时的新订阅替换旧订阅，Runtime 在结果中点名被替换的 `replacedSubscriptionId` 并停止向旧订阅投递；Host 忽略任何非当前 subscriptionId 的事件，不允许两条订阅同时向同一 projection 投递，也不用第二份投递补齐被拒绝的事件。如果订阅时日志已丢失，标 stale 并重新取快照。新鲜度只有在收到重放追平标记且无缺号后为 current；首个 snapshot 完整到达不单独证明实时同步。

事件只支持按对象 `upsert/remove`、按 action `upsert/remove`、按待处理事项 `pending.upsert/pending.remove`、`operation.changed` 与 `stream.caughtUp`，避免 JSON Patch 对数组下标及域内数据结构的隐式依赖。每条事件包含 subscriptionId、eventId、stream/epoch/seq、scope、domainRevision、causationId 和 payload。操作记录事件也占序号；caughtUp 为控制通知，携带 throughSeq，不推进数据 seq，完整结构见 schema。

Host 接受的下一条数据事件必须是当前已提交 seq + 1；重复且字节摘要一致忽略，相同身份不同内容按协议冲突停止同步，跳号暂停 action 并重同步。新的 incarnation 重连可以延续持久 epoch；旧 connection 的任何事件一律拒绝，即使 seq 更大。新 epoch 必须完整快照，不接在旧 epoch 后。payload、action 变化和 cursor 同一 SQLite 事务提交，之后才 ack；崩溃可重放。ack 丢失重复确认不重复执行，也不改变领域状态。

## 幂等、未知结果与取消

去重键作用域为 `(installationId, instanceId, scopeRef, method, idempotencyKey)`；实例级 lifecycle 方法用固定内部 scope `instance`。operationId 在 installation 内唯一。Runtime 应永久保留仍被活动、待处理、恢复或历史决定引用的请求记录；不再需要完整结果时可保留 operationId、键和摘要 tombstone，不能静默把旧键视为新请求。对 tombstone 的应答固定为：`runtime.operation.get` / `host.operation.get` 返回 `RESULT_UNKNOWN`（`absenceProven` 为 false）；同键同摘要的重传返回 `status=unknown` 的 Operation，不新建操作；同键不同摘要返回 `IDEMPOTENCY_CONFLICT`。保留期和删除必须可查询，普通 90 天事件清理不删除未知结果的去重依据。

requestDigest = SHA-256(RFC 8785 规范化后的语义请求)。规范化对象包含 method 及所有非 Context 参数，但排除 requestDigest 自身；RPC id 和连接身份不参与，因此重连可查询/重传同一意图。含 grant revision、候选、expectedRevision 和 decisionRef 的请求一旦改变就属于新意图。仅允许 I-JSON 数字域，超出精确整数范围的值使用十进制字符串；重复 key 在计算前拒绝，禁止静默 Unicode 归一化。安装文件摘要采用原字节 SHA-256，两种摘要不得混用。

接收方先核对身份及读/写资格，再查去重。相同键、相同摘要、相同 operationId 返回原结果；任一不一致返回 `IDEMPOTENCY_CONFLICT`。原结果读取也需当前查询授权，撤权后不能借重传泄漏旧结果。新操作按领域单写者再次核验前提，然后持久记录接受，再产生影响；不得先发送副作用后才建立操作身份。

Operation 状态为 `accepted/running/succeeded/failed/cancelled/unknown`。RPC accepted 只证明有可查询的持久记录；succeeded 只证明该操作定义的成功后置条件，不表示任务交付、人工合并或里程碑成功。unknown 不自动转 failed；可经独立查询找到确切结果后更新该操作，并追加新运行事件，保留先前未知记录。终态操作可带机械可读的 `resultCode`（由 Capability 登记闭集，例如接纳失败的 `SOURCE_INDETERMINATE`、`SOURCE_UNRESOLVED`、`DUPLICATE_UPSTREAM`、`CAPACITY_EXHAUSTED`、`ACCEPT_ABORTED`），accepted/running 阶段为 null；`reason` 仍是人读文本，不作为程序判定依据。终态为 failed 或 cancelled 的操作，其结果证据读取（`runtime.resource.read` 与 `host.resource.read` 指向该操作 `resultRef` 的读取）以 `EXECUTION_FAILED` / `CANCELLED` 拒绝并保留记录与事件；操作查询本身只以 `status` 表达终态，不返回这两个码。

应答丢失先向操作 owner 按 operationId 查询：Host 查询 Runtime 使用 `runtime.operation.get`，Runtime 查询 Host 执行使用 `host.operation.get`。Host 必须持久化启动与取消操作及 executionRef 的关联，查询可返回尚未分配执行引用的 accepted；未知结果不得重新创建物理执行。`NOT_FOUND` 只有在权威索引完整且确认从未接受时成立，必须返回 `absenceProven: true`；索引丢失、保留期未知或外部副作用未知返回 `RESULT_UNKNOWN`。即使确认未接受，也必须重新核对同一 action 前提和授权；重传保持原键和意图。不能为了“重试成功”自动新建 key、换候选、换账户或重放 push/merge。

Cancel 本身是幂等操作。目标先完成就返回已完成，不改写为取消；取消先被领域接受则阻止该操作的新工作，已发送影响另查询。Host 只承诺已核对的物理执行停止，不代替 Runtime 的取消结算；cancelled 也不承诺外部副作用撤回。物理停止与领域结算分层对应：`host.execution.cancel` 产生取消 Operation，物理终态由 `PhysicalExecution.state=stopped` 加 `stopReason=cancelled` 表达；领域把该 attempt 记为 `terminated` 一类的自身 outcome，并要求其对接的正式通道（例如评审通道）提供一个明确的“Host 取消”分类，不把取消折叠为配置被拒或输出无效。Runtime 或 Host 崩溃后重建连接、权限和快照，再查询原 operation；旧子进程身份不明时拒绝新写者，禁止按进程名清理。新化身在 ready 后必须先从正式记录继续自己 accepted/running 的操作：在飞 attempt 先经 `host.operation.get` 与 `host.execution.get` 查询物理事实再决定续接、结算或放弃，不盲目重执行。

## 错误与恢复

标准 JSON-RPC 错误码保持原义，业务错误统一使用 `-32000` 和稳定的 `data.code`。包含非秘密 message、scope/operation 可用关联、`recovery`；不得凭 `retryable` 自动批准副作用。`recovery` 闭集为 none、resync、query、reauthorize、review、reconnect、retry-later；`retry-later` 只用于请求未被接受的 `BUSY` / `RESOURCE_LIMIT`，发起方按背压规则以同一键同一摘要重试。

| data.code | 必需处理 |
| --- | --- |
| `UNSUPPORTED_VERSION` / `UNSUPPORTED_CAPABILITY` | 不进入相应 ready/能力，不自动安装兼容包 |
| `PERMISSION_DENIED` / `PERMISSION_REVOKED` | 拒绝新调用，取消依赖能力；取得授权不自动重放 |
| `PRECONDITION_CONFLICT` / `IDEMPOTENCY_CONFLICT` / `WRITER_CONFLICT` | 保留原候选与请求，展示真实差异，不用新键绕过 |
| `RESOURCE_LIMIT` / `BUSY` | 未接受则明确拒绝并以 `recovery: retry-later` 提示，发起方按背压规则重试同一键同一摘要，不得据此自动批准副作用；已接受必须能查询，不静默丢弃 |
| `RESYNC_REQUIRED` | 禁用依赖当前状态的操作，重建完整 projection |
| `NOT_FOUND` / `RESULT_UNKNOWN` | 区分已证明缺失与无法证明，后者只能核实结果 |
| `EXECUTION_FAILED` / `CANCELLED` | 由该操作结果证据的读取返回，操作查询以 status 表达；保存实际影响及原事件，领域终态由领域方判定 |
| `INTEGRITY_MISMATCH` / `INVALID_SOURCE` | 停止使用受影响内容，保留已知安全数据与诊断；`INTEGRITY_MISMATCH` 也记录 Host 对 Initialized 的复核失败与发布记录同名字段不一致 |

## 物理执行边界与 Host 不承诺项

执行预算是事后止损，不是事前隔离。`budget.maxToolCalls`、`maxRunSeconds`、`maxOutputBytes` 与 `cleanupSeconds` 定义 Host 何时停止进程：工具调用以协议输出中的调用块计数，超过上限即终止，越界的那一次调用可能已经发出；时长超限先 SIGTERM，清理秒数内未退出再 SIGKILL；transcript、stderr 与单帧字节超限即终止并记 `output-limit`。进程结束的必要证据是父进程 wait 取得退出状态且退出后 PID 探测为不存在，二者写入 `PhysicalExecution.accounting`；`accounting` 中的计数必须与保存的 transcript 和端口报告相等，不相等即为 Host 报告不一致，由审计判为失败。`stopReason` 闭集为 cancelled、timeout、tool-call-budget、output-limit、signal；completed 的执行没有 stopReason。completed 必须带 `exit`，queued 与 reserved 没有 `exit`、`accounting` 与 `actualBinding`；state 为 unknown 时 `observationCompleteness` 不得为 complete。

执行端口的结果证据（`resultRef` 指向的 Host 证据）至少包含：实际绑定读回及其来源、材料读取物证（每份交付材料绑定原始事件中的调用 id，证明读取发生在该调用内；它不证明哪条沙箱规则允许了读取，也不证明没有读取其他内容）、原生批准记录与期望范围的逐字段比较结果、工具自身进程的关闭记录与端口进程的退出记录（两者分开保存，不得互相覆盖）。这些字段的具体 schema 由执行 profile 登记；本节只规定它们必须存在且可独立审计。

Host 在首期明确不承诺以下事项，条款只记录边界，不作为能力：本地 Agent 以 print 模式启动时，首个模型请求之前没有操作系统级隔离，初始化帧的工具目录核对发生在流式启动期间；登录状态依赖账户环境变量与钥匙串一致，Agent 对宿主目录（例如 `~/.claude.json`、`~/.claude/`）的读写不在执行目标隔离内，只能披露与记录；失控或不合作进程的跨资源、Host 文件和网络强隔离继续后置（OD-209）；断电后的 accepted 耐久性按 OD-274 确认的承诺表述：已接受操作在进程中断与操作系统正常运行下可见且可恢复；设备断电后最后一批已接受操作可能丢失，丢失的操作由恢复流程按 unknown 处理，发起方以原操作身份与幂等键重新提交，不重复生效、不伪装成功；断电耐久不作为首期承诺，补证保留为后续项。（KB-137 据此闭合；依据为 E-02 只证明进程中断后的可见性与可恢复性，且本机 Git 2.50.1 的 `core.fsyncMethod=fsync` 文档只写“fsync() 系统调用或平台等价物”、E-02 探针对状态文件使用不强制刷写磁盘缓存的 `os.fsync()`）。以上每项在被证明前不得写成更强承诺。

## 升级与冻结

安装/更新 operation 由 Host 持久化，Runtime 的 quiesce/shutdown 仅是物理步骤，不能证明领域已无保护引用。Host 先建立自己的安装屏障并检查物理执行、未决请求和版本引用，再调用实例级 `runtime.upgrade.prepare`，绑定原/目标 bundleDigest、原/目标 dataFormat 以及持久操作身份。Runtime 在与独立 CLI 共用的领域写者事务内持久建立 barrierRef、封锁新领域写入/保护引用并重检全部 scope 的 active、paused、unknown、恢复及治理引用。任一引用存在则在同一事务撤回本次屏障，返回 blocked、空 barrierRef 和带 scope/object/revision/reason 的保护清单，保留旧版本及其合法恢复入口；清单超过页限时返回 RESOURCE_LIMIT 并停止升级，不能截断后报告 prepared。保护状态由领域判断，Host 不解析工作流标签。

只有 prepared、非空 barrierRef、零保护引用且来源/目标身份精确一致时，Host 才可继续 quiesce、备份、迁移和替换。预检没有该资格；Host 本地屏障和领域持久屏障必须同时存在。屏障记录包含准备时控制代次和 domainRevision；领域 CLI、重启后的 Runtime 以及所有相关存储写者必须服从同一屏障。屏障没有自动到期释放，进程退出、断连和新 controlGeneration 均不释放它。查询/必要备份及受控迁移可执行，普通用户 action 和新增保护引用持续被拒绝。

准备应答丢失通过 `runtime.upgrade.get(operationId)` 恢复同一记录；丢索引或无法证明屏障状态则返回 RESULT_UNKNOWN/unknown 并禁止替换。blocked 结果是该操作的固定结果，保护引用实际解决后须新的明确升级尝试；不能用重传把 blocked 变成 prepared。升级期间不会并行运行两个版本。候选新进程只进入恢复模式，先读取同一持久屏障，核对 target bundle、数据格式及 Host 安装记录，取得新的合法控制代次；未查明屏障前不激活 scope 写入。

备份和迁移由领域 owner 的已验证升级入口执行，数据仍为领域私有；v0 在 Runtime Contract 中只定义准入和释放，不提供任意迁移脚本执行 API。安装包的固定维护入口、备份/迁移 receipt 格式和 Host 核对办法属于签名安装 profile 的必需冻结输入，尚未验证时禁止实际升级。Host 只切换自己的安装指针和 projection。备份失败停止；无可恢复旧数据不能仅回退二进制。领域维护方案必须保证屏障和去重日志可由原/目标版本及维护入口一致读取；恢复业务数据不得回退 controlGeneration、屏障或已接受操作身份，否则不具备升级资格。

Host 核实目标 bundle、迁移 receipt、实际进程、健康及领域只读快照后，通过新进程调用 `runtime.upgrade.release(disposition=activated)`；恢复旧包及原数据后用 restored。请求绑定 prepareOperationId、barrierRef、实际 runningBundleDigest 和 dataFormat，Runtime 同时核对自身真实包身份、领域格式及持久屏障。身份不符或新旧进程互斥未证均拒绝；成功持久记录释放及 Operation 后才开放写入，随后 Host 解除本地屏障。release 应答丢失先查询 `runtime.operation.get(scopeRef=instance, operationId)` 和 upgrade.get；释放成功不重做迁移。release 成功时 Runtime 把释放时刻的领域修订持久记入 `UpgradeState.releasedDomainRevision`。激活失败且尚无新用户写入才可恢复：Host 恢复前先经 `runtime.upgrade.get` 取得该值，再以恢复模式的只读快照取得当前 `domainRevision`，二者相等才允许回退；不等表示 release 后已有写入（独立 CLI 的写入推进同一 `domainRevision`，同样被计入），保持屏障进入显式恢复；任一值取不到按 `RESULT_UNKNOWN` 处理并禁止回退。不用超时恢复写入。治理升级与 bundle 更新分开决定。

冻结须同时绑定规范、完整 schema、方法校验、示例、跨语言与跨领域 fixtures、兼容矩阵、进程监督与放行探针、后置的签名隔离探针和 Mars 明确批准。r2 至 r4 的结构 schema 不检查全部状态语义，method 关联、授权来源、放行阻塞和后置的真实隔离必须按[验证方案](validation-plan.md)补齐；r3 新增字段的真实形态来自阶段 3 的 E-06 r1 至 r3 实验记录，这些记录按其运行时的 draft.2 解释，不因 draft.3 或 draft.4 改写；r4 新增字段与消息来自阶段 2 r2 的设计要求与 E-06 的进程记录；V-01、V-10 与跨语言 r1 已产生 draft.4 帧并冻结为 fixtures，它们按冻结的 draft.4 schema 副本校验，不按当前候选改写；r5 只补处理规则、可空字段、argv 模板约束与一个恢复提示值，尚无按 draft.5 帧运行的实验。冻结后同一正式 Host 构建再执行两个 fake Runtime 符合性，真实 HarnessPlane 另交付领域及组合证据；不能用冻结前的模型程序替代生产实现验收。
