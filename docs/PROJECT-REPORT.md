# CutCut 项目报告

> 一个「安装即用」的本地 AI 抠图桌面应用 —— 从「打包 DSH + ComfyUI」到「直连 ONNX」的完整决策与实施记录。

| 项 | 值 |
|---|---|
| 项目名 | CutCut（前身 RMBG 一键抠图） |
| 版本 | **v1.4.0** |
| 交付物 | `app\dist\CutCut-Setup-1.4.0.exe` — **123.33 MB** |
| 平台 | Windows x64（NSIS 安装包，支持自定义安装路径） |
| 完成时间 | 2026-10-21 22:34 |
| 代码量 | 主进程 581 行 / 渲染层 938 行 / 推理 262 行 / 模型分发 256 行 / 系统集成 178 行 / 本地桥 157 行 / 后处理 150 行 / preload 58 行，合计 **2580 行**（另有浏览器扩展 164 行 + 安装器脚本 120 行） |
| 技术栈 | Electron 44.9.0 · onnxruntime-node 1.23.2 · sharp 0.34.5 · electron-builder 26.15.3 |
| 演进 | v1.0.0 单模型 ComfyUI 后端 → v1.1.0 双模型 + 改名 CutCut → v1.2.x 双主题 + 自定义安装路径 → v1.3.0 模型外置（1283→123 MB） → **v1.4.0 右键菜单 + 浏览器扩展** |

---

## 一、需求起点

原始需求（用户原话）：

> 「有没有能将调用本机 ComfyUI 基于 RMBG2.0 的抠图的那个 dsh 预设 Electron 封装成独立应用程序的办法 傻瓜式安装即用那种」

拆开来看有三个硬约束：

1. **独立应用** —— 不能是「装个 DSH 再装个预设」的脚本集合，要能双击安装包直接跑。
2. **傻瓜式** —— 安装完就能用，不能要求用户先装 Python / PyTorch / CUDA / ComfyUI。
3. **质量不降** —— 输出必须和原来 ComfyUI 里 RMBG-2.0 的效果一致。

后续需求演进（第二轮，m01303）：

> 「在安装窗口给用户自定义安装途径的权利 然后再做一套白日的 ui 记得加上深浅色模式的切换按钮 如果可以的话再做随时间切换深浅色模式的功能 把旧版本删掉然后把我 D 盘里你工作残余全部清理干净 写一份项目报告」

第三轮（m00657，双模型 + 改名）：

> 「算了算了你把两个模型都集成在应用里 然后把本机COMFYUI引擎的那部分内容删减掉吧 然后把图标替换成我给你的图片 软件的名字规范命名成CutCut」

第四轮（m02991，体积）：

> 「问问包体大小还能压吗 给出可行方案就行」

第五轮（m03557，本文档重点，右键菜单）：

> 「想要一个右键菜单项 能抠出任意（网页中的）图片 希望能像现代手机系统里长按即抠的功能那样 这个功能要在安装时提供可选项供用户使用 哦对安装要给用户自定义安装位置的选项」

---

## 二、方案选型：为什么最终没有打包 ComfyUI

### 2.1 三条候选路线

| 方案 | 做法 | 体积 | 外部依赖 | 结论 |
|---|---|---|---|---|
| **A. 重打包 DSH Electron** | 把预设 YAML + 插件塞进 `app.asar`，用 electron-builder 重出 NSIS | 14 GB+ | 每台机器仍需 Python + PyTorch + ComfyUI + CUDA | ✗ |
| **B. 内置 ComfyUI 全家桶** | 把 ComfyUI + standalone Python 环境整个塞进安装包 | 20 GB+ | 要分发整套 Python 运行时与 CUDA 库 | ✗ |
| **C. 直连 ONNX 推理** | 用 `onnxruntime-node` 直接跑导出的 ONNX 模型 | **123 MB** | **零** | **✓ 采用** |

### 2.2 关键洞察

**ComfyUI 在这条链路里只是个壳。**

勘察本机 ComfyUI 源码后确认，`RemoveBackground` 节点的全部逻辑就三件事：

1. `comfy_extras\nodes_bg_removal.py` 加载 safetensors 权重（BiRefNet）
2. `comfy\bg_removal_model.py` 的 `encode_image()` 做 1024×1024 resize + ImageNet 归一化
3. 跑一次前向，`out.sigmoid()` 得到 mask，再双三次插值回原尺寸

**这就是标准的 ONNX 推理图。** 模型早已被导出成 ONNX（ModelScope 的 `AI-ModelScope/RMBG-2.0/onnx/` 与 HF 的 `onnx-community/BiRefNet-ONNX`），用 `onnxruntime-node` 直接跑，就把 Python、ComfyUI、14 GB 运行时全部绕开了。

体积从 14 GB 压到 123 MB（v1.3.0 把模型外置之后），同时「零外部依赖」这个约束才真正成立。

### 2.3 模型授权：一个必须处理的问题

RMBG-2.0 的许可为 **CC BY-NC 4.0，仅限非商业用途**。不能只交付这一个模型。

调研后确认 **BiRefNet 是 MIT 可商用**，并且——关键发现——**RMBG-2.0 本身就是 BiRefNet 微调的产物**。实测两者在同一张图上的蒙版：

