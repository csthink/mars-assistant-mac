# Runtime Contract v0 r5 候选修订

日期：2026-09-15。输入为 [Contract 0.1.0-draft.4](README.md)（修订前 README.md SHA-256 `b5361a84bcb679d2bdd8c779d7d4c1a30dc3bdaac32ed2665a79348cc16c327d`，schema.json `1608bf96fd80905c4679cf7b0aa1360208535c713cc99b89942bdce90c76b5d4`，`contractDigest` `bce15fb8e7c1986d772553a39d0185c095dbb5a81b8e2f496df268ae00516f6e`）、[修订候选登记](revision-candidates.md)RC-01 至 RC-11、[draft.5 修订范围确认书](../runtime-contract-draft5-scope-20260915.md)第 3 至 5 节与第 10 节裁定（OD-295：七项均按建议）。Mars 按 OD-295 批准在原目录以 0.1.0-draft.5 候选形式修订正文、schema 生成源、示例、fixtures 校验方式、manifest 与本记录；不包含协议冻结、实际 Runtime、生产实现、跨仓修改、fixtures 字节修改或实验运行。draft.4 的静态校验报告与生成物由 seal `9120c2f5c94040f15951a3e5e00dcdc69b53322f` 的历史保留。

修订候选为 [Contract 0.1.0-draft.5](README.md)。下表记录每项候选的处理、schema 变化、正文位置和示例，不是实现验收。

## 1. 修订项

| 候选 | 依据 | schema 变化 | 正文位置 | 示例 |
| --- | --- | --- | --- | --- |
| RC-01 释放时领域修订 | KB-197；V-10 结果报告第 4 节；裁定 6 | `UpgradeState` 新增可空可缺省 `releasedDomainRevision`；`status=released` 时必填非空（allOf 第三条） | 升级与冻结第五段；方法目录 `runtime.upgrade.get` 行 | `upgrade-released-with-revision-valid`、`upgrade-released-missing-revision-rejected`、`upgrade-released-null-revision-rejected`、`upgrade-prepared-null-released-revision-valid`；R2 流程新增第 4 次交换（释放后 `runtime.upgrade.get`） |
| RC-02 启动参数模板 | KB-198；V-10 结果报告第 4 节；裁定 3 (a) | `Manifest.argv` 元素改为 `ARGV_TEMPLATE`：只允许闭集占位符 `${runtimeRoot}`、`${instanceDir}`、`${contractDigest}`、`${resourceHandle}`，其他 `${` 形态拒绝；不新增字段 | 安装、身份与协商首段与 `permissionProfileDigest` 句 | `manifest-argv-template-valid`、`manifest-argv-unknown-placeholder-rejected`、`manifest-argv-malformed-placeholder-rejected` |
| RC-03 与 RC-08 manifest 与 contractDigest | W-03 执行发现；OD-281 (b)；OD-283 | 无 | 安装、身份与协商第二段 | 无（`contract-manifest.py --check` 与 validate.mjs `contract-manifest-matches-files`） |
| RC-04 协商复核失败 | W-01 执行发现 | 无 | 安装、身份与协商 initialize 段；错误与恢复表 `INTEGRITY_MISMATCH` 行 | `initialize-review-mismatch-valid` |
| RC-05 平台不匹配 | W-01 执行发现；扩展分发设计 | 无 | 安装、身份与协商首段 | 无（安装准入，无帧） |
| RC-06 发布记录 schema | W-04；裁定 4 (a) | 无（独立文件保持；`release-record/` 三个文件列入协议发布 manifest） | 安装、身份与协商第二段（同名字段一致性规则） | 既有 `release-record/examples.json` 12 例不变 |
| RC-07 | OD-279 已闭合 KB-128/184/188 | 无 | 无 | 无 |
| RC-09 失败与取消结果证据 | 跨语言 r1 XL-09、XL-14 | 无 | 幂等、未知结果与取消“Operation 状态”段；错误与恢复表 `EXECUTION_FAILED` / `CANCELLED` 行 | 无新增（xl-r1 帧 `graph-4`、`graph-7` 为 draft.4 观察） |
| RC-10 retry-later | 跨语言 r1 XL-10；裁定 5 (a) | `ErrorData.recovery` 枚举新增 `retry-later` | 错误与恢复首段与表 `RESOURCE_LIMIT` / `BUSY` 行 | `busy-retry-later-valid`、`resource-limit-retry-later-valid`、`error-unknown-recovery-rejected` |
| RC-11 tombstone 应答 | 跨语言 r1 XL-12 | 无 | 幂等、未知结果与取消第一段 | `tombstone-same-key-other-digest-conflict-valid` |
| 版本与依据 | 范围确认书 W-01 | `VERSION` 改为 `0.1.0-draft.5`（`$id`、`Context.protocolVersion`、`Manifest.manifestVersion` 随之只接受该值） | 文首候选行、配套列表、升级与冻结末段 | examples.json 与 interaction-examples.json 的 53 处版本标记迁移 |

