# 架构说明

本文说明 Assistant macOS 客户端的进程划分、源码模块与依赖方向、数据归属，以及它作为 Runtime Host 接入领域 Runtime 的方式和设计理由。命令与运行环境见 [README](../README.md)，改动约束见 [CONTRIBUTING](../CONTRIBUTING.md)。

## 定位与边界

Assistant 是面向个人使用的桌面助手与工作台。本仓是它的 macOS 客户端，使用 Electron、React、TypeScript，业务状态保存在 SQLite（Node.js 内置的 `node:sqlite`）。

客户端有两类职责：

- 产品自身的功能：对话、模型连接、选定资料、控件、项目组织、待处理事项与运行记录、设置。这些数据只由客户端的业务服务写入。
- Runtime Host（下文简称 Host）：通用的扩展接入、进程监督、资源授权与展示。领域的流程、任务状态和证据由领域 Runtime 维护，Host 只向 Runtime 请求领域 action，不写 Runtime 的领域正本。

| 对象 | 由谁维护 | 客户端的角色 |
| --- | --- | --- |
| 对话、控件、草稿、项目组织记录、授权、资源登记、扩展安装记录、物理执行记录 | 客户端业务服务 | 唯一写者 |
| 领域对象、合法 action、操作结果、领域证据 | 领域 Runtime | 请求 action，缓存可重建的 projection |
| 本地 Agent 的登录与原生会话历史 | Claude Code、Codex 自身 | 复用登录，不读取或复制凭据 |