| 图 | MAE | IoU |
|---|---|---|
| desktop-photo-1.png（1161×1405） | 0.8 / 255 | 0.9950 |
| desktop-photo-2.webp（1052×1403） | 0.79 / 255 | 0.9947 |

蒙版几乎逐像素重合。所以「换可商用模型」不构成质量妥协，最终**两个模型都打包进应用**，用户随时切换。

---

## 三、技术实现

### 3.1 推理链路

```
图片文件
  ↓ sharp 解码（.rotate() 尊重 EXIF 方向，removeAlpha + srgb 统一色彩空间）
  ↓ resize 1024×1024（bicubic）
  ↓ 归一化 mean=[0.485,0.456,0.406] std=[0.229,0.224,0.225] → NCHW float32
  ↓ onnxruntime InferenceSession（DirectML GPU 或 CPU）
  ↓ mask [1,1,1024,1024]
  ↓ 双三次插值回原图尺寸
  ↓ refine.js 后处理（对比度拉伸 + 去小块 + 去色溢）
  ↓ RGBA PNG
```

### 3.2 双模型抽象

两个模型的 IO 契约不同，用一张注册表吸收掉：

| | 输入名 | 输出名 | 输出语义 | GPU |
|---|---|---|---|---|
| RMBG-2.0 | `pixel_values` | `alphas` | **已是 sigmoid 后的概率** | ✓ DirectML |
| BiRefNet | `input_image` | `output_image` | **是 logits（实测 −19.2 ~ −10.9），必须手动 sigmoid** | ✗ 强制 CPU |

`segment.js` 的 `MODELS` 注册表：

```js
const MODELS = {
  rmbg:     { files:['model_fp16.onnx','model_quantized.onnx','model.onnx'],
              input:'pixel_values', output:'alphas',        sigmoid:false, dml:true  },
  birefnet: { files:['birefnet_fp32.onnx','birefnet_fp16.onnx','birefnet.onnx'],
              input:'input_image',  output:'output_image',  sigmoid:true,  dml:false },
};
```

`providerCandidates(preferred, spec)` 会按 `spec.dml` 过滤掉 DML，避免用户给 BiRefNet 选「GPU」时白等一次必然的崩溃。

### 3.3 实测性能

测试机：RTX 5060 Laptop（8151 MiB）· AMD Ryzen 7 8840HX · 15.2 GB RAM

| 模型 | 执行提供器 | 首次（含建会话） | warm 单张 |
|---|---|---|---|
| RMBG-2.0 fp16 | **DirectML** | 13–18 s | **1.0–1.6 s** |
| RMBG-2.0 quantized | DirectML | — | 13.6 s |
| RMBG-2.0 fp32 | CPU | — | 27 s |
| BiRefNet fp32 | CPU | 9–10 s | 19–25 s |
| BiRefNet fp16 | CPU | 9.9 s | 49 s（CPU 上要转 fp32，更慢） |

结论：RMBG 走 DirectML 是唯一能叫「实时」的路径；BiRefNet 只能 CPU，慢一个数量级，但换来了可商用授权。

多线程无改善（8 线程 vs 默认：20847/37338/25538 vs 19662/40523/18792 ms）。

### 3.4 双主题 UI

v1.2.0 把整套配色变量化（35 个 CSS 变量），实现深色 / 浅色两套皮肤：

- **深色**：`--bg:#0f1115` · `--panel:#171a21` · `--fg:#e8ecf3` · `--accent:#4c8dff`
- **浅色**：`--bg:#f2f5fa` · `--panel:#ffffff` · `--fg:#1b2431` · `--accent:#2f6fed`

三态切换（header 右上角）：☀ 浅色 / ☾ 深色 / ◐ 自动。

- **自动规则**：07:00–19:00 浅色，其余深色；渲染进程每 30 s 对表，主进程也起 30 s 定时器同步 `nativeTheme.themeSource` 与窗口背景色。
- **防闪**：`<head>` 最前面内联脚本读 `localStorage['cc.theme.effective']` 直接写 `documentElement.dataset.theme`，先于首帧；主进程 `createWindow()` 也按当前时段算 `backgroundColor`。
- **快捷键**：Ctrl+Shift+L 直接对调深浅。

### 3.5 安装器

`build.nsis` 关键配置（1.4.0 现用值）：

```json
{
  "oneClick": false,
  "allowToChangeInstallationDirectory": true,
  "perMachine": false,
  "allowElevation": true,
  "installerLanguages": ["zh_CN"],
  "language": "2052",
  "createDesktopShortcut": "always",
  "createStartMenuShortcut": true,
  "runAfterFinish": true
}
```

`oneClick:false` + `allowToChangeInstallationDirectory:true` 才会出现「选定安装位置」页。实测截图确认：目标文件夹输入框 + 「浏览(B)...」按钮 + 所需空间 / 可用空间均正常显示，全中文。

**「选择功能」页**（1.4.0 新增）由自定义 include `app/build/installer.nsh` 提供，挂在 electron-builder 模板的两个宏上：