## 2. 生成、校验与示例迁移

`schema-source.py` 的 `VERSION` 改为 `0.1.0-draft.5`；schema.json 与 methods.json 重新生成（定义数 110 不变，方法数 28 不变；`UpgradeState` 增加一个可选属性与一条 allOf，`Manifest.argv` 元素增加模式，`ErrorData.recovery` 增加一个枚举值）。examples.json 与 interaction-examples.json 由一次性脚本迁移：53 处 `protocolVersion` / `manifestVersion` 值改为 draft.5（Context 不参与 requestDigest，摘要不变；capability 的 `version` 是能力身份，保持 `0.1.0-draft.2`）；新增 12 个结构正反例（见第 1 节）；R2 流程新增第 4 次交换。校验入口不变。

fixtures 校验方式按裁定 2 (a)：`fixtures/schema-0.1.0-draft.4.json` 与 `fixtures/methods-0.1.0-draft.4.json` 是修订前 schema.json 与 methods.json 的逐字节副本（SHA-256 `1608bf96…` 与 `f2c5114e…`，由 validate.mjs 的 `fixture-schema-draft4-frozen` 固定）；validate.mjs 用该副本编译并校验 32 份 draft.4 transcript 的每一帧，`fixtures-index.py` 以 `FIXTURE_VERSION` 与冻结方法目录分类覆盖，`index.json` 与 `coverage.json` 记录 `candidate`（当前候选）与 `fixtureVersion`（帧版本）两个值；transcript 字节、本地归档与覆盖计数（9,498 帧）不变。

协议发布 manifest 由 `contract-manifest.py --write` 重生成：候选 `0.1.0-draft.5`，内容文件由 9 个增至 13 个（新增 revision-r5.md 与 release-record 目录的 README、schema、示例）。新的 `contractDigest` 不写入本记录（本记录在被散列列表内），登记于[验证方案](validation-plan.md)“draft.5 修订登记”段与 validation.json；draft.4 的 `bce15fb8…` 与跨语言 r1 的 `7b9d8126…` 作为历史值保留。

## 3. 逐项原文、新文与依据

每项列出被替换的原文字（draft.4）与新文字（draft.5）。替换以精确字符串一次匹配完成，未列出的段落字节不变。引用文字内的相对链接以 README.md 所在目录为基准，是被引用正文的一部分。

