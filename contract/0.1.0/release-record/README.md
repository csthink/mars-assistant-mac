# bundle 发布记录 schema 候选

候选，2026-09-14，按 OD-279 的 W-04 产出。本目录是 Runtime bundle 发布记录与已安装 artifact 记录的 JSON Schema draft-07 候选：[release-record.schema.json](release-record.schema.json)（`$id` `urn:csthink:runtime-release-record:0.1.0-candidate`）与 [examples.json](examples.json)（4 个接受、8 个拒绝的合成示例，由 `validate.mjs` 校验）。它是独立文件，不并入 [schema.json](../schema.json)，Contract 0.1.0-draft.4 正文不引用它；未冻结，真实签名身份、公证与正式安装包归阶段 5（EAC-08）。示例中的摘要是短测试字符串的 SHA-256，不是任何真实包的摘要。

## 1. 字段来源

| 来源 | 采用的要求 |
| --- | --- |
| [Contract README](../README.md)“安装、身份与协商”第二段 | 发布记录在 bundle 外签名；绑定 archive SHA-256、manifest SHA-256、逐文件清单及发布者身份；archive 的自摘要不写进 archive 内的 manifest；描述摘要不循环包含自身 |
| [扩展分发设计](../../runtime-delivery-design.md)“分发描述与安装生命周期”记录表 | 已签名发布描述：runtimeId、发布版本、artifact digest、manifest digest、平台、压缩/展开体积上限、文件清单摘要、签名身份、依赖及来源引用、隔离 profile 身份；已安装 artifact：实际文件摘要、原上游及最终签名关联、验证结果、已验证启动组合、受限入口；以实际字节而非下载 URL 作为身份 |
| [V-10 结果报告](../../assistant-hp-v10-install-upgrade-results-20260914.md) | 实验形态 `od277-v10-release/v1` 与 Host reference 的核验顺序：签名、发布者与 runtimeId、archive 摘要、逐文件清单、manifest 摘要、依赖、成员形态 |

扩展目录项、安装 operation、激活与引用记录、仓库治理安装记录四类不在本候选内：前三类是 Host 本地状态而非签名对象，最后一类由领域 owner 定义。

## 2. 与 V-10 实验形态 `od277-v10-release/v1` 的逐字段对照

| 字段 | 实验形态 | 本候选 | 关系 |
| --- | --- | --- | --- |
| `schema` | `od277-v10-release/v1` | `csthink-runtime-release/v1-candidate` | 一致（值改为候选身份） |
| `runtimeId`、`version`、`platform`、`dataFormat` | 字符串 | 同名，`platform` 闭集 `darwin-arm64`/`darwin-x86_64` | 一致 |
| `publisher` | 字符串 `publisher:v10-lab`，签名密钥在 bundles.json 之外登记 | 对象：`id`、`signatureAlgorithm`（闭集 `ed25519`）、`publicKeyDigest` | 缺失补齐：签名身份进入记录本身 |
| `archiveDigest`、`archiveBytes` | 顶层两个字段 | `archive {digest, bytes, format}`，`format` 闭集 `ustar` | 一致（归组并固定归档格式） |
| `manifestDigest` | 顶层字段 | `manifest {path, digest, bytes}`，`path` 固定 `manifest.json` | 一致（补 bytes） |
| `files[]` | `path`、`bytes`、`mode`、`sha256` | 同四字段；`path` 为相对路径模式（无前导斜杠、无 `.`/`..` 段、无反斜杠）；`mode` 闭集 | 一致（补路径模式） |
| `expandedBytesMax` | 顶层字段 | `limits {expandedBytesMax, membersMax}` | 缺失补齐：成员数上限 |
| `dependencies[]` | `id`、`version`、`digest` | 同 | 一致 |
| `maintenance` | `{entrypoint, argv}` | 同，或 `null` | 一致（允许无维护入口的包） |
| `permissionProfileDigest` | 只在 bundles.json 与 manifest 内 | 记录内必填 | 缺失补齐：分发设计要求“隔离 profile 身份”，draft.4 语义为受信任本地执行配置摘要 |
| `source` | 无 | `{kind: built-in/catalog/offline-import, reference}` | 缺失补齐：分发设计要求“来源引用” |
| `releaseDigest` | 只在 bundles.json（发布记录字节的 SHA-256），不在 release.json 内 | 记录内禁止出现 `releaseDigest`、`recordDigest`、`signature` | 一致（非循环规则以 schema 表达） |
| `release.sig` | 独立文件，Ed25519 对 release.json 原字节签名 | 不在 schema 内；`InstalledArtifact.signature` 记录核验结果 | 一致（分离签名） |

多余项：实验形态没有本候选之外的字段。

## 3. 非循环与身份规则

- 发布记录只列 archive 与 manifest 的摘要，不含自身摘要或签名；其自身字节的 SHA-256（V-10 中的 `releaseDigest`）只保存在 Host 的 `InstalledArtifact.releaseRecordDigest`。
- `manifest.json` 是 archive 的成员，其摘要由发布记录绑定；archive 的摘要不写进 manifest。这与 [contract-manifest.py](../contract-manifest.py) 对协议发布 manifest 的规则相同：被散列列表不包含 manifest 自身。
- `InstalledArtifact` 的 `artifactDigest` 是实际字节摘要；`stage` 为 `installed` 或 `active` 时 schema 要求 `signature.verified` 为 true 且 `verification.result` 为 verified。schema 不能证明签名核验实际发生，核验顺序与拒绝原因仍由安装程序按扩展分发设计执行并记录。
- 下载 URL、目录项文字与发布者名称都不是身份；`downloadUrl` 一类字段被 `additionalProperties: false` 拒绝。

## 4. 未冻结与后续

本候选不改变 Contract draft.4 的 `Manifest` 定义；两者的字段一致性（`runtimeId`、`version`、`platform`、`dataFormat`、`permissionProfileDigest`、`dependencies`）在 draft.5 修订时核对，见 [revision-candidates.md](../revision-candidates.md)。签名算法闭集只登记 V-10 使用的 Ed25519；Developer ID、公证与真实 `.app` 安装包的记录形态在阶段 5 按实际安装包另行确认。