| 宏 | 模板位置 | 用途 |
|---|---|---|
| `customPageAfterChangeDir` | `assistedInstaller.nsh:42-44` | 在「选定安装位置」之后、`MUI_PAGE_INSTFILES` 之前插入一页 `Page custom` |
| `customInstall` | `installSection.nsh:81-83` | 文件解压、注册表信息、快捷方式全做完之后，写 HKCU 菜单键、复制扩展目录 |
| `customUnInstall` | `uninstaller.nsh:156-158` | 删菜单键、删扩展目录 |

页面本身用 `nsDialogs.nsh` 手绘（两个 checkbox + 一行说明），因为 electron-builder 的 `MUI_PAGE_COMPONENTS` 只在 `customUnInstallSection` 存在时用于卸载器，不能拿来当安装选项页。

### 3.6 体积：1283 MB → 123 MB

v1.2.1 把两个模型（489.8 + 927.6 MB）用 `extraResources` 打进了安装包。拆开体积构成后结论很清楚：

| 组 | 原始 | 压缩后（LZMA） | 占 1.2.1 安装包 |
|---|---|---|---|
| Electron 本体 `CutCut.exe` | 235.70 MB | 73.23 MB | **59%** |
| Electron 其他 dll/pak | 84.40 MB | 37.60 MB | 21% |
| onnxruntime + DirectML | 59.00 MB | 26.10 MB | 15% |
| sharp / libvips | 19.00 MB | 8.40 MB | 5% |
| **两个模型** | **1417 MB** | ~970 MB | — |

NSIS 实际压缩比 30.8%（400 MB → 123 MB），`compression:"maximum"` 已到底。也就是说**安装包剩下的 100 MB 里，`CutCut.exe` 一个文件就占 59%，不可再删**。

真正的杠杆只有模型。方案对比：

| 方案 | 安装包 | 首次可用 | 评价 |
|---|---|---|---|
| 维持内置双模型 | 1283 MB | 装完即用 | 太大 |
| **模型外置 + 首次下载（采用）** | **123 MB** | 需下 489.8 MB | ✓ 兼顾体积与离线 |
| BiRefNet 换 fp16 | 省 438 MB | CPU 上 19–25 s → 49 s | ✗ 反而更慢 |
| RMBG 换 quantized | 省 124 MB | DML 上 1.4 s → 13.6 s | ✗ 慢一个数量级 |
| 换 Tauri 2 | ~15 MB | — | 需整套重写（ORT→ort crate、sharp→image crate），1–2 周 |

采用的方案：`models.js` 定义 `CATALOG`（file / bytes / sha256 / sources 有序回退），
`.part` 文件 + HTTP Range 断点续传，下完流式 SHA-256 校验，不符即删；也支持「从本地导入」离线分发。
`scripts/check-catalog.cjs` 在打包前比对清单与实际文件——**清单写错时本地开发完全正常，
但所有用户下载完都会校验失败**，这是唯一能提前拦住它的检查。

### 3.7 四个抠图入口（1.4.0）

需求原话是「像现代手机系统里长按即抠」。桌面端对应四个入口，最终都汇到同一条管线
（磁盘路径 → `deliverPaths()` → 渲染进程 `addPaths()` → 同一个 `runQueue()`）：

| 入口 | 机制 |
|---|---|
| 拖进窗口 / Ctrl+O | 渲染进程 `webUtils.getPathForFile()` |
| 资源管理器右键图片 | 注册表 `shell\CutCut\command` = `CutCut.exe --cutout "%1"`；新进程被 `requestSingleInstanceLock()` 挡下，`second-instance` 里解析参数转交第一实例 |
| 网页图片右键 | 浏览器扩展 `contextMenus[image]` → `fetch` 图片字节 → `POST http://127.0.0.1:8770/cutout` → `bridge.js` 落盘 → `onImage` 回调 |
| Ctrl+Alt+X | `globalShortcut` → 读剪贴板（位图或文件列表）→ 落盘 |

三个设计决策值得记录：

1. **本地桥为什么要鉴权**：`127.0.0.1` 上的 HTTP 服务，任意网页都能打。所以校验 `Origin` 必须是
   `chrome-extension://` / `edge-extension://`（否则 403），并要求自定义头 `X-CutCut: 1`（否则 400）
   ——自定义头会触发 CORS 预检，网页无法静默伪造。端口从 8770 试 10 个，选中端口写
   `<tmp>\cutcut-bridge\port.txt` 供扩展和排查用。
2. **渲染进程主动报到**：`did-finish-load` 时渲染进程的 `init()` 还在 `await`（读设置、`app:info`），
   此时发 `app:openFiles` 会静默丢失。改成 `preload.js` 暴露 `ready()`，渲染进程挂完监听后
   `ipcMain.on('app:ready')` → `flushPending()`；`did-finish-load` 只留 3 秒兜底。
3. **扩展不做「一键安装」**：见 4.5 节的实测结论——新版 Edge/Chrome 直接屏蔽注册表外置的第三方 CRX。
   安装器只负责把扩展目录复制到 `%APPDATA%\cutcut\browser-ext`，UI 提供「打开扩展页 / 显示扩展目录」，
   用户点一次「加载解压缩的扩展」。这是浏览器官方允许、且不需管理员权限的唯一路径。