| 编号 | 候选 | 位置 | 依据 |
| --- | --- | --- | --- |
| E-01 | RC-00 | 文首候选行 | 范围确认书 W-01；OD-295；spec 0.5 r1 与 architecture 0.3 r4 已按 OD-294 签署 |
| E-02 | RC-00 | 文首候选行（draft.5 句） | 范围确认书 W-01；OD-295 |
| E-03 | RC-00 | 配套列表 | 范围确认书 W-01 |
| E-04 | RC-05、RC-02 | 安装、身份与协商首段末 | RC-05（W-01 执行发现）；RC-02（KB-198，OD-295 裁定 3 (a)）；扩展分发设计“不显示可用” |
| E-05 | RC-03、RC-08、RC-06 | 安装、身份与协商第二段“协议发布 manifest”句 | RC-03（W-03 执行发现）；RC-08（OD-281 (b)、OD-283）；RC-06（OD-295 裁定 4 (a)） |
| E-06 | RC-04 | 安装、身份与协商 initialize 段末 | RC-04（W-01 执行发现）；兼容矩阵“Initialized 选择了 Initialize 未提供的 profile”行 |
| E-07 | RC-02 | 安装、身份与协商 `permissionProfileDigest` 句 | RC-02（KB-198）；OD-295 裁定 3 (a) |
| E-08 | RC-01 | 方法目录 `runtime.upgrade.get` 行 | RC-01（KB-197）；OD-295 裁定 6 |
| E-09 | RC-11 | 幂等、未知结果与取消第一段末 | RC-11（跨语言 r1 XL-12） |
| E-10 | RC-09 | 幂等、未知结果与取消“Operation 状态”段末 | RC-09（跨语言 r1 XL-09、XL-14） |
| E-11 | RC-10 | 错误与恢复首段 | RC-10（跨语言 r1 XL-10）；OD-295 裁定 5 (a) |
| E-12 | RC-10 | 错误与恢复表 `RESOURCE_LIMIT` / `BUSY` 行 | RC-10 |
| E-13 | RC-09 | 错误与恢复表 `EXECUTION_FAILED` / `CANCELLED` 行 | RC-09 |
| E-14 | RC-04、RC-06 | 错误与恢复表 `INTEGRITY_MISMATCH` / `INVALID_SOURCE` 行 | RC-04；RC-06 |
| E-15 | RC-01 | 升级与冻结第五段“激活失败”句 | RC-01（KB-197）；V-10 结果报告第 4 节；OD-295 裁定 6 |
| E-16 | RC-00 | 升级与冻结末段 draft.4 实验句 | 范围确认书第 4 节；OD-295 裁定 2 (a) |

### E-01（RC-00）：文首候选行

依据：范围确认书 W-01；OD-295；spec 0.5 r1 与 architecture 0.3 r4 已按 OD-294 签署

原文字：

```text
候选：**0.1.0-draft.4，DRAFT，2026-09-14**。本文件是 Assistant 拥有的通用 Host Contract 候选；不是冻结版，也不是 HarnessPlane 已认可的领域 API。依据为 [spec 0.3 r8](../../spec.md)、[architecture 0.3 r3](../../architecture.md)和[设计范围](design-review.md)；
```

新文字：

```text
候选：**0.1.0-draft.5，DRAFT，2026-09-15**。本文件是 Assistant 拥有的通用 Host Contract 候选；不是冻结版，也不是 HarnessPlane 已认可的领域 API。依据为 [spec 0.5 r1](../../spec.md)、[architecture 0.3 r4](../../architecture.md)（均已按 OD-294 签署）和[设计范围](design-review.md)；
```

### E-02（RC-00）：文首候选行（draft.5 句）

依据：范围确认书 W-01；OD-295

原文字：

```text
逐项依据与对 draft.3 帧的兼容性见[r4 修订记录](revision-r4.md)。文中的“必须/不得”
```

新文字：

```text
逐项依据与对 draft.3 帧的兼容性见[r4 修订记录](revision-r4.md)；draft.5 按 OD-295 把[修订候选登记](revision-candidates.md)的 RC-01 至 RC-11（升级恢复的释放修订、启动参数模板、协议发布 manifest 与 `contractDigest` 的定义、协商复核失败与平台不匹配的处理、发布记录 schema 的引用与一致性、失败与取消结果证据的返回、`retry-later` 恢复提示、tombstone 应答）写入候选，逐项依据与对 draft.4 帧的兼容性见[r5 修订记录](revision-r5.md)。文中的“必须/不得”
```

### E-03（RC-00）：配套列表

依据：范围确认书 W-01

原文字：

```text
[阶段 2 同步修订 r4](revision-r4.md)、[验证方案](validation-plan.md)。
```

新文字：

```text
[阶段 2 同步修订 r4](revision-r4.md)、[候选修订 r5](revision-r5.md)、[发布记录 schema 候选](release-record/README.md)、[验证方案](validation-plan.md)。
```

### E-04（RC-05、RC-02）：安装、身份与协商首段末

依据：RC-05（W-01 执行发现）；RC-02（KB-198，OD-295 裁定 3 (a)）；扩展分发设计“不显示可用”

