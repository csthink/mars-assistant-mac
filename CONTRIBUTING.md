# 贡献指南

本仓是 Assistant 的 macOS 客户端。这份文档说明改动时必须守住的约束、本地怎样检查，以及提交前的扫描。运行环境与命令见 [README](README.md)，模块划分与设计理由见 [docs/architecture.md](docs/architecture.md)。

## 开始之前

```bash
git clone https://github.com/csthink/mars-assistant-mac.git
cd mars-assistant-mac
./tools/install-hooks.sh
npm ci
npm exec --no -- install-electron
```

`tools/install-hooks.sh` 安装 pre-commit hook，幂等，克隆后执行一次即可。已有不是它生成的 pre-commit hook 时，安装器不覆盖，报出路径让你人工合并。

## 硬性约束

下面几条破坏后会造成结构性返工，改代码前先确认：

| 约束 | 理由 |
| --- | --- |
| 业务状态只由业务服务（`src/service/`）写入 SQLite；主进程、界面与 worker 不直接写库 | 两个入口与重启恢复依赖唯一写者 |
| `src/shared/` 只导入 `src/shared/` 内的模块；`src/service/` 不导入 Electron；`src/main/`、`src/service/`、`src/renderer/` 之间不互相导入 | 依赖单向，服务层测试可以直接用 Node.js 运行 |
| 界面只经 `src/main/preload.ts` 暴露的固定方法与主进程通信；新增方法时主进程按实际发送方与 frame 校验，并校验参数结构 | 界面窗口运行在沙箱中，不获得 Node.js、文件或进程接口 |
| 控件视图只经 `src/main/widget-preload.ts` 的固定方法通信；不放宽其 `webPreferences`、session 与网络限制，不向控件暴露宿主数据库、密钥或任意 IPC channel | 控件是生成的代码，与可信界面隔离 |
| 密钥只经 vault 保存与读取，不写入业务数据库、日志、运行记录或测试输出 | 数据目录与备份不带出密钥 |
| 不读取、不复制本地 Agent 的登录凭据；只向本应用启动并按身份登记的进程发信号 | 复用 Agent 自身的登录；不影响用户在终端里运行的 Agent |
| `contract/0.1.0/` 的 14 个文件（`contract-manifest.json` 与它列出的 13 个文件）是 Runtime Contract 0.1.0 的逐字节副本，不在本仓修改；`src/shared/runtime-host.ts` 固定 `contract-manifest.json` 的 SHA-256，由 `tests/desktop/runtime-framing.test.ts` 核对 | 冻结的协议版本，Host 与 Runtime 两侧按同一份字节协商 |
| Host 不写领域 Runtime 的领域正本；projection 只是可重建的缓存 | 领域规则与领域状态归 Runtime |
| 常规测试离线：模型请求发往本地模拟提供方，本地 Agent 由夹具代替；真实调用只放在 `tests/desktop/real-*.spec.ts` | CI 与本地检查可重复，不需要账户与密钥 |
| 依赖在 `package.json` 写精确版本，并提交同步后的 `package-lock.json` | `npm ci` 在本机与 CI 得到同一组依赖 |

## 本地检查

提交前按 CI 的顺序跑一遍：

```bash
bash tools/check-public-safety-generic.sh
npm run check
npm run build
npm run test:service
npm run test:integration
npm run test:desktop
```

- `test:integration` 与 `test:desktop` 会先构建，再启动真实 Electron，需要已登录的图形会话；测试窗口透明、不取得焦点。
- 开发过程中只跑受影响的用例，先 `npm run build`，再用 `npm exec --no -- playwright test --project=<项目> <文件>`，总是带 `--project`。定向结果不能代替提交前的完整检查。
- 任何失败、跳过或重试都要查明原因，不以重跑通过作为结论。
- `npm run test:native` 会使用前台桌面，只在改动窗口焦点、菜单栏面板或跨应用行为时安排运行。
- `npm run test:real` 调用真实提供方与本地 Agent，需要自己的账户与显式授权的环境变量，不属于常规检查。

## 提交前扫描

本仓是公开仓。`tools/check-public-safety-generic.sh` 检查以下内容，pre-commit hook 与 CI 调用的是同一份脚本：

| 类别 | 拦截 |
| --- | --- |
| 凭据 | 带引号的凭据字面量赋值（password、passwd、secret、token、apikey、api_key） |
| 私钥 | PEM 私钥头 |
| 云凭据 | 常见云平台与代码托管平台的访问令牌形态 |
| 本机路径 | `/Users/<名>`、`/home/<名>` |
| 内网地址 | RFC 1918 私有地址 |
| 路径门 | 仓根 `records/`、`docs/tasks/evidence/`、`docs/design/evidence/`，任意层级的 `attempts/`，以及 `playwright*.json`、`report.json`、`receipt.json`、`*.tap` |

- hook 只检查本次暂存的文件，内容从索引读取，也就是真正要提交的内容。
- hook 可以被 `git commit --no-verify` 绕过，CI 会对整个索引再扫一次。
- 测试确实需要凭据形态的合成值时，在白名单 `tools/public-safety-allowlist.txt` 登记：每行一个扩展正则，对 `<相对路径>:<行内容>` 整体匹配，规则带路径前缀限定范围。扫描器默认读取这个文件，文件不存在时没有规则。路径门不受白名单影响。
- 路径门拦的是测试报告与运行记录。它们留在本机被忽略的目录（`test-results/`、`.test-data/`），不提交到本仓。
- 扫描器只能拦已知模式。内部主机名、个人信息、真实凭据、未公开的内部计划与评审结论，提交前请自己再过一遍。内容一旦推送，即使之后删除，也仍留在 Git 历史里。
- 改动扫描器本身后运行 `bash tools/check-public-safety-generic.sh --selftest`，确认每类阳性样本都能命中。

## 改动检查清单

| 改动类型 | 必须说明或验证 |
| --- | --- |
| 数据库 schema | 升级路径与升级前备份；旧版本客户端拒绝写入新版本数据库；`test:service` 的迁移用例 |
| preload 或 IPC 方法 | 发送方与 frame 校验、参数结构与长度校验；界面与控件两套桥接不混用 |
| 控件视图与控件包 | 隔离设置没有放宽；包校验不执行包内代码 |
| 模型连接与本地 Agent | 启动参数与读回核对仍然生效；读回不符时以明确错误失败；停止只作用于本应用登记的进程 |
| Runtime Host 与执行端口 | 与 `contract/0.1.0/` 一致；`test:integration` 的 Runtime Host 场景与 Contract 覆盖报告通过 |
| 构建与打包 | `npm run build` 在 macOS 上通过；`package:mac` 仍拒绝覆盖已有输出目录 |
| 依赖版本 | 精确版本、lockfile 同步、`npm ci` 可重现 |
| 测试 | 新用例离线可跑、不依赖个人数据与本机绝对路径；需要真实调用的只进 `real-*.spec.ts` |
| 用户可见的行为或命令 | 同步更新 [README](README.md) 与 [docs/architecture.md](docs/architecture.md) |

## 提交信息

提交信息只描述改动本身。