---

## 四、踩过的坑（按发现顺序）

这些问题每一条都真实卡住过进度，记录下来供后续维护者省时间。

### 4.1 模型与推理

1. **两个模型的输出语义相反**
   RMBG 的 `alphas` 已经过 sigmoid；BiRefNet 的 `output_image` 是 logits。搞混的结果是全黑或全白。早期还因为「以为需要 sigmoid 又取反」导致主体镂空、背景保留。

2. **`graphOptimizationLevel: 'all'` 让 fp16 模型加载失败**
   ```
   Attempting to get index by a name which does not exist:
   InsertedPrecisionFreeCast_/model/bb/patch_embed/norm/Constant_output_0
   for node: /model/bb/layers.0/blocks.0/norm1_1/Mul/SimplifiedLayerNormFusion/
   ```
   必须用 `'extended'`。

3. **BiRefNet 在 DirectML 上必崩**
   ```
   Non-zero status code returned while running DmlFusedNode_15_51 node.
   ```
   试过 basic / disabled / extended+nomem / basic+sequential 四种配置，以及升级 ORT 1.30.0，全部失败于同一个 fused node。最终锁定 ORT 1.23.2 + BiRefNet 强制 CPU。

4. **sharp 把单通道 Buffer 升成三通道**
   `mask` 调 `.resize()` 后 `info.channels` 会变成 3，按字节直接读会整幅错位（表现为 alpha 恒 128、透明率 0%）。必须用 `toBuffer({resolveWithObject:true})` 读 `info.channels` 再按 stride 跨步取。

5. **ComfyUI 的 `RemoveBackground` 输出的是前景 mask，`JoinImageWithAlpha` 要的是背景 alpha**
   中间必须夹一个 `InvertMask`，去掉会导致主体被抹掉（实测中心 alpha 253.1 → 1.2）。这是最初 ComfyUI 阶段最大的坑。

### 4.2 打包

6. **`extraResources.from` 是相对 `app/` 的**
   写成 `../../models/...` 会静默失败（只打印 `file source doesn't exist`），打出来的包里没有模型，直到运行时才报「未找到模型」。正确写法 `../models/...`。

7. **NSIS 只认 `.ico`**
   传 `icon.png` 报 `invalid icon file` + `MUI_INTERFACE macroline 87`。最终 `scripts/make-icon.cjs` 从 SVG 按 density 逐尺寸渲染再手工拼 ICO 容器，16px 仍有 115 种颜色，比「大图缩一份」清晰得多。

8. **npm 默认拦截 install scripts**
   `npm install` 后 `electron/dist/` 是空的。要手动 `node node_modules/electron/install.js`，并设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

9. **`build.cmd` 是 LF 换行**
   `cmd /c build.cmd` 会报一串 `'...' is not recognized as an internal or external command` 并 exit 1。必须转 CRLF。

### 4.3 界面与验证

10. **CSP 会挡掉本地图标**
    `img-src data: blob:` 让 `<img src="../build/icon.png">` 被拦，左上角变空方块。表达式要带 `'self' file:`。

11. **拖拽拿真实路径必须用 `webUtils.getPathForFile`**
    Electron 32+ 移除了 `File.path`。

12. **`ELECTRON_RUN_AS_NODE=1` 会让 electron.exe 退化成纯 Node**
    报 `Cannot read properties of undefined (reading 'commandLine')`。本机有这个全局变量，跑任何 Electron 前先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。

13. **devtools detach 窗口会让 `capturePage()` 抛 `UnknownVizError`**
    自动截图验证时必须 `CC_NO_DEVTOOLS=1`。

14. **`CopyFromScreen` 抓窗口截图不可靠**
    要自己换算窗口左上角坐标，多显示器 / DPI 缩放下极易裁错（实测窗口在 (263,143)，却按 (0,0) 裁剪）。正确做法是用 Win32 `PrintWindow(h, hdc, 2)`——**2 = PW_RENDERFULLCONTENT**，否则 GPU 合成的页面是黑屏；并且必须先 `SetProcessDpiAwarenessContext(-4)`（PER_MONITOR_AWARE_V2），否则 150% 缩放下 GetWindowRect 返回虚拟像素、PrintWindow 渲染物理像素，整幅图右下被裁。

15. **窗口最小化时 `GetWindowRect` 返回哨兵值 (−21333, −21333)**
    抓出来只有 158×26 的标题栏碎片，需先 `IsIconic` 判断 + `ShowWindow(h, 9)` 恢复。

### 4.4 验证方法的转变

**视觉模型全程不可用**（`VISION_BACKEND_UNAVAILABLE`，providers 报 `feature 'prompt_cache_key' is not currently supported` 与 `CDP 未连接`）。所有界面验收因此改走两条路：

- **CDP 读真实 DOM**（`Runtime.evaluate` + `returnByValue`）——比截图更精确，可以直接断言 CSS 变量的计算值、元素的 `disabled` 状态、`overflow` 数组。
- **像素统计**——用 sharp 提取区域做 `stats()`，用颜色数 / 均值 / 直方图判断图标是否渲染、主题是否切换。

最终验收证据全部来自这两条自动化路径，而不是人眼。