原文字：

```text
实际解包还须核对重复路径、大小和摘要，schema 的字符串校验不能替代文件核验。
```

新文字：

```text
实际解包还须核对重复路径、大小和摘要，schema 的字符串校验不能替代文件核验。Manifest 的 `platform` 或 `minimumOs` 与本机不匹配时在安装准入拒绝：不进入 staging 之后的步骤、不激活、不发出 `runtime.initialize`；安装记录的原因归 `UNSUPPORTED_VERSION`，目录项显示为不可用而不是可安装。`argv` 是启动参数模板：Host 只展开闭集占位符 `${runtimeRoot}`（每用户 Runtime 根，即共享安装根）、`${instanceDir}`（本实例运行目录）、`${contractDigest}`（协议发布 manifest 摘要）与 `${resourceHandle}`（Host 登记的不透明资源句柄），其余字节固定；连接参数只经该模板传给 Runtime 进程，不经环境变量或模板之外的追加参数。
```

### E-05（RC-03、RC-08、RC-06）：安装、身份与协商第二段“协议发布 manifest”句

依据：RC-03（W-03 执行发现）；RC-08（OD-281 (b)、OD-283）；RC-06（OD-295 裁定 4 (a)）

原文字：

```text
协议发布 manifest 对正文、schema、fixtures 的原字节逐项列摘要，自身不包含在被散列列表中；其 SHA-256 为 `contractDigest`。
```

新文字：

```text
协议发布 manifest（`contract-manifest.json`，由 `contract-manifest.py` 生成与核对）对规范内容文件的原字节逐项列摘要：正文、schema 生成源与输出、方法目录、`examples.json` 与 `interaction-examples.json` 两份规范示例、修订记录，以及作为独立文件维护的[发布记录 schema 候选](release-record/README.md)；manifest 自身、`fixtures/` 下的证据 transcript 及其冻结副本、验证方案不在被散列列表中。manifest 原字节的 SHA-256 为 `contractDigest`；`Context.contractDigest` 与 `Protocol.contractDigest` 必须等于该值。历史 transcript 中以 schema.json 单文件摘要或含验证方案的 manifest 摘要记录的值按 fixtures 索引的说明保留，不改写。发布记录与 Manifest 的同名字段 `runtimeId`、`version`、`platform`、`dataFormat`、`permissionProfileDigest` 必须逐项相等，`dependencies` 集合相等；任一不等在安装准入拒绝并以 `INTEGRITY_MISMATCH` 记录原因。
```

### E-06（RC-04）：安装、身份与协商 initialize 段末

依据：RC-04（W-01 执行发现）；兼容矩阵“Initialized 选择了 Initialize 未提供的 profile”行

原文字：

```text
Runtime 选择第一个完全一致的协议身份，返回能力交集和精确执行 profile 引用；Host 复核后调用 `runtime.ready`。
```

新文字：

```text
Runtime 选择第一个完全一致的协议身份，返回能力交集和精确执行 profile 引用；Host 复核后调用 `runtime.ready`。复核发现 `selectedProtocol` 不在提供集合内、能力交集含未提供的能力或 required 能力不匹配、`executionProfiles` 含未提供的 profile 时，Host 不调用 `runtime.ready`，关闭连接，协议健康置 `incompatible`，连接记录的原因为 `INTEGRITY_MISMATCH`；不自动重试握手，不按 Runtime 的返回值修正自己的目录。
```

### E-07（RC-02）：安装、身份与协商 `permissionProfileDigest` 句

依据：RC-02（KB-198）；OD-295 裁定 3 (a)

原文字：

```text
`permissionProfileDigest` 是 Runtime 受信任本地执行配置的摘要，绑定准入检查所核对的启动配置原字节（入口、argv 模板、环境允许列表、依赖清单）；
```

新文字：

```text
`permissionProfileDigest` 是 Runtime 受信任本地执行配置的摘要，绑定准入检查所核对的启动配置原字节（入口、含闭集占位符的 argv 模板、环境允许列表、依赖清单）；占位符展开后的实际值写入 Host 的安装与启动记录以及 `ExecutionRecord`，不进入摘要；
```

