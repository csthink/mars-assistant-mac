# mars-assistant-mac

[![CI](https://github.com/csthink/mars-assistant-mac/actions/workflows/ci.yml/badge.svg)](https://github.com/csthink/mars-assistant-mac/actions/workflows/ci.yml)

Assistant 的 macOS 客户端，应用显示名为「青鸾」（英文名 Qingluan，用于应用包与安装包文件名）。Assistant 是面向个人使用的桌面助手与工作台：用户向 Assistant 这个统一沟通对象提出目标、查看进度、作出决定，并在工作台里使用和继续修改成果。本仓是它在 macOS 上的实现，使用 Electron、React、TypeScript 与 SQLite。

客户端同时承担 Runtime Host 职责：从本地导入的扩展运行包以受监督子进程运行，按 [Runtime Contract 0.1.0](contract/0.1.0/) 与客户端通信。[HarnessPlane](https://github.com/csthink/mars-assistant-harness-plane) 的 serve-stdio 入口实现同一份 Contract。

## 功能

| 能力 | 当前代码提供的行为 |
| --- | --- |
| 双入口 | 主窗口与菜单栏面板读取同一份业务状态；关闭主窗口不退出应用，完整退出前对未保存的草稿与进行中的回合给出确认 |
| 模型连接 | 四家模型厂商 API 预设（智谱 GLM、DeepSeek、OpenRouter、SiliconFlow）与任意 Chat Completions 兼容的自定义提供方；API key 经 macOS safeStorage 加密后保存在独立的密钥 vault |
| 本地 Agent | 连接本机已安装的 Claude Code 与 Codex，复用它们自己的登录；推理强度档位从当次安装读回 |
| 对话 | 流式回答、停止、运行记录、待处理事项与重试；标题本机自动生成；Command + K 本地全文搜索与消息定位 |
| 选定资料 | 添加文本、Markdown、含文本的 PDF 与 PNG/JPEG，保存所选版本的副本，受限提取正文后随消息发送；访问权限可查看与撤销 |
| 控件 | 控件包校验与隔离预览：每个控件实例运行在独立的受限视图中 |
| 扩展 | 导入扩展运行包，核验签名、清单与兼容性后启动；显示运行状态、健康检查与运行诊断；管理扩展对项目资源的授权 |
| 执行端口 | 扩展 Runtime 经 Contract 请求执行本地 Agent（Claude Code 作为 Implementer、Codex 作为 Reviewer）；客户端负责进程身份、预算止损与停止 |
| 项目工作台 | 以本机文件夹建立项目：名称与目标可编辑，同名项目按身份区分；归档与取消归档立即生效，可在提示中撤销；不提供删除。创建只做只读的目录与 Git 信息核对，不修改文件夹，也不启动任何任务。项目有独立对话，可为实施者（Claude Code）与评审者（Codex）两个执行角色选择模型与推理强度。经仓库治理接入（登记文件夹、打开项目范围、逐项核对后授权扩展访问、关联项目）后，项目详情显示领域 Runtime 提供的当前阶段、任务清单、可用操作、Trace、流程拓扑与产物；需要人工决定的操作先展示候选与必读证据，确认后才发送；发布、合并结果与关闭是各自独立的操作，关闭不代表交付完成；项目内与全局待处理共享同一事项；任务被接纳还是被拒绝以 Runtime 的正式记录为准 |

界面中尚未接通的入口以禁用状态或「尚未提供」显示，不代表已经可用。

## 运行环境

- Apple silicon（arm64）上的 macOS。启动客户端或运行 Electron 测试需要已登录的图形会话。
- Node.js 版本见 [`.nvmrc`](.nvmrc)，npm 11（见 `package.json` 的 `engines`）。构建与服务层测试使用这份 Node.js；应用运行使用 Electron 自带的 Node.js。
- Xcode Command Line Tools：构建时用 `/usr/bin/clang` 编译进程身份辅助程序，用 `/usr/bin/clang++` 与当前 Node.js 安装目录的 `include/node` 头文件编译菜单栏面板的鼠标事件模块。
- `python3`：集成测试中的一个 fake Runtime 用 Python 实现，以 `python3` 启动。
- 扩展运行包的清单只接受 `darwin-arm64` 平台。测试用 fake 运行包声明的最低系统版本是 macOS 26.6.2，在更早的系统上相关用例会把运行包判为版本不兼容。

依赖与 Electron 版本由 [`package-lock.json`](package-lock.json) 固定。

## 快速开始

```bash
git clone https://github.com/csthink/mars-assistant-mac.git
cd mars-assistant-mac
./tools/install-hooks.sh
npm ci
npm exec --no -- install-electron
```

`tools/install-hooks.sh` 安装 pre-commit hook（幂等，只需一次），见 [CONTRIBUTING.md](CONTRIBUTING.md)。锁定的 Electron 包采用延迟下载：`npm ci` 之后用 `install-electron` 下载应用二进制并完成完整性校验，这一步需要网络。桌面测试直接启动项目中的 Electron，不需要另外安装 Playwright 浏览器。

启动客户端时指定一个独立的数据目录（绝对路径，首次使用时应为空目录）：

```bash
mkdir -p "<数据目录>"
npm start -- --data-root="<数据目录>"
```

`npm start` 先构建再启动，不监视源码；改代码后退出应用再运行一次。不带 `--data-root` 时使用默认业务目录 `~/Library/Application Support/csthink-assistant`，同级目录见下表；开发与测试不要使用默认目录。

### 数据目录

| 指定 `--data-root` 时 | 默认（`~/Library/Application Support/` 下） | 内容 |
| --- | --- | --- |
| `<数据目录>/` | `csthink-assistant/` | 业务数据库与事务文件、资料副本（`attachments/`）；只能整体备份，不能只复制单个文件 |
| `<数据目录>-shell/` | `csthink-assistant-shell/` | Chromium 缓存与会话数据，与业务数据分离 |
| `<数据目录>-vault/` | `csthink-assistant-vault/` | 加密后的密钥；解密依赖本机 Keychain，换机器后需要重新填写 |
| `<数据目录>-runtimes/` | `csthink-assistant-runtimes/` | 已导入的扩展运行包（`packages/`）与实例运行目录（`instances/`） |
| `<数据目录>-executions/` | `csthink-assistant-executions/` | 执行端口的 Host 证据与执行会话目录 |

同一数据目录只能被一个进程打开。目录不存在、混入其他文件、数据库身份不兼容或已被占用时，应用拒绝打开，不会改用另一个空目录。访达写入的 `.DS_Store` 与本应用文件的 AppleDouble 文件（`._` 前缀）不算其他文件，应用不读取也不删除它们。打开较旧的数据版本前，应用在数据目录同级建立完整的升级前备份；旧版本客户端拒绝写入新版本数据库。

## 常用命令

命令定义以 [`package.json`](package.json) 为准。

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 编译到 `dist/`：两个原生组件、主进程与业务服务及各 worker 的打包、界面打包、Tray 图像 |
| `npm start` | 先构建再启动客户端 |
| `npm run check` | TypeScript 类型检查（`typecheck`）、ESLint（`lint`）与 Prettier 格式检查（`format:check`） |
| `npm run test:service` | 服务层与主进程模块的单元测试，Node.js test runner 运行，不启动 Electron；本身不构建，部分用例调用 `dist/` 下的构建产物，先运行 `npm run build` |
| `npm run test:integration` | 构建后启动真实 Electron：preload、主进程与业务服务之间的命令校验、保存确认与失联重连，以及 Runtime Host 接入两个 fake Runtime 的场景与 Contract 覆盖报告 |
| `npm run test:desktop` | 构建后启动真实 Electron，验证导航、Tray 图像、草稿、窗口生命周期、故障恢复、资料选择与预览等界面行为 |
| `npm run test:native` | 原生桌面测试：可见窗口的焦点切换与跨应用失焦，会占用前台桌面 |
| `npm run test:real` | 真实提供方与本地 Agent 验证，见下文 |
| `npm run package:mac -- --out=<新输出目录>` | 构建本机应用包 `Qingluan.app`（ad-hoc 签名）；输出目录已存在时拒绝覆盖，可加 `--data-root=<绝对目录>` 固定数据目录 |
| `npm run package:trial` | 构建试用安装包：`dist/trial/` 下的 arm64 `.dmg` 与同名 `.json` 元数据（版本、SHA-256、最低系统版本），见「试用安装包」 |

## 测试

| 层 | 入口 | 匹配的文件 | 进入 CI |
| --- | --- | --- | --- |
| 服务层 | `npm run test:service` | `package.json` 中列出的 `tests/desktop/*.test.ts` | 是 |
| 集成 | `npm run test:integration` | `tests/desktop/*.integration.ts` | 否，本机运行 |
| 桌面 | `npm run test:desktop` | `tests/desktop/*.spec.ts`，不含 `real-*.spec.ts` | 否，本机运行 |
| 原生 | `npm run test:native` | `tests/desktop/*.native.ts` | 否 |
| 真实调用 | `npm run test:real` | `tests/desktop/real-*.spec.ts` | 否 |

Playwright 的项目划分与并行度见 [`playwright.config.ts`](playwright.config.ts)：桌面测试在 4 个 worker 进程中并行运行，同一个测试文件在一个 worker 内按顺序执行，每个用例使用自己的临时数据目录；集成、原生与真实调用测试串行运行；服务层测试逐文件串行。服务层、集成与桌面三层离线运行：模型请求发往绑定 `127.0.0.1` 的模拟提供方，本地 Agent 由测试夹具代替，不需要真实账户或密钥。集成与桌面两层启动真实 Electron，需要已登录的图形会话，不在 CI 中运行，开 PR 前须在本机全部通过（见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

定向运行时先构建，再指定项目与文件；直接调用 `playwright test` 时总是带 `--project`：

```bash
npm run build
npm exec --no -- playwright test --project=desktop tests/desktop/search.spec.ts
```

报告默认写入 `test-results/`，可用 `CSTHINK_TEST_REPORT`（JSON 报告文件）与 `CSTHINK_TEST_OUTPUT_DIR`（截图与 trace 目录）改到别处；测试数据写入 `.test-data/disposable/`。这两个目录都被 `.gitignore` 排除，测试报告与运行记录不提交到本仓。

`real-*.spec.ts` 会向真实模型提供方和本机 Agent 发起调用，可能产生费用。它们只在显式设置 `CSTHINK_REAL_CALLS_AUTHORIZED=1` 与各用例所需的数据目录、模型等环境变量时运行；其中读取既有证据输入的用例通过 `CSTHINK_REAL_EVIDENCE_ROOT` 定位仓外的证据目录，未设置即拒绝运行。它们不属于常规检查，也不进入 CI。

## 目录结构

```
mars-assistant-mac/
├── src/
│   ├── main/            Electron 主进程：窗口与菜单栏面板、preload、密钥 vault、模型传输、本地 Agent 连接、
│   │                    Runtime supervisor 与 Runtime Host、执行端口、控件视图，以及两个原生组件的源码
│   ├── service/         业务服务（SQLite 唯一写者）、资料提取 worker、搜索 worker
│   ├── renderer/        React 界面：主窗口与菜单栏面板共用
│   └── shared/          主进程、业务服务与界面共享的类型、协议与校验
├── tests/desktop/       各层测试与夹具；runtime-fakes/ 是两个领域的 fake Runtime 与运行包构建工具
├── contract/0.1.0/      Runtime Contract 0.1.0 的冻结副本：contract-manifest.json 与它列出的 13 个文件（schema.json、methods.json、示例、说明、修订记录、release-record/）
├── assets/icon/         应用图标与菜单栏模板图，见 assets/icon/README.md
├── scripts/             build.mjs、package-macos.mjs、package-smoke.mjs、execution-audit.mjs、runtime-host-coverage.mjs
├── tools/               check-public-safety-generic.sh、install-hooks.sh、public-safety-allowlist.txt
├── docs/                architecture.md
├── .github/workflows/   ci.yml
└── package.json · package-lock.json · tsconfig.json · eslint.config.js · playwright.config.ts · .nvmrc · .gitignore
```

`dist/`、`node_modules/`、`test-results/` 与 `.test-data/` 是生成内容，不手改、不提交。`contract/0.1.0/` 的 14 个文件是冻结版本的逐字节副本，不在本仓修改。

诊断工具：

- `node scripts/execution-audit.mjs --data-root <数据目录>`：按 Contract schema 校验执行端口的执行记录，并从 transcript 与结果文档重算工具调用数、输出字节、运行时长等核算字段逐项比较。
- `node scripts/runtime-host-coverage.mjs --transcripts <目录> --out <报告文件>`：逐帧校验 Host 与 Runtime 之间的协议记录，统计方法与错误码的覆盖。协议记录由 `npm start -- --data-root=<数据目录> --runtime-transcripts=<绝对目录>` 写出，含双向的全部协议帧，只用于测试与诊断。

## 试用安装包

`npm run package:trial` 在 Apple silicon 的 macOS 上构建试用安装包 `Qingluan-<版本>-arm64.dmg`。盘内是 `Qingluan.app`、指向「应用程序」文件夹的链接与快捷方式「打开隐私与安全性」（`x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension`，只打开该设置页）；窗口背景（`assets/dmg/`，1x 与 2x）画出拖入方向，并用中英文写明首次打开被拦截时的放行步骤。窗口布局由构建依赖 dmgbuild 直接写入 `.DS_Store`，不驱动访达；它按 `scripts/dmg-requirements.txt` 固定版本与哈希，每次构建时装进临时虚拟环境、用完删除（需要 `python3` 3.10 或更新版本与网络）。

| 项目 | 内容 |
| --- | --- |
| 架构与系统 | 只有 arm64；`LSMinimumSystemVersion` 为 26.6.2 |
| 名称 | 界面只有中文，名称无论系统语言都显示「青鸾」：应用包里每个 `.lproj` 的 `InfoPlist.strings` 都写「青鸾」，`CFBundleDevelopmentRegion` 为 `zh_CN`；窗口标题、侧栏标题、应用菜单、菜单栏图标提示与关于面板取自 `src/shared/app-name.ts`。英文名 `Qingluan` 只用于应用包与安装包文件名（`Info.plist` 的基础值与文件名一致，访达据此显示本地化名称） |
| 不变的身份 | bundle id `com.csthink.assistant`；内部应用名 `csthink-assistant`（`app.setName`），因此「数据目录」一节的默认目录与 safeStorage 的钥匙串项（服务名 `csthink-assistant Safe Storage`）都不随显示名改变 |
| 签名 | 由内向外的 ad-hoc 签名，`codesign --verify --deep --strict` 通过；没有 Developer ID 签名与 Apple 公证，Gatekeeper 评估（`spctl`）会拒绝 |
| 图标 | `assets/icon/`：`AppIcon.icns`（打包时由 PNG 组生成）与 macOS 26 起使用的分层图标 `Assets.car`；主窗口窄列的产品标识是同一图标的 32 像素简化版 |

从网上下载的副本第一次打开会被系统拦下：首次打开如被系统拦截，打开「系统设置 → 隐私与安全性」，在「安全性」一栏点「仍要打开」，放行一次即可，不需要也不应该关闭 Gatekeeper。每个新版本的 ad-hoc 签名都不同，升级后第一次使用已保存的 API key 时，macOS 可能请求允许访问钥匙串项；拒绝时密钥无法解密，需要在设置中重新填写。

`node scripts/package-smoke.mjs --phase seed|verify --dmg <dmg>`（或 `--app <应用包>`）在后台核对安装包：从只读挂载的磁盘映像复制应用，在独立的 HOME（自带临时钥匙串）与独立的 Application Support 中启动，不出现在程序坞与菜单栏、不取得焦点；`seed` 写入一个对话、草稿、经产品 vault 保存的合成 API key、引用它的提供方与外观设置后正常退出，`verify` 在同一目录用另一个构建启动并逐项比较读回结果、vault 文件字节与钥匙串项名称。两次运行加 `--work <同一目录>`。

## 文档

- [docs/architecture.md](docs/architecture.md)：进程划分、模块与依赖方向、数据归属、Runtime Host 与执行端口的设计理由
- [CONTRIBUTING.md](CONTRIBUTING.md)：硬性约束、本地检查、提交前扫描与改动检查清单
- [contract/0.1.0/](contract/0.1.0/)：Runtime Contract 0.1.0 的机器可读文件
- [HarnessPlane](https://github.com/csthink/mars-assistant-harness-plane)：遵循同一 Runtime Contract 的领域 Runtime

## 许可

本仓暂未授予开源许可（仓内没有 `LICENSE` 文件）。试用安装包经本仓的 GitHub Release 发布。