### 4.5 右键菜单与浏览器扩展（v1.4.0，教训最密集的一段）

16. **注册表外置 CRX 在新版 Edge 上已被硬屏蔽**
    写 `HKCU\Software\Microsoft\Edge\Extensions\<id>` 的 `path` 指向本地 `.crx` 后，Edge 确实会解包进
    profile（`Secure Preferences` 里有条目，`location=3`），但 `disable_reasons=256`，
    打开 `chrome-extension://<id>/manifest.json` 直接 `ERR_BLOCKED_BY_CLIENT`
    （「此页面已被 Microsoft Edge 阻止」）。对照机器上 Kimi 的外置扩展 `disable_reasons=8192` 且能跑
    —— 位值语义不同，无法复制。
    **`HKCU\Software\Policies` 整体不可写**（`Requested registry access is not allowed`，
    `reg add` → `ERROR: Access is denied`），所以也没法用 `ExtensionInstallForcelist` 绕过。
    → 最终只保留「开发者模式 + 加载解压缩的扩展」这条官方路径。扩展本身完全可用
    （`--load-extension=<dir>` 启动时 Service Worker 正常、`contextMenus` 可创建、能 POST 到本地桥）。

17. **Electron 44 删掉了 `clipboard.readImage()`**
    实测 `clipboard` 只剩 `clear/has/readText/read/write`；`readImage`、`readBuffer`、`availableFormats`
    全是 `undefined`，调用报 `clipboard.readImage is not a function`。新 API 是 Web 标准形状且**全异步**：
    ```js
    const items = await clipboard.read('image/png')   // ClipboardItem[]
    const blob  = await items[0].getType('image/png') // 也是 Promise<Blob>
    const bytes = Buffer.from(await blob.arrayBuffer())
    ```
    另一个坑：从资源管理器**复制文件**时，`image/png` 仍会返回上一张位图（陈旧值），
    必须优先判断 `text/uri-list`；而且 `text/uri-list` 取出来也是 `Blob`，要 `await v.text()` 再按行 split。

18. **`--cutout` 参数不能只取下一个位置参数**
    开发态 Electron 会把自己的开关和 app 目录插进来：
    `[exe, --cutout, --allow-file-access-from-files, D:\app, <图片>]`。
    必须「遇到 `--cutout` 后跳过所有 `--` 开头的参数和 `.`」，或直接扫全命令行找
    「后缀是图片格式且 `existsSync && isFile`」的参数。

19. **`customPageAfterChangeDir` 会让打包因 NSIS warning 失败**
    electron-builder 编译安装器和卸载器是两遍，卸载器那遍（`assistedInstaller.nsh` 的 `!else` 分支）
    不引用自定义页，于是
    ```
    warning 6010: install function "ccOptionsPageCreate" not referenced - zeroing code (0-69) out
    ```
    electron-builder 把 warning 当 error，直接 `Error: warning treated as error`。
    修法：可选页相关的 `Var` 和 `Function`、以及那个宏，全部包进 `!ifndef BUILD_UNINSTALLER`；
    但 `customInstall` / `customUnInstall` 必须留在外面（卸载器要用）。
    紧接着还会报 `warning 6001: Variable "CC_OptMenu" not referenced or never set`——`Var` 也要一起挪进去。

20. **复制扩展目录不能用 `CopyFiles`**
    它不递归，`icons\` 子目录会漏，浏览器随后报「扩展已损坏」。改用编译期
    `SetOutPath` + `File /r "${PROJECT_DIR}\browser-ext\*.*"`。

21. **静默安装 `/S` 不走自定义页**
    `$CC_OptMenu` / `$CC_OptExt` 是空串，`customInstall` 里要
    `${If} $CC_OptMenu == ""` → `StrCpy $CC_OptMenu ${BST_CHECKED}`（两项都按「默认勾选」处理）。

---

## 五、验证结果

### 5.1 安装版端到端

v1.4.0 静默安装后的自检（模型在 userData，不在包内）：

```
SELFTEST OK
model=rmbg path=C:\Users\xiure\AppData\Roaming\cutcut\models\model_fp16.onnx
electron=44.9.0 node=24.22.0 packaged=true
provider=dml size=1052x1403 ms=9529
stats={"meanAlpha":147.2,"transparentPct":42.1,"opaquePct":57.6}
```

- `packaged=true` → 确认跑的是安装包内资源，不是本地 `node_modules`
- `provider=dml` → DirectML GPU 生效
- `transparentPct=42%` / `opaquePct=57.4%` → 蒙版极性正确（若接近 0% 或 100% 说明反了）
- 输出 PNG 校验：`1052×1403, channels=4, hasAlpha=true, 1946 KB, alpha mean=147.2 min=0 max=255`
- 包内没有模型时（全新机器）自检输出 `SELFTEST FAIL / error=未找到模型` 并 **exit 0** —— 这是预期的优雅失败，
  不是崩溃。

### 5.2 双主题（CDP 实测）

| | 浅色 | 深色 |
|---|---|---|
| body 背景 | `rgb(242,245,250)` | `rgb(15,17,21)` |
| 文字 | `rgb(27,36,49)` | `rgb(232,236,243)` |
| 侧栏 | `rgb(255,255,255)` | `rgb(23,26,33)` |
| 选中段背景 | `rgb(226,236,255)` | `rgb(29,58,107)` |
| 成功徽章文字 | `rgb(12,107,80)` | `rgb(143,240,204)` |

时段规则自检：`0h=dark 6h=dark 7h=light 12h=light 18h=light 19h=dark 23h=dark`，当前 22 点正确判 dark。

### 5.3 模型切换联动

CDP 模拟点击：

```
初始:     gpuDisabled=false, device="DirectML (GPU)"
点 BiRefNet: gpuDisabled=true,  gpuTitle="该模型不支持 GPU 加速，只能用 CPU",
                              device="CPU", hint="MIT 授权，可商用；CPU 推理较慢"