### E-08（RC-01）：方法目录 `runtime.upgrade.get` 行

依据：RC-01（KB-197）；OD-295 裁定 6

原文字：

```text
| `runtime.upgrade.get` H→R | `operationId` | `UpgradeState`；恢复原准备结果，不新建屏障 |
```

新文字：

```text
| `runtime.upgrade.get` H→R | `operationId` | `UpgradeState`；恢复原准备结果，不新建屏障；释放后携带 `releasedDomainRevision` |
```

### E-09（RC-11）：幂等、未知结果与取消第一段末

依据：RC-11（跨语言 r1 XL-12）

原文字：

```text
不再需要完整结果时可保留 operationId、键和摘要 tombstone，不能静默把旧键视为新请求。
```

新文字：

```text
不再需要完整结果时可保留 operationId、键和摘要 tombstone，不能静默把旧键视为新请求。对 tombstone 的应答固定为：`runtime.operation.get` / `host.operation.get` 返回 `RESULT_UNKNOWN`（`absenceProven` 为 false）；同键同摘要的重传返回 `status=unknown` 的 Operation，不新建操作；同键不同摘要返回 `IDEMPOTENCY_CONFLICT`。
```

### E-10（RC-09）：幂等、未知结果与取消“Operation 状态”段末

依据：RC-09（跨语言 r1 XL-09、XL-14）

原文字：

```text
`reason` 仍是人读文本，不作为程序判定依据。
```

新文字：

```text
`reason` 仍是人读文本，不作为程序判定依据。终态为 failed 或 cancelled 的操作，其结果证据读取（`runtime.resource.read` 与 `host.resource.read` 指向该操作 `resultRef` 的读取）以 `EXECUTION_FAILED` / `CANCELLED` 拒绝并保留记录与事件；操作查询本身只以 `status` 表达终态，不返回这两个码。
```

### E-11（RC-10）：错误与恢复首段

依据：RC-10（跨语言 r1 XL-10）；OD-295 裁定 5 (a)

原文字：

```text
包含非秘密 message、scope/operation 可用关联、`recovery`；不得凭 `retryable` 自动批准副作用。
```

新文字：

```text
包含非秘密 message、scope/operation 可用关联、`recovery`；不得凭 `retryable` 自动批准副作用。`recovery` 闭集为 none、resync、query、reauthorize、review、reconnect、retry-later；`retry-later` 只用于请求未被接受的 `BUSY` / `RESOURCE_LIMIT`，发起方按背压规则以同一键同一摘要重试。
```

### E-12（RC-10）：错误与恢复表 `RESOURCE_LIMIT` / `BUSY` 行

依据：RC-10

原文字：

```text
| `RESOURCE_LIMIT` / `BUSY` | 未接受则明确拒绝；已接受必须能查询，不静默丢弃 |
```

新文字：

```text
| `RESOURCE_LIMIT` / `BUSY` | 未接受则明确拒绝并以 `recovery: retry-later` 提示，发起方按背压规则重试同一键同一摘要，不得据此自动批准副作用；已接受必须能查询，不静默丢弃 |
```

### E-13（RC-09）：错误与恢复表 `EXECUTION_FAILED` / `CANCELLED` 行

依据：RC-09

原文字：

```text
| `EXECUTION_FAILED` / `CANCELLED` | 保存实际影响及原事件，领域终态由领域方判定 |
```

新文字：

```text
| `EXECUTION_FAILED` / `CANCELLED` | 由该操作结果证据的读取返回，操作查询以 status 表达；保存实际影响及原事件，领域终态由领域方判定 |
```

### E-14（RC-04、RC-06）：错误与恢复表 `INTEGRITY_MISMATCH` / `INVALID_SOURCE` 行

依据：RC-04；RC-06

原文字：

```text
| `INTEGRITY_MISMATCH` / `INVALID_SOURCE` | 停止使用受影响内容，保留已知安全数据与诊断 |
```

新文字：

```text
| `INTEGRITY_MISMATCH` / `INVALID_SOURCE` | 停止使用受影响内容，保留已知安全数据与诊断；`INTEGRITY_MISMATCH` 也记录 Host 对 Initialized 的复核失败与发布记录同名字段不一致 |
```

