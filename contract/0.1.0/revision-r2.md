# Runtime Contract v0 r2 评审修订

日期：2026-09-10。输入为 architecture 0.3 r1、Contract 0.1.0-draft.1 及其图示，Git 固定版本为 `c3333cd0137ce5bc3474392c38f96cdebea309d8`。Mars 在六项只读设计评审后明确“批准修订”（OD-160），授权补齐文档、schema、示例和受影响图稿；不包含实际 Runtime、操作系统隔离实验、生产实现、跨仓修改、协议冻结或 main 推送。

修订候选为 [architecture 0.3 r2](../../architecture.md) 和 [Contract 0.1.0-draft.2](README.md)。下表记录设计问题与对应修订，不是实现验收。

| 评审项 | 原问题造成的影响 | r2 的具体约束 | 静态证据与仍需实际验证的事项 |
| --- | --- | --- | --- |
| R1 / P1 待处理投影 | LOG-02 的等待排序、阻塞计数、类型筛选、已处理历史和多入口同一身份无法从原对象/action 可靠重建 | SnapshotPage 增加 PendingItem；pending.upsert/remove 纳入连续流。固定 itemRef、来源时间、类型、状态、blocking 和 action/证据关系；Host 组织关联去重，筛选不改变全局统计，stale 标记不完整 | pending/processed 正例、缺时间/处理后仍阻塞反例；固定重建目标保留来源字段和计数。实际缓存删除、事件重放和三入口竞争仍见 C-04/07/08 |
| R2 / P1 升级保护引用 | quiesce 只能停止本实例新 action，不能证明暂停/未知引用已清空，也挡不住独立 CLI 在预检后新增引用 | upgrade.prepare/get/release；Host 安装屏障与领域持久屏障同时成立。领域写者原子重检所有 scope，prepared 绑定版本/格式/控制代次；断连不释放，候选新进程先恢复屏障；维护入口与 receipt 未验证则不执行升级 | prepared/blocked 结构、缺 barrier/有引用却 prepared 反例、查询与释放身份关系。CLI 竞争、迁移/激活崩溃及屏障持久性仍须 C-11/12 和 S-07 |
| R3 / P1 上下文转换 | Runtime EvidenceRef 无法通过已定义方法得到 ExecutionStart 所需 Host 快照引用 | host.context.capture/get 返回专用持久 receipt 与 source→snapshot 映射；Host 调 runtime.resource.read 核对固定字节，再原子保存。成功且同 scope/领域操作/当前授权才可执行 | capture→read→get→execution.start 完整参数/结果；部分结果、Runtime authority 直接执行、跨 scope、不同操作、摘要变化反例。实际丢应答、撤权、分块及崩溃仍须 C-03/08 |
| R4 / P1 人工来源校验 | decisionRef 没有查询或可信校验结果，Runtime 无法验证用户确认是否对应当前请求 | host.decision.get 返回 Host 可信 UI 的 DecisionRecord；先分配引用再固定请求摘要，避免摘要循环。Runtime 比较请求/候选/证据/来源并自行重核领域资格；执行关联父 domainOperationId | Invoke 与嵌套查询示例；旧候选、不同摘要、已撤销与模型来源反例。真实输入来源、撤销竞争及原子提交仍须 C-08/S-06 |
| R5 / P2 首次授权顺序 | ready 要求 scope grant，而 scopeRef 只能在 ready 后生成，首次接入无法完成 | LaunchAuthorization 仅授权启动；ready 后 ScopeBinding 仅绑定身份并返回 inactive；Host 才建立 scoped Grant，经 scope.authorize 和 grants.get 激活。资源读取必须晚于激活，撤权不依赖通知 | 零初始 scope/grant 的完整握手与嵌套授权示例；初始化夹带资源 grant、跨 scope grant 反例。重连/迟到授权/真实资源拒绝仍须 C-02/08/S-06 |
| R6 / P2 执行策略协商 | ExecutionStart 要求精确 profile，但初始化没有提供与选择目录，无法判断策略是否可用 | Manifest 声明 capability 的 ExecutionProfileRef 依赖；Host 提供已验证 ExecutionProfile，Runtime 只选精确交集；必需依赖缺失阻止 ready，可选依赖缺失禁用该能力。Runtime OS 隔离 profile 与 Agent execution profile 分开 | 精确选择、目录缺失、摘要变化与缺 digest 反例。实际策略有效性、预算、间接访问及版本固定仍须 C-02/S-04/09 |

## 调用示例的解释方式

[interaction-examples.json](interaction-examples.json) 保存五组正向调用目录和关系正反例；R5 与 R6 共用首次连接示例。每个 exchange 的 params 和 result 分别按 [methods.json](methods.json) 指向的 schema 验证。有嵌套请求的场景按请求发起顺序列出，并注明外层应答晚于内层结果；它不是实际执行 transcript。各场景相互独立，合成摘要及授权引用不是可用安装或授权记录。

R1 的固定重建目标用于核对 PendingItem 所需字段可表达且来源时间未丢失；校验器没有启动缓存实现。R2 的 release 示例以维护入口、receipt 和目标身份已核实为前提，没有执行安装或迁移。R3 的成功 receipt 提供执行参数可引用的 Host 快照，不通过不透明 resultRef 再引入未定义的解析步骤。R4 先由 Host 可信输入事务保存记录，Runtime 无创建人工记录接口。R5 将目录选择、启动身份、scope 分配和资源授权明确分开。

## 校验边界与兼容性

r2 修改必填字段并新增七个请求方法及两种待处理事件，精确协议身份变更为 0.1.0-draft.2，不将 r1 自动视作兼容。schema-source.py 是生成正本；schema.json 和 methods.json 必须重新生成。方法包装保留原 schema 的 required、可选字段和条件约束，不能因增加 Context 丢失结果限制。

[validate.mjs](validate.mjs) 校验结构、方法参数/结果、样例请求摘要、固定关系正反例、文档链接和签署输入摘要。关系谓词只检查示例之间的已声明绑定，不实现 Runtime，不证明身份认证、授权有效期、写者锁、持久化、实际时序或完整 RFC 8785 符合性。具体结果和输入摘要见 [validation.json](validation.json)。所有跨语言、操作系统、生产 Host 和 HarnessPlane gate 保持 NOT RUN；协议冻结保持 NOT APPROVED。

两张架构图继续使用 Mars 选定的 diagram-design 默认白灰橙配色，展示 PendingItem、执行策略、双向证据/决定查询及升级屏障职责；完整方法目录和时间顺序仍以正文与本修订示例为准。图稿源、可编辑副本和渲染检查见[图稿说明](diagrams/README.md)。