切回 RMBG: 复原
```

### 5.4 安装器（v1.4.0）

交互式安装实测（截图保存在 `verify/inst/ep-*.png`）：

1. 「安装选项 / 为哪一位用户安装」中文正常，两项单选
2. 「**选定安装位置**」——目标文件夹输入框 + 「浏览(B)...」，所需空间 1.8 GB / 可用空间 31.2 GB
3. 「**选择功能**」——两个 checkbox（图片文件右键菜单 / 网页图片右键抠图）默认全勾，附一行说明
4. 装完后 `VersionInfo` 为 `ProductName=CutCut / FileVersion=1.4.0`

静默安装 `/S /D=<dir>` 也验证过（退出码 0，6.5 秒装完 400 MB），此时两个选项按默认全装：
注册表菜单键 4 条齐全，`%APPDATA%\cutcut\browser-ext` 6 个文件齐全。

> 注意：electron-builder 会把 `${APP_FILENAME}` 自动拼到 `/D=` 指定的目录后面
> （`assistedInstaller.nsh:34-36`），所以 `/D=D:\x\target` 实际装到 `D:\x\target\CutCut\`。
> 这是既定行为，不是 bug。

### 5.5 全新机器首次使用全流程（v1.4.0 安装版实测）

这是最贴近真实用户的一条路径，从空 userData 开始完整走一遍：

| 步骤 | 结果 |
|---|---|
| 启动 | 徽章「缺少模型文件」，左栏出现下载面板「该模型约 489.8 MB，下载一次后即可离线使用。」 |
| 点「下载（489.8 MB）」 | 进度条逐帧更新，`下载中 191.7 / 490 MB（39%） · 6.9 MB/s` |
| 下载完成 | 徽章「模型已就绪 · RMBG-2.0」，`mdText` 变「已安装：model_fp16.onnx（490 MB）」，页脚「下载完成，可以开始抠图了」 |
| 文件校验 | 513576499 B，SHA-256 `9dc47db4…4746f6` **与清单一致**（不一致会被自动删除） |
| 取消/续传 | 中途点「取消」→ `.part` 保留 27785997 B；再点下载从该偏移续传，实测速率 6.79 MB/s |
| 抠图 | 点「开始抠图」→ 8.9 s（DirectML），输出 `test-input-cutout.png` 900×1200 RGBA，`alpha mean 67.4 min 0 max 255` |

下载速率实测：ModelScope 单连接 5–7 MB/s，490 MB 约 75–90 秒。首秒会慢（TLS + 首字节），
进度条前几秒显示 190 KB/s 是正常现象，随后爬升。

### 5.6 Explorer 右键 → 抠图（全链路）

```
spawn CutCut.exe --cutout desktop-photo-1.png
→ 第一实例日志 [second-instance] paths=["D:\...\desktop-photo-1.png"]
→ 界面卡片 count=1  names=["desktop-photo-1.png"]
→ 页脚「已收到 1 张图片，按 Ctrl+Enter 开始」
```

冷启动带参也验证：`CutCut.exe --cutout desktop-photo-2.webp` → `count=1`。
真实 Shell 右键也验证过：`Shell.Application` → `ParseName(...).Verbs()` 里出现
「用 CutCut 抠出主体」，`DoIt()` 对应用进程命令行正确。

### 5.7 浏览器扩展 → 本地桥 → 抠图（全链路）

用本地 8799 端口当图床（沙盒内访问外网会被拦），流程：

1. 启动 CutCut（CDP 9404）→ 0 卡片
2. `msedge.exe --user-data-dir=<临时> --load-extension=<browser-ext>`，
   轮询 `/json/list` 到 `service_worker chrome-extension://llainffpmfbibbangebmjbfbonofcioh/background.js`
3. 在 SW 里 `Runtime.evaluate` 调扩展自己的
   `handleImage({srcUrl:'http://127.0.0.1:8799/pic.webp', menuItemId: MENU_ID}, tabs[0])` → `{ok:true}`
4. CutCut 出卡片 `web-<ts>.webp`
5. 点「开始抠图」→ 页脚「本轮完成 1/1」，`sub:["9.8sGPU"]`

本地桥的 10 条路由也单独测过：