Host 与 Runtime 之间的协议是 Runtime Contract 0.1.0，本仓在 [`contract/0.1.0/`](../contract/0.1.0/) 内嵌它的冻结文件：`contract-manifest.json` 与它列出的 13 个文件。[HarnessPlane](https://github.com/csthink/mars-assistant-harness-plane) 的 serve-stdio 入口实现同一份 Contract。

## 进程划分

| 进程 | 源码入口 → 构建产物 | 职责 |
| --- | --- | --- |
| 主进程（桌面宿主） | `src/main/index.ts` → `dist/main.cjs` | 窗口与菜单栏面板、Tray、单实例与数据目录锁、文件选择、密钥 vault、模型 HTTPS 传输、本地 Agent 连接、Runtime supervisor 与 Host 服务、执行端口、控件视图管理 |
| 业务服务 | `src/service/entry.ts` → `dist/service.cjs` | 由主进程以 Electron utilityProcess 启动；SQLite 唯一写者，负责回合、运行事件、待处理事项、控件、权限判定、扩展安装与执行记录，以及数据版本迁移 |
| 资料提取 worker | `src/service/extract.ts` → `dist/extract.cjs` | 业务服务内的 worker 线程；提取文本、Markdown 与 PDF 的正文（PDF 经 PDF.js），内存上限与时限由业务服务从外部施加 |
| 搜索 worker | `src/service/search-worker.ts` → `dist/search-worker.cjs` | 主进程内的 worker 线程；以只读方式打开数据库查询 FTS5 索引 |
| 控件包构建 worker | `src/main/widget-build-worker.ts` → `dist/widget-build-worker.cjs` | 主进程内的 worker 线程；校验并构建控件包，不执行包内代码 |
| 可信界面 | `src/renderer/index.tsx` → `dist/renderer.js`；preload `src/main/preload.ts` | 主窗口与菜单栏面板各一个 renderer，共用同一界面包 |
| 控件视图 | `src/main/widget-runtime.ts`；preload `src/main/widget-preload.ts` | 每个控件实例一个 WebContentsView |
| 产品 MCP 进程 | `src/main/claude-mcp.ts` → `dist/claude-mcp.cjs` | 为 Claude Code 受限会话提供经授权的资料读取；启动器清空其环境变量 |
| 进程身份辅助程序 | `src/main/codex-process.c` → `dist/codex-process` | 读取并核对子进程身份（PID、UID、内核启动时间、可执行映像、session），按身份发信号 |
| 面板事件模块 | `src/main/panel-events.mm` → `dist/panel-events.node` | 监听菜单栏面板外的鼠标点击，用于失焦收起 |
| 领域 Runtime | 导入的扩展运行包 | 每个资源范围一个受监督子进程，经 stdio 与 Host 通信 |

worker 与独立进程主要承担响应性、崩溃处理和资源控制。隔离边界由各自的配置提供：界面与控件视图依靠 Chromium 沙箱和受限桥接，外部程序依靠固定的启动参数、环境允许列表与身份核对。

## 源码模块与依赖方向

```
src/renderer ──┐
src/main ──────┼──►  src/shared
src/service ───┘
```

| 目录 | 允许导入 | 不允许 |
| --- | --- | --- |
| `src/shared/` | 只导入 `src/shared/` 内的模块 | Electron、Node.js 内置模块、其他三个目录 |
| `src/service/` | `src/shared/`、Node.js 内置模块（`node:sqlite`、`node:worker_threads` 等） | Electron、`src/main/`、`src/renderer/` |
| `src/renderer/` | `src/shared/`、React | Node.js、Electron、`src/main/`、`src/service/` |
| `src/main/` | `src/shared/`、Electron、Node.js 内置模块 | `src/service/`、`src/renderer/` |

三个运行侧之间不互相导入源码，只通过消息通信：

- 界面到主进程：preload 用 `contextBridge` 暴露固定方法，主进程以 `ipcMain.handle` 按实际发送方处理。界面窗口启用 `sandbox` 与 `contextIsolation`，关闭 Node.js 集成。
- 主进程到业务服务：utilityProcess 消息。业务服务就绪时回送完整快照，之后推送更新；主进程每秒发送心跳。
- 共享的类型、协议与校验只放在 `src/shared/`，三侧各自引用同一份定义。

业务服务与 `src/shared/` 不导入 Electron，因此服务层测试可以直接用 Node.js 运行。

## 数据与状态

- 业务数据目录内是 `state.sqlite`（WAL、`synchronous=FULL`、外键约束）与 `root-lock.sqlite`（数据目录独占锁），资料副本在 `attachments/`，按内容摘要命名、只读保存。搜索索引是同一数据库中的 SQLite FTS5 表，由业务服务在同一事务中更新。
- 主进程注册单实例入口，业务服务再对解析后的数据目录取得独占锁，防止不同启动参数绕过单实例检查。
- 业务服务是唯一写者，提交短事务；模型执行与等待授权不占用事务。业务服务失联时界面进入只读并提供重新连接入口，不启动第二个写者；重新连接后读取完整快照。
- 打开较旧的数据版本前，业务服务在数据目录同级写出升级前备份：SQLite 快照（含已提交的 WAL 内容）与全部资料副本，外加记录旧版本与文件摘要的 `complete.json`。快照校验失败时停止升级、保留原数据库。
- 密钥不进业务数据库。API key 经 macOS safeStorage 加密后保存在数据目录同级的 vault 目录，业务数据只保存随机引用；传输层每次请求时读取，不写日志。
- Chromium 缓存、扩展运行包、执行证据分别放在数据目录同级的 `-shell`、`-runtimes`、`-executions` 目录，业务数据目录内不混入其他内容。

## 双入口

主窗口与菜单栏面板是同一份业务状态的两个展示入口，由同一个界面包以不同的入口参数渲染。对话、输入草稿与控件数据属于业务服务，不随窗口销毁；两个入口各自持有可见状态。关闭主窗口保留 Tray，进行中的回合继续执行。完整退出前，未保存的草稿或进行中的回合会先给出确认；选择停止并退出时，先请求停止本应用启动的回合并等待确认，时限内未确认的执行记为已中断，重启后可在待处理中重试或忽略。

## 模型连接与本地 Agent

- 模型厂商 API：主进程的 HTTPS 传输（`src/main/transport.ts`）按 Chat Completions 形式发送请求，请求只发往该连接的 Base URL。预设地址只用于预填新连接，不覆盖已保存的地址。
- 本地 Agent：客户端在 PATH、Homebrew、用户 bin 与常见 Node.js 版本管理器中发现 Claude Code 与 Codex，复用它们自己的登录，不读取或复制登录凭据，也不把订阅登录转换为 API key。连接时在临时 HOME 与本地模拟接口中核对工具集合，不调用真实模型。产品会话禁用个人 MCP、插件等未开放的出口；Codex 的个人规则只在用户确认后随对话发送，Claude Code 的个人 hooks 与个人规则不加载。
- 版本号只用于诊断。连接以实际读回的协议、模型、推理强度档位和权限能力为准，不按版本白名单判断；读回与预期不符时以明确错误失败，不静默改用其他 Agent 或模型。
- 停止只作用于本应用启动并按身份登记的进程，不按进程名结束用户在终端里运行的 Agent。

## 控件隔离

- 控件包包含规范版本、显示名称、HTML/CSS/JavaScript 视图、配置与能力声明及本地资源清单；内容版本按不可变产物保存，稳定的控件身份由产品分配。包校验在 worker 线程内进行，不执行包内代码。
- 每个控件实例运行在独立的 WebContentsView 中，使用各自的 session 分区（不启用缓存）。视图启用 `sandbox` 与 `contextIsolation`，关闭 Node.js 集成、webview、插件、下载、设备权限、对话框与开发者工具，只加载该版本登记过的包内资源。
- 控件只能调用 `src/main/widget-preload.ts` 暴露的固定方法。宿主根据实际发送方与实例登记表确定控件身份、内容版本和运行代次，拒绝其他 frame、过期实例与伪造标识。控件拿不到宿主数据库与密钥。
- 授权记录（对话中的资料读取授权与扩展对项目资源的授权）都由业务服务持久保存，撤销以持久记录为准。

## Runtime Host

### 导入与准入

扩展运行包从本地目录导入，目录包含 `bundle.tar`（ustar）、`release.json`（发布记录）、`release.sig`（对发布记录原字节的 Ed25519 签名）与 `publisher.pub`（SPKI PEM 公钥）。准入按固定顺序核验：签名、发布者密钥（同一 runtimeId 首次导入后固定）、archive 摘要、逐文件清单、manifest、`launch.json` 启动配置与包内能力 schema。任一项失败即显示原因码，不解开运行包。身份核验通过但平台、系统版本、协议版本、依赖或启动器不匹配时记为「版本不兼容」，不启动。

启动器有三种：`direct`、`electron-node`（以客户端自身的 Electron 可执行文件作为 Node.js 运行）与 `python3`（按 PATH 与常见安装位置解析，按摘要固定所选程序）。

### 监督与连接

Runtime supervisor 以受监督子进程启动运行包入口：环境变量只含固定允许列表，连接参数只经 argv 模板中的占位符传入。Host 与 Runtime 通过双向 stdio 上的 JSON-RPC 通信，没有监听端口；实例与连接身份由实际进程句柄和启动记录绑定，不采信消息中的自报身份。

连接建立后完成 `runtime.initialize` 与 `runtime.ready` 协商，之后每 30 秒执行一次 `runtime.health`。进程退出或应答超时显示「连接异常」；重新连接建立新的 incarnation 与 connection，先显示「待核实」，projection 追上后才回到「可用」。

Runtime 与本地 Agent 以当前 macOS 用户身份运行。Host 核对它们的安装身份、启动参数与授权；进程划分用于职责与身份边界，不作为操作系统级隔离。

### 授权、projection 与操作

- 资源授权：Host 登记资源身份，经 `runtime.scope.open` 绑定 scope，建立授权后以 `runtime.scope.authorize` 激活。撤销在业务服务持久记录时生效，之后的受控调用得到 `PERMISSION_REVOKED`；重新授权建立新的授权引用，不恢复旧记录。
- projection：Host 按快照分页读取领域状态、订阅事件并确认，保存的是可重建的缓存；领域正本始终在 Runtime。同一连接对同一 scope 只保持一条活动订阅。
- 操作：Host 先在业务服务中持久化操作与请求，再发送给 Runtime。需要人工决定的动作只能经主进程的可信入口建立决定记录，记录与待发送请求在同一事务提交后才发送。Host 与 Runtime 之间没有共同事务，结果不明时如实记录，恢复时从正式记录继续并查询领域事实，不重放操作。

Host 服务（`src/main/runtime-host.ts`）只保留每个连接的同步状态，持久事实都经业务服务写入。

## 执行端口

领域 Runtime 需要运行本地 Agent 时，通过 Contract 的 `host.execution.preflight`、`host.execution.start`、`host.execution.get`、`host.execution.cancel` 请求 Host 执行。客户端内置的执行端口（`src/main/execution-port.ts`）是该请求唯一的物理执行写者。

- 放行次序：预约已持久化 → 独占创建共享观察记录 → 创建尚未放行的目标进程 → 读取并固定真实身份 → 放行执行。目标进程以自己的 session 与进程组领导者身份启动，在向其 stdin 写入第一个字节之前，由进程身份辅助程序读取并固定 PID、UID、内核启动时间、可执行映像与 session。身份不符不放行；放行前退出记为 unknown。
- 共享观察记录写在目标资源的 Git common directory 下 `harness/executions/<请求 ID>/`，seq 递增、原子替换；资源不是 Git 仓库时写在数据目录同级的 `-executions/records/`。
- 预算与停止：请求给出的 `maxRunSeconds`、`maxOutputBytes`、`maxToolCalls` 在运行中核算，超出时按身份停止目标（先发 SIGTERM，清理时限内未退出再发 SIGKILL），停止原因分别记为 `timeout`、`output-limit`、`tool-call-budget`。取消先持久化请求，再由适配器做原生中断。每个信号前都核对身份，身份不符即拒发并记入台账。
- 终态：completed、failed、stopped（带停止原因）、unknown。退出分类区分正常退出、信号退出、僵尸待回收、观察被拒绝、PID 复用、观察器失联与尚存子进程；单独一项证据不算退出。
- 停止未确认：目标已退出而登记的后代进程逃逸到目标 session 之外仍存活时，Host 不向 session 外的进程发信号，记录「停止未确认」并建立待处理事项，期间阻止释放资源、切换入口、升级扩展与更新应用；主进程持续观察，逃逸进程全部退出后自动改为已停止。
- 适配器：Claude Code 以 print 模式作为 Implementer（`src/main/execution-claude.ts`），工具只有 Read、Edit、Write，MCP、hooks 与插件关闭；Codex 以 app-server 的临时线程作为 Reviewer（`src/main/execution-codex.ts`），权限档案只读、网络关闭，只接受一次对材料目录的只读批准请求。每次启动前重新读取当次安装的帮助文本、配置与登录，启动后读回的工具集合或权限模式不符即停止并记为失败。profile 摘要绑定策略字节（参数模板、会话设置、固定文本、环境允许列表、权限档案），不绑定程序身份；本地 Agent 升级后 profile 不变，程序身份按当次安装重新读取。
- Host 证据（结果文档与脱敏 transcript）写在 `-executions/evidence/<执行引用>/`。`scripts/execution-audit.mjs` 按 Contract schema 校验记录，并从各自唯一的来源重算核算字段逐项比较。

## 项目工作台

项目把本机的一个文件夹、一段目标、独立的项目对话与领域 Runtime 提供的工作组织在一起。项目组织（项目记录、项目与 scope 的关联、项目对话与每个回合的项目上下文、执行角色的选择）由客户端业务服务保存；阶段、任务、合法操作、决定与领域证据仍由领域 Runtime 提供，客户端不重建领域流程，也不从按钮文案或本地状态推断结果。

| 模块 | 职责 |
| --- | --- |
| `src/main/projects.ts`、`src/service/projects.ts` | 项目的创建、编辑、归档与撤销。主进程经系统目录选择取得文件夹，只把绑定发起窗口、限时、一次有效的随机选择令牌交给界面，界面不能提交任意路径；保存前重新核对目录与 Git 仓库的身份，目录消失、被替换或符号链接改向即拒绝。Git 信息用固定的 `git` 程序与参数只读探测，不经 shell、不运行仓库脚本与 hooks，只读取仓根、common directory 与仓库本地配置中的远程；远程地址中的用户信息、查询参数与片段不保存、不显示。业务服务在事务内写项目记录，归档与取消归档同时写一次有效、有期限的撤销记录 |
| `src/main/project-access.ts` | 仓库治理接入，按登记项目文件夹、打开项目范围（scope）、授权扩展访问、关联项目内容四步进行，每一步先重核文件夹身份并读取当前记录，失败或取消保留原状。授权前列出主体、对象范围、协商通过的能力、操作与期限供核对；确认请求携带核对内容的摘要，主进程按当前记录重建并比较，一致才在一个事务内写入整批授权，再请求 Runtime 激活，Runtime 拒绝时整批撤回 |
| `src/main/project-work.ts`、`src/service/project-work.ts` | 项目工作区：项目与 scope 的关联（一个 scope 只关联一个项目）、实施者（Claude Code）与评审者（Codex）两个执行角色的模型与推理强度、项目对话与每个回合的项目上下文。对话默认只带项目名称与目标，用户显式选择的领域对象才加入上下文，浏览不改变上下文；发送前再核对授权，撤销授权后不按旧快照继续发送 |
| `src/main/project-actions.ts` | 项目操作的可信入口。准备时固定用户看到的动作、对象修订、候选、必读证据与授权集合，返回绑定窗口、限时的确认令牌；提交前逐项复核，任一项变化即拒绝，不用最新候选替换旧确认。操作输入表单只由已签名运行包内、当前协商且摘要匹配的 schema 生成，不支持的 schema 构造明确拒绝，不下载 schema、不执行脚本 |
| `src/main/project-evidence.ts` | 证据与产物的只读入口：界面只提交项目、对象修订与对象内的证据位置，主进程从当前 projection 定位固定引用，经 Host 分块读取并核对偏移、长度与完整摘要；文本转义显示，HTML 按源码显示，不执行内容 |
| `src/renderer/projects.tsx`、`project-*.tsx` | 项目列表与详情、执行角色、仓库治理接入、项目对话、项目操作、证据阅读、项目内待处理与本地布局（Trace、流程拓扑、全屏与对话停靠）的界面 |

数据流：

- 读取：项目详情经主进程读取所关联 scope 的 projection，只显示 Runtime 提供的对象、标题、状态、列表与动作，不推断阶段数或任务数。Runtime 失联、授权失效或 projection 落后时保留最后已知内容，并停用依赖当前授权的动作。
- 决定与操作：同一事项在项目内与全局待处理两处打开时读取同一 projection 条目，共用同一确认表单与操作幂等记录。确认后 Host 先持久化操作与决定记录，再向 Runtime 发送 action；同一确认重复提交只得到同一结果，应答丢失或重启后的未决操作只提供查询，不自动重发。操作已成功而 projection 尚未追上时，该对象显示「同步中」并停用其上的动作，可请求 Runtime 重新发送完整快照。
- 发布与关闭：发布授权、发布、合并结果读取与关闭各是独立的 Runtime action，一项成功不推定下一项成功；关闭不表示交付完成。
- 接纳与拒绝：任务被接纳、被拒绝以及领域状态的变化以 Runtime 的正式记录为准；客户端显示 Runtime 读回的结果与 Host 的物理执行事实，两者各自保留来源与时间，不合成结论。

## 构建与打包

`scripts/build.mjs` 依次完成：

1. 在 macOS 上用 `/usr/bin/clang` 编译进程身份辅助程序，用 `/usr/bin/clang++` 以当前 Node.js 的头文件编译面板事件模块（AppKit）。
2. esbuild 打包主进程、业务服务、各 worker、preload 与产品 MCP 进程（目标 `node24`，输出 `.cjs`），以及界面（目标 `chrome144`）。
3. 复制 `index.html`、PDF.js 的 worker 模块与 `assets/icon/` 下 1x 与 2x 的菜单栏模板图 PNG。

`scripts/package-macos.mjs` 用 `@electron/packager` 生成应用包 `Qingluan.app`，注册对话链接协议 `csthink-assistant`；输出目录已存在时拒绝覆盖。显示名只在应用包这一层本地化（`LSHasLocalizedDisplayName` 与 `zh_CN.lproj`、`en.lproj` 的 `InfoPlist.strings`），主进程的 `app.setName("csthink-assistant")` 决定默认数据目录与 safeStorage 钥匙串项的名称，二者都不随显示名改变；窗口与菜单上的名称由 `src/shared/app-name.ts` 按应用语言取「青鸾」或「Qingluan」。打包后由内向外做 ad-hoc 签名；`--dmg` 另用 `hdiutil` 生成 arm64 磁盘映像与元数据。`scripts/package-smoke.mjs` 经 Node inspector 在打包产物里安装与后台测试相同的隔离后启动它，核对读回与升级。

## 测试结构

| 层 | 运行方式 | 覆盖 |
| --- | --- | --- |
| 服务层 | Node.js test runner 加 tsx，逐文件串行 | 业务服务、存储与迁移、vault、传输、本地 Agent 协议、Runtime 准入与帧、执行端口等模块 |
| 集成 | Playwright 启动真实 Electron，串行 | preload、主进程与业务服务的命令路径；Host 接入列表领域（TypeScript，`electron-node` 启动器）与 Coding 图领域（Python，`python3` 启动器）两个 fake Runtime 的场景，并生成 Contract 覆盖报告 |
| 桌面 | Playwright 启动真实 Electron，4 个 worker 并行，同一文件在一个 worker 内顺序执行 | 界面行为；测试窗口透明、不取得焦点，菜单栏图标由测试替身代替 |
| 原生 | Playwright，需显式入口，串行 | 前台窗口焦点、跨应用失焦与真实菜单栏图标 |
| 真实调用 | Playwright，需显式授权，串行 | 真实提供方与本地 Agent |

前三层离线运行。服务层进入 CI；集成与桌面两层需要已登录的图形会话，在本机运行，不进入 CI；原生与真实调用两层也不进入 CI。

## 设计取舍

| 决定 | 理由 |
| --- | --- |
| Electron、TypeScript 与 React | 控件是动态生成的 HTML/CSS/JavaScript，需要统一的 Chromium 渲染与按实例独立的 WebContents；主窗口、菜单栏面板与控件视图可以分别管理。SwiftUI 加 WebKit、Tauri 2 两个备选同样需要为控件另建脚本执行边界 |
| 业务服务是 SQLite 唯一写者 | 两个入口和重启恢复需要同一个权威状态。界面进程崩溃或重载不影响已确认数据；业务服务失联时界面只读，而不是由另一个进程临时接管写入 |
| 业务服务与共享模块不依赖 Electron | 业务规则可以直接在 Node.js 中测试，服务层测试不需要启动应用 |
| 密钥放在独立 vault | 业务数据库与升级前备份只含随机引用，复制数据目录不会带出密钥；解密依赖本机 Keychain |
| 本地 Agent 复用自身登录 | 客户端不持有 Agent 的凭据；每次启动核对实际安装与读回，行为变化以明确错误呈现，而不是静默降级 |
| Host 与 Runtime 分离 | Host 只做通用接入、监督、授权与展示，领域规则留在 Runtime；一个 Host 可以接入多个领域，领域 Runtime 也可以不经 Host 独立运行 |
| 项目组织与领域工作分开保存 | 项目、对话与执行角色是客户端自己的数据；阶段、任务与决定属于领域 Runtime。项目可以不接入任何 Runtime 而只用于组织与交流，接入后也不在客户端保存第二份领域状态 |
| 跨进程不假设共同事务 | 先持久化再发送，结果不明时记为 unknown 并在恢复后查询，不自动重放可能已经产生外部影响的操作 |
| 先固定身份再放行 | 之后的每个信号都能核对身份，PID 复用时不会误发信号，用户在终端里运行的 Agent 不受影响 |