### E-15（RC-01）：升级与冻结第五段“激活失败”句

依据：RC-01（KB-197）；V-10 结果报告第 4 节；OD-295 裁定 6

原文字：

```text
激活失败且尚无新用户写入才可恢复，否则保持屏障进入显式恢复，不用超时恢复写入。
```

新文字：

```text
release 成功时 Runtime 把释放时刻的领域修订持久记入 `UpgradeState.releasedDomainRevision`。激活失败且尚无新用户写入才可恢复：Host 恢复前先经 `runtime.upgrade.get` 取得该值，再以恢复模式的只读快照取得当前 `domainRevision`，二者相等才允许回退；不等表示 release 后已有写入（独立 CLI 的写入推进同一 `domainRevision`，同样被计入），保持屏障进入显式恢复；任一值取不到按 `RESULT_UNKNOWN` 处理并禁止回退。不用超时恢复写入。
```

### E-16（RC-00）：升级与冻结末段 draft.4 实验句

依据：范围确认书第 4 节；OD-295 裁定 2 (a)

原文字：

```text
r4 新增字段与消息来自阶段 2 r2 的设计要求与 E-06 的进程记录，尚无按 draft.4 帧运行的实验。
```

新文字：

```text
r4 新增字段与消息来自阶段 2 r2 的设计要求与 E-06 的进程记录；V-01、V-10 与跨语言 r1 已产生 draft.4 帧并冻结为 fixtures，它们按冻结的 draft.4 schema 副本校验，不按当前候选改写；r5 只补处理规则、可空字段、argv 模板约束与一个恢复提示值，尚无按 draft.5 帧运行的实验。
```

## 4. 对 draft.4 帧的兼容性

| 变化 | 对 draft.4 记录的解释 |
| --- | --- |
| `Context.protocolVersion` 与 `Manifest.manifestVersion` 只接受 draft.5 | 不兼容：draft.4 帧不能按 draft.5 schema 校验。与 draft.3 升 draft.4 时不同，本轮已有 32 份 draft.4 transcript（9,498 帧）被冻结为 fixtures，因此按 OD-295 裁定 2 (a) 用冻结的 draft.4 schema 副本校验它们，历史按其运行时版本解释，不改写 |
| `UpgradeState.releasedDomainRevision`（RC-01） | 兼容：可空可缺省；V-10 的 released 帧缺该字段，按历史解释；draft.5 接收方对 released 状态要求非空 |
| `Manifest.argv` 模式（RC-02） | 兼容：Manifest 不出现在协议帧中；V-10 r1 的 argv 模板含占位符，按闭集回读 |
| `contractDigest` 的取值依据（RC-03/RC-08） | 需迁移：字段模式不变，值必须等于 `contract-manifest.json` 的摘要；fixtures 中的单文件摘要值与含验证方案的 manifest 摘要值按 index.json 说明保留 |
| `ErrorData.recovery` 新增 `retry-later`（RC-10） | 兼容：旧帧使用 `none` 仍有效（xl-r1 的 8 次 BUSY），draft.5 起未接受的 BUSY / RESOURCE_LIMIT 应返回 `retry-later` |
| RC-04、RC-05、RC-06、RC-09、RC-11 | 兼容：只补处理规则与一致性规则，不改帧字段 |

实验证据不因本修订改写；重跑任何实验不是本修订的一部分。

## 5. 校验边界

[validate.mjs](validate.mjs) 校验结构、方法参数/结果、样例请求摘要、固定关系正反例、draft.4 fixtures（按冻结副本）、manifest、发布记录示例、文档链接和签署输入摘要；关系谓词不实现 Runtime，不证明身份认证、授权有效期、写者锁、持久化、放行阻塞、实际时序或完整 RFC 8785 符合性。具体结果和输入摘要见 [validation.json](validation.json)。所有跨语言、操作系统、生产 Host 和 HarnessPlane gate 保持 NOT RUN；协议冻结保持 NOT APPROVED；draft.5 是候选，尚无按 draft.5 帧运行的实验。