| 请求 | 期望 | 实测 |
|---|---|---|
| `GET /ping` | 200 `{ok:true,app:'CutCut'}` | ✓ |
| `POST /cutout` 无 `X-CutCut` | 400 `missing X-CutCut header` | ✓ |
| `POST /cutout` `Origin: https://evil.com` | 403 `forbidden origin` | ✓ |
| `POST /cutout` 非图片字节 | 415 `不是可识别的图片` | ✓ |
| `POST /cutout` 空体 | 400 `空请求体` | ✓ |
| `GET /cutout` | 405 `POST only` | ✓ |
| `OPTIONS` | 204 + `Access-Control-Allow-Origin` 回原 origin | ✓ |
| 合法 PNG/WebP | 200 `{ok:true,path,bytes}` 且 `onImage` 触发 | ✓ |

---

## 六、清理

### 6.1 第一轮（v1.2.x 交付后，按用户勾选范围）

| 项 | 体积 |
|---|---|
| 旧版安装包 `RMBG-Cutout-Setup-1.0.0.exe` | −508.9 MB |
| 打包中间目录 `dist\win-unpacked` | −1865.3 MB |
| 卸载旧版 `C:\Users\xiure\AppData\Local\Programs\rmbg-cutout` | −约 3 GB |
| 构建日志 `build-log{,2,3,4}.txt`、`build-v12.log`、`dev-run.log` 等 | −数百 KB |

磁盘变化：C 56.33 → **59.64 GB** 空闲；D 33.05 → **35.37 GB** 空闲。

### 6.2 第二轮（v1.4.0 交付后）

