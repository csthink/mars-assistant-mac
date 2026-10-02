# 应用图标与菜单栏模板图

本目录是应用包图标与菜单栏图标的唯一来源。替换图标时只替换这里的文件，构建与打包脚本不需要改。

| 文件 | 用途 | 使用位置 |
| --- | --- | --- |
| `source/AppIcon.iconset/` | 10 个 PNG：16、32、128、256、512 的 1x 与 2x，文件名按 `iconutil` 的要求 | `scripts/package-macos.mjs` 打包时用 `iconutil -c icns` 生成 `AppIcon.icns`，写入应用包 `Contents/Resources/` 并作为 `CFBundleIconFile` |
| `Assets.car` | 由 `source/AppIcon.icon` 编译的资源目录，含 macOS 26 起的分层图标（浅色、深色与可着色外观） | 打包时复制到 `Contents/Resources/Assets.car`，`Info.plist` 写 `CFBundleIconName = AppIcon`；没有它时 macOS 26 起会给图标加灰色底板 |
| `source/AppIcon.icon/` | Icon Composer 文档：`icon.json` 与 `Assets/` 下四个 SVG 图层 | `Assets.car` 的源文件，打包时不读取 |
| `trayTemplate.png` 与加 `@2x` 后缀的同名文件 | 菜单栏模板图，1x 为 20 × 20、2x 为 40 × 40 像素（20 pt），只有黑色与透明度，文件名以 `Template` 结尾 | `scripts/build.mjs` 复制到 `dist/`，主进程以模板图加载 |
| `source/tray-template.svg` | 菜单栏模板图的矢量源 | 构建时不读取 |

重新编译 `Assets.car` 需要 Xcode 26 或更新版本的 `actool`：

```bash
actool assets/icon/source/AppIcon.icon --compile <输出目录> --platform macosx \
  --minimum-deployment-target 12.0 --target-device mac --app-icon AppIcon \
  --output-partial-info-plist <输出目录>/partial.plist
```

同一份源文件两次编译出的 `Assets.car` 字节不同，所以编译结果作为文件提交，打包时不重新编译。`iconutil` 生成的 `.icns` 字节稳定，所以只提交 PNG。