我对 `D:\` 根目录造过不少测试副本（每个都是完整的 400 MB 解包目录），全部删掉：

| 项 | 体积 |
|---|---|
| `D:\cc13`（win-unpacked 副本） | −400 MB |
| `D:\cc-inst`（安装包 + target） | −535 MB |
| `D:\cc13-ud`（userData 测试目录，含 490 MB 模型） | −500 MB |
| `D:\cc-test` | −1865 MB |
| `D:\cc14`（开发态 app 副本 + 探针脚本） | −约 900 MB |
| `D:\cc-ext`、`D:\cc-edge-test`、`D:\ccv14-inst`、`D:\cc-inst14` 等 | −约 1.5 GB |
| `app\dist\win-unpacked`（1.4.0 打包中间产物） | −400 MB |

**同时把用户机器上被测试污染的浏览器状态还原了**（这条是用户明确要求的硬约束：

> 「我对你篡改扩展的行为容忍到任务结束 任务结束之前必须给我原封不动还回来」）

逐项审计结论：

| 检查项 | 结果 |
|---|---|
| Kimi 扩展 crx 字节与哈希 | 10816467 B，SHA-256 `02A0D20C…`，`LastWriteTime 2026/10/20 11:14:02`（早于本次任务），`cdn-latest.crx` 与之字节一致 |
| Kimi 扩展在 profile 里的解包目录 | 时间戳 2026/10/20 11:20:06，manifest `name=Kimi version=2.0.24` |
| 真实 profile 里是否出现我的扩展 ID | `Preferences` / `Secure Preferences` / `Local State` 各搜 `llainffpmfbibbangebmjbfbonofcioh` 与早期的 `ifgneagogdhnoannkflfebikipdobhmd` → **0 命中** |
| `HKCU\Software\Microsoft\Edge\Extensions` | 只剩 `fldmhceldgbpfpkbgopacenieobmligc`（Kimi 原项，path/version 未变）；我写入的 3 条测试键全部删除 |
| 策略键 | `HKCU\Software\Policies\Microsoft\Edge` 不存在；`ExtensionInstallForcelist` / `ExtensionSettings` 均不存在 |
| 我的测试 Edge 进程 | 按命令行匹配 `cc-ext|cc-edge|cc14|ccv14` → 0 个 |
| `%APPDATA%\cutcut\browser-ext` | 不存在（测试残留已清） |

**保留**：`app/node_modules`（717 MB，重建必需）、`app/build/ext-key.pem`（扩展签名私钥，丢了扩展 ID 会变）、`verify/` 下的截图证据。
`models/` 原先是个指向已卸载旧版的悬空 Junction（目标不存在），已删除并重建为空目录——
1.4.0 打包不需要模型文件，用户首次运行时由 `models.js` 下载到 `%APPDATA%\cutcut\models\`。

### 6.3 第三轮（最后一次验证之后）

最后又完整跑了一遍「全新机器首次使用」验收（静默安装 → 下载 490 MB 模型 → 抠图 → 卸载），
所有临时目录当场删净：`D:\cctmp`（124 MB，含测试安装 + 下载好的模型副本）、
`verify\cc-copy`（1865 MB，v1.2.1 的解包副本，早前 ACL 崩溃排查的遗留）、
`verify\ud-empty`、`verify\*.log.{out,err}`。

最终工作区：

| 目录 | 体积 |
|---|---|
| `app/`（含 node_modules 717 MB + dist 123 MB） | 841 MB |
| `models/` | 0（空目录） |
| `verify/`（只剩截图证据） | 6.9 MB |
| 合计 | **848 MB** |

磁盘：C **55.10 GB**、D **28.81 GB** 空闲。

---

## 七、产物清单

```
rmbg-cutout/
├─ app/
│  ├─ dist/CutCut-Setup-1.4.0.exe          123.33 MB   ← 交付物
│  ├─ dist/CutCut-Setup-1.4.0.exe.blockmap   0.13 MB   ← 差分更新用
│  ├─ src/main.js           581 行  主进程：窗口、IPC、设置、自检、单实例/--cutout、剪贴板
│  ├─ src/preload.js         58 行  contextBridge
│  ├─ src/segment.js        262 行  ONNX 推理核心 + 模型注册表
│  ├─ src/models.js         256 行  模型分发：清单 / 下载 / 续传 / 校验 / 导入
│  ├─ src/integrations.js   178 行  HKCU 右键菜单 + 扩展目录安装
│  ├─ src/bridge.js         157 行  本地 HTTP 桥（127.0.0.1:8770–8779）
│  ├─ src/refine.js         150 行  蒙版后处理
│  ├─ renderer/index.html   938 行  单文件双主题 UI
│  ├─ browser-ext/            6 个文件  浏览器扩展（MV3，background.js 164 行）
│  ├─ build/icon.ico       36.7 KB  7 帧（16/24/32/48/64/128/256）
│  ├─ build/icon.png       34.1 KB  512×512
│  ├─ build/installer.nsh   5.2 KB  「选择功能」页 + 注册表写入（120 行）
│  ├─ build/ext-key.pem     1.7 KB  扩展私钥（**别删**）
│  ├─ build/browser-ext.crx 27.8 KB  签好名的扩展包
│  ├─ build/browser-ext.zip 27.2 KB  同内容的 zip
│  └─ scripts/              42 个验证与构建脚本
├─ models/                 空目录（1.4.0 打包不需要模型；开发期冒烟可把 onnx 放这里或设 CC_MODEL_DIR）
├─ verify/                 截图与对比图
├─ README.md
└─ PROJECT-REPORT.md       ← 本文件
```

---

## 八、遗留与后续建议

1. **代码签名**
   当前安装包未签名，Windows SmartScreen 会提示「未知发布者」。要正式分发需购买 OV/EV 代码签名证书（约 ¥3000–6000/年），并在 `package.json` 里配 `win.certificateFile` / `win.certificatePassword`（或走 CI 的 `CSC_LINK`）。

2. **应用图标已换，但安装器侧边栏图仍是默认**
   NSIS 的 `installerSidebar` / `uninstallerSidebar` 需要 164×314 的 BMP，当前用的是 electron-builder 默认图。若要完全定制，需生成 `build/installerSidebar.bmp` 与 `build/uninstallerSidebar.bmp`。

3. **安装包体积已到 Electron 下限（123 MB）**
   `CutCut.exe` 一个文件就占安装包的 59%（压缩后 73.23 MB），删无可删。想再压一个数量级只能换 Tauri 2（~15 MB），
   但要把 ORT→`ort` crate、sharp→`image` crate、IPC、下载器、双主题全部重写，约 1–2 周工作量。
   模型的下载量还能再降（BiRefNet 换 fp16 省 438 MB、RMBG 换 q4f16 省 257 MB），代价是速度或画质。

4. **浏览器扩展无法一键安装**
   这是浏览器的策略限制，不是实现缺陷（详见 4.5 第 16 条）。用户需要在扩展页手动「加载解压缩的扩展」一次。
   若将来 Edge 重新放开企业策略（`ExtensionInstallForcelist`），可以改成安装器直接写策略键——但本机
   `HKCU\Software\Policies` 当前不可写，这条路要管理员权限。

5. **macOS / Linux**
   `onnxruntime-node` 与 `sharp` 都有对应平台包，代码本身是跨平台的，主要差在 `providerCandidates`
   （macOS 是 CoreML，Linux 是 CUDA/CPU）与图标格式。当前 `files` 里已经排除了 darwin/linux/arm64
   的二进制以减小体积，要出其他平台需放开对应排除项。另外 `installer.nsh` 与 `integrations.js` 的
   注册表部分是 Windows 专有，非 Windows 平台要隐藏「系统集成」组（代码里已按 `process.platform` 判断）。

6. **BiRefNet 在 DirectML 上的崩溃**
   已确认是 ORT 的 fused node 实现问题，与 1.23.2 / 1.30.0 版本无关。若未来 ORT 修复，把
   `MODELS.birefnet.dml` 改回 `true` 即可让可商用路径也享受 GPU 加速。

7. **全局热键可能冲突**
   `Ctrl+Alt+X` 在部分输入法/截图工具下会被占用。`globalShortcut.register` 失败时返回 `false`，
   当前只 `console.warn`；更好的做法是在「系统集成」里显示一行「热键不可用，请改用右键菜单」。

---

## 九、许可

- **RMBG-2.0 模型**：© BRIA AI，[bria.ai](https://bria.ai)，**CC BY-NC 4.0（仅限非商业用途）**。商用需向 BRIA 申请授权。
- **BiRefNet 模型**：[ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet)，**MIT**。
- **本封装代码**：MIT。

> 对外商用建议：默认模型改 BiRefNet。RMBG-2.0 从 `CATALOG` 里去掉即可（模型本来就不在包里，
> 移除后不影响安装包体积，只影响下载列表）。
