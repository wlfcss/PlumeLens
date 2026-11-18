# Windows 与 AMD 优化、验证记录

验证日期：2026-11-18。实机：Windows 11 Pro 10.0.26300.9818，Intel i5-13490F（16 个逻辑处理器），约 32 GB 内存，AMD Radeon RX 7900 XTX（24 GB 显存），驱动 32.0.32015.7029。

## 使用

- `start-validation.cmd`：打开本次 300 张照片的图库，进入最近使用的“Windows 鸟片测试”。
- `start-windows.cmd`：启动独立 Windows 程序。无需安装 Python、Node 或 uv；保留整个 `release/win-unpacked` 目录。
- `release/PlumeLens-0.7.8-Windows-x64.zip`：完整便携包，解压后运行 `PlumeLens.exe`。
- `prepare-windows-gpu.cmd`：关闭应用后运行，下载或启用官方 Windows ML AMD 组件，编译检测模型缓存，并与 CPU 输出比较。发行包内同样附带此脚本，调用自带后端，无需开发环境。第一次编译实测约 1–3 分钟；本机已准备完成。缓存位于 `%LOCALAPPDATA%\PlumeLens\gpu-cache`。
- `start-local.cmd`：启动源码开发版，仅在 `.venv-amd/amd-verified.json` 存在时使用该 AMD 环境。

缺少、损坏或与硬件/模型不符的原生 GPU 缓存不会触发应用启动时的长时间编译；检测器使用兼容的 CPU 路径，其他可用 GPU 模型继续工作。驱动、官方 AMD 组件或 GPU 更换后，可重新运行初始化脚本。

## AMD 加速与依赖选择

最终采用 **Windows ML 原生 AMD GPU 检测 + DirectML 小模型 + ROCm PyTorch 鸟种识别**。检测器的旧 DirectML 路径比 CPU 更慢，因此不能简单地把所有模型统一设成 DirectML。

| 模型            |   实测 CPU |              实测 GPU | 选择                                |
| --------------- | ---------: | --------------------: | ----------------------------------- |
| YOLO 鸟类检测   |  997.04 ms | 原生 AMD GPU 27.97 ms | AMDGPUExecutionProvider，约 35.6 倍 |
| 姿态            |  268.02 ms |      DirectML 约 8 ms | DirectML                            |
| 飞行分类        |   19.05 ms |    DirectML 约 1.8 ms | DirectML                            |
| CLIP IQA        |   31.17 ms |    DirectML 约 4.5 ms | DirectML                            |
| HyperIQA        |   37.12 ms |    DirectML 约 4.4 ms | DirectML                            |
| DINOv3 鸟种识别 | 1533.72 ms |   ROCm FP32 133.19 ms | ROCm，约 11.5 倍                    |

表内为预热后的单模型测试，不代表整张照片的加速比例；CPU 鸟种参考环境为 torch 2.11，ROCm 为 2.12。检测器原生 GPU 与 CPU 在 4 个真实鸟图上的最大输出差异为 0.000153，检测数量一致；鸟种识别最大概率差异 1.79e-6，Top-1 一致。整库分级结果也需结合后面的 300 张验证判断。

实际依赖：Python 3.12.16；torch 2.12.0+rocm7.14.1；torchvision 0.27.0+rocm7.14.1；onnxruntime-windowsml 1.30.1.202610302006；windowsml 2.5.96；transformers 5.6.2；numpy 2.4.4；Pillow 12.2.0；rawpy 0.26.1。模型清单的 12 个 SHA-256 校验通过。

| 对照方案                                         | 验证与决策                                                                                                         |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| ONNX Runtime DirectML 1.24.4 → Windows ML 1.30.1 | 同 4 张预览图比较；CPU 检测约快 9%，小模型差异在毫秒内，输出保持容差内；Windows ML 可加载实测显著更快的原生 AMD EP |
| 最新 transformers 5.23.0                         | 鸟种约 129 ms 对 133 ms，单图差异小；保留已完成全流程验证的 5.6.2                                                  |
| Pillow 13 / rawpy 0.28 / numpy 2.5.5             | 同 8 个 RAW 的预览中位数约 126.95 ms，对已选版本 122.46 ms；未获得收益，保留锁定版本                               |
| ROCm BF16                                        | 概率误差约 0.0052；选择 FP32                                                                                       |
| ROCm fused/SDPA attention                        | Windows 实机出现 HIP 参数错误；选择 eager attention                                                                |
| 每张照片清空 GPU allocator                       | 约 0.2% 时间收益且额外占用显存，没有采用                                                                           |
| torch-directml                                   | 需要较旧 torch 组合，不适合现有 DINOv3/transformers 模型栈；未作为主方案                                           |

Microsoft 官方将 AMD GPU EP 列为 Windows ML 支持的后端，相关最低版本和驱动要求以其表格为准；初始化脚本通过 Windows ML 获取适配组件，不修改系统驱动。[支持的执行后端](https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/supported-execution-providers)、[AMD 官方 PyTorch 安装](https://rocm.docs.amd.com/projects/ai-ecosystem/en/latest/frameworks/pytorch/install.html)。

DirectML 按官方要求关闭 memory pattern 并顺序执行。同一进程中的 DirectML、原生 AMD EP 与 ROCm 共用 GPU 执行锁：交叉并行曾触发设备移除错误，因此采用 CPU 解码并行、GPU 推理串行排队的稳定组合。[DirectML 限制](https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html)

原生检测器使用 `cache_dir` / `ORT_MIGRAPHX_CACHE_DIR` 持久缓存。验证模型 SHA、硬件/后端身份、缓存文件大小和 SHA 后才启用；热缓存的加载和首次运行约 2.7 秒。[AMD EP 缓存说明](https://github.com/onnxruntime/onnxruntime-ep-amdgpu/blob/main/examples/mxr_cache/README.md)

裁剪后的独立发行包还用全新空目录完成了首次编译测试：106.35 秒准备缓存，2.75 秒完成再次加载和首次运行，推理约 28.71 ms，输出差异仍为 0.000153。这项测试没有调用开发环境的 Python 或 SDK 编译工具。

## 自动识别配置与内存保护

启动时检测进程可使用的 CPU 核心（遵守亲和性）、物理内存；模型加载后结合实际后端和 ROCm 可见的显存细化配置。环境变量显式设置优先于自动值。

| 场景                            | 分析上限 | 预览上限 | 后台线程 | 单个 ONNX 会话线程 |
| ------------------------------- | -------: | -------: | -------: | -----------------: |
| 8 GB / 2 线程示例策略           |        1 |        1 |        2 |                  1 |
| 16 GB / 8 线程示例策略          |        2 |        2 |        4 |                  4 |
| 本机 32 GB / 16 线程 / 原生 AMD |        3 |        4 |        8 |                  4 |

示例策略由单元测试覆盖；不是在每种硬件上完成的性能评测。原生 AMD 的可见显存不足 6 GiB 时将默认分析上限降至 1，不足 12 GiB 时最多 2。没有可验证的原生检测后端时采用较保守的分析上限。

运行期间保留至少 **2 GiB 或物理内存的 15%（取较大值）**。分析任务按每个新增任务约 1 GiB 的入场预算限制并发，预览按 512 MiB；剩余内存下降时减少新任务，内存恢复后自动恢复到硬件允许的上限。正在执行的任务正常完成，不因降速被中断。分析上限跨所有图库共享，预览上限也跨图库共享，避免同时开多个图库造成成倍解码。

取消等待不会立即释放仍在底层解码的名额；真正的线程结束后才回收，避免连续取消/重试叠加 RAW 缓冲区。这属于内存压力控制，不是操作系统级的硬性内存上限；单张异常大图仍受图片像素上限保护。原片读取/哈希保持保守的串行流式处理，并按图库合并重复请求，避免叠加遍历大目录。

手动覆盖：`PLUMELENS_ANALYSIS_CONCURRENCY=1..4`、`PLUMELENS_THUMBNAIL_CONCURRENCY=1..8`、`PLUMELENS_WORKER_THREADS=2..32`、`PLUMELENS_ONNX_THREADS=1..8`。手动设置仍受运行时内存入场保护。`/health` 的 `resources` 提供硬件、实际配置、手动覆盖字段、可用内存、当前分析并发上限和活动数；同样信息写入日志，便于复核。

同一批 32 张照片（8 JPG + 24 RAW），整条分析流程测试：

| 配置              |    耗时 | 张/分钟 | 内存峰值 WS | 专用提交量峰值 | GPU 平均负载 |
| ----------------- | ------: | ------: | ----------: | -------------: | -----------: |
| CPU 检测，并发 2  | 73.82 s |   26.01 |    5.67 GiB |       7.49 GiB |        9.92% |
| 原生 AMD，并发 2  | 45.73 s |   41.98 |    3.67 GiB |       5.32 GiB |       17.27% |
| 原生 AMD，并发 3  | 35.43 s |   54.19 |    4.13 GiB |       5.83 GiB |       22.71% |
| 原生 AMD，并发 4  | 33.60 s |   57.14 |    5.06 GiB |       6.92 GiB |       24.05% |
| 自动识别 → 并发 3 | 37.78 s |   50.82 |    4.30 GiB |       5.95 GiB |       21.18% |

并发 4 比 3 仅快约 5%，工作集峰值多约 0.93 GiB，因此本机自动选择 3。自动配置约为 CPU 检测基线的 1.95 倍；手动三并发试验为 2.08 倍。

资源采样使用 Windows PDH 英文性能计数器，按实际后端 PID 记录 CPU、工作集、专用提交量、各 GPU 引擎、独立/共享显存及系统可用内存；GPU 数字取最忙引擎，避免只看“3D”图漏掉 Compute。GPU 平均值没有到 100%：全分辨率 RAW 解码仍占 CPU 阶段的大部分时间，且每张照片只有较短的 GPU 推理区间。这里以吞吐、准确性和内存为共同目标；提高 GPU 图表数值本身不是有效的性能收益。

## Windows 文字、图片和布局

- 使用 Microsoft YaHei UI 等 Windows 中文字体回退，补齐标题和等宽样式的 CJK 字体；关闭合成字体效果。通过 CDP 检查实际渲染字体，确认中文不再落到宋体。
- 隐藏突兀的白色系统标题栏，使用深色 Windows 原生标题栏覆盖层；保留系统最小化、最大化、关闭和 Snap 行为。修正工具栏左右留白和窗口按钮的占位。[Electron 标题栏](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)
- 针对 1100、1280、1366、1680 宽度调整侧栏、目录标题和统计卡片；修复目录名被挤成竖排、报告英雄区域塌陷及数值截断。
- 100%、125%、150% 缩放验证；高 DPI 网格按需求读取 1920px 预览，保留 384px 小缩略图供低密度布局使用。图片失败重试同时更新高分辨率 URL。

RAW 展示优先读取相机内嵌 JPEG，用 JPEG `draft()` 在解码阶段降采样，再生成 1920/384px 缓存；避免为浏览解码整幅 45 MP RAW。8 个 RAW、各 3 次对照：预览解码/缩放中位数 **297.65 → 122.46 ms（约 2.43 倍）**，预览 PSNR 最低 45.22 dB。实际重新生成 300 张照片的 600 个缓存图约 14.24 秒，全部可解码且尺寸正确。[Pillow draft](https://pillow.readthedocs.io/en/stable/reference/Image.html)

分析仍使用全分辨率原片。浮点归一化改为原位运算：同一张 8192×5464 图像的输出 SHA 完全相同，跟踪到的该阶段分配峰值 **1,074,268,648 → 671,417,149 字节**，减少约 403 MB；这不是整个进程的内存占用数字。

## Windows 稳定性修复

最初的闪退来自父进程检查：Python `os.kill(pid, 0)` 在 Windows 上会终止进程。已改用只读 Windows 进程句柄检查；退出通过 stdin 请求后端优雅关闭，超时才清理本应用拥有的进程树。[Python 官方语义](https://docs.python.org/3.11/library/os.html#os.kill)

其他修复包括 Windows `.exe` 路径、UTF-8/中文/空格/单引号路径、盘符和 UNC 边界、缩略图缓存路径校验、RAW 缩略图 Enum 判断、Windows 文件变更标识、批量请求超时、图库重复哈希请求、外部编辑器可执行文件发现与启动。修复同一毫秒写入多条分析历史时顺序不稳定的问题，保证最新历史排序稳定。

## 体积

- 完整 ZIP 便携包约 **2.01 GB**，原始构建为 2.89 GB，约减少 30.7%。
- 独立后端：**4.46 GB → 2.30 GB**，约减少 48.5%。
- 完整解压目录：**6.26 GB → 4.03 GB**，约减少 35.6%。
- 前端 app.asar：**72.82 MB → 11.70 MB**，约减少 83.9%。前端依赖已经打入构建产物，不再重复携带整套 node_modules。

移除 ROCm SDK 的编译工具 EXE、静态 LIB 和 PDB，并移除本程序 eager attention 不使用的 AOTriton flash 内核归档；保留运行库 DLL、HIP RTC 资源、当前设备内核、元数据及许可文件。所有模型权重保留，未做可能影响识别结果的量化。

AMD Windows ML 组件由 Windows 管理、共享安装，不混入 ZIP；本机另有约 103 MB 的检测器编译缓存。ZIP 大小不能代表所有共享组件的安装占用。大体积原始构建超过 NSIS 内嵌负载限制，采用 ZIP64 便携包；当前本地构建未做发行者证书签名。[NSIS 限制](https://nsis.sourceforge.io/I_get_an_error_when_compiling_large_installers)

## 验证范围与复核

使用 `D:\测试照片` 中 **300 张不同原片：19 JPG + 281 Canon CR3，共 19,282,089,979 字节**。RAW 小规模目录全部覆盖，其余分散取样；所有后续性能、界面和发行包测试复用这些原片或其副本，没有扩大到整库。

验证内容包含全模型分析、暂停后退出/重启续跑、完整选择导出、600 个缓存 JPEG、300 份 XMP XML、JSON/CSV 各 300 行、复制导出 RAW 字节一致/JPEG 像素一致、路径特殊字符、界面筛选、高清预览、键盘评分与恢复、正常退出无后端残留，以及发行包内 AMD 运行库。

原片按 SHA-256、文件大小和修改时间与只读基线比较；分析输入哈希也必须对应原片。输出检查 NaN/Infinity，模型资源按 manifest 检查。分级为精选 21、可用 223、记录 30、淘汰 22、无鸟 4。默认分级导出会排除未分级的无鸟照片，全量导出验证使用包含无鸟的当前选择。

300 张完整发行程序流程通过，失败、死任务、待处理均为 0。恢复后的分析阶段采集 351 个一秒采样：后端 CPU 平均占整机 40.05%，工作集平均 3.02 GiB、峰值 4.82 GiB，专用提交量峰值 6.56 GiB；GPU 最忙引擎平均 18.97%、峰值 100%，独立显存峰值 4.64 GiB；系统可用内存最低 12031 MiB。这些是后端进程的计数，不是整个桌面或所有 Electron 进程之和。

Python 核心回归 **503 通过、1 跳过**，构建资产恢复检查 **4 通过**；前端 **77 通过**；TypeScript、ESLint、Ruff、Pyright 与 Actions 配置检查通过。另覆盖内存压力下降/恢复、手动配置不被覆盖、跨图库并发限制、取消后底层线程的名额回收、缓存失效和 GPU 初始化失败回退。

以下证据为本次生成的本地验证产物，保存在未入 Git 的 `.tools` 目录；公共自动构建的产物和失败诊断可在对应 Actions 运行中下载。

证据位置：

- `.tools/windows-packaged-validation-300.log`：最终独立程序的 300 张完整流程。
- `.tools/windows-resources-packaged-300.json`：最终程序分析阶段资源采样；相应 `.run.json` 含硬件、配置和健康信息。
- `.tools/windows-validation-audit.json`：输入关联、结果、JPEG、XMP、清单及复制导出复核。
- `.tools/source-inventory-300.json`、`.tools/source-verify-300.log`：原片只读基线和最终检查。
- `.tools/windows-packaged-gpu-setup.json`：独立程序原生 GPU 输出一致性与缓存测试。
- `.tools/windows-packaged-cold-gpu.json`：裁剪后独立程序从空缓存首次编译、再次加载与输出一致性。
- `.tools/windows-throughput-*.json`、对应 `.result.json`：并发对照及资源原始数据。
- `.tools/windows-preview-300.json`、`windows-preview-benchmark.json`、`windows-normalize-memory.json`：预览和内存优化数据。
- `.tools/windows-final-pytest.log`、`windows-final-vitest.log`、`windows-final-{typecheck,eslint,ruff,pyright}.log`：回归与静态检查。
- `.tools/windows-native-frame-{1,1.25,1.5}.png`、`windows-layout-*.png`、`windows-fonts-*.json`：实际窗口、布局和字体证据。
- `.tools/windows-size-final.json`、`windows-archive-verification.json`：体积、ZIP 完整性与校验和。

本次实机覆盖上述 Windows 11 + RX 7900 XTX。Windows 10、其他 AMD 型号、多显卡、其他相机 RAW 格式以及未安装的外部编辑器联动没有同等实机覆盖；不能据此宣称所有 Windows 硬件零缺陷。没有逐张人工鸟种真值，本次模型输出一致性与稳定性验证不等同于识别准确率评测。

源码重建：安装 Node 24/uv，运行 `npm ci`、`uv sync --frozen --extra dev`；AMD 环境运行 `powershell -ExecutionPolicy Bypass -File scripts/setup-windows-amd.ps1`。打包前将 `PLUMELENS_PYTHON` 指向已验证 AMD Python，然后运行 `npm run dist:win`。本机缓存的工具与开发环境不进入便携包。

## Windows 自动构建

工作流位于 [windows-build.yml](.github/workflows/windows-build.yml)，使用 Windows Server 2025 x64、Node.js 24 和 Python 3.12。

- PR：执行 TypeScript、ESLint、前端测试、Ruff、Pyright 和不依赖完整模型的 Python 回归。
- 主分支、版本标签或手动运行时，质量检查通过后安装锁定依赖与指定设备的 ROCm 构建包，按仓库清单恢复模型，冻结后端并生成便携包。
- 打包后逐项核对模型和运行库；ZIP 内每个文件与便携目录进行 SHA-256 对照，同时检查 CRC，并生成 `.zip.sha256`。通过后上传到该次 Actions 的 Artifacts，保留 7 天。
- 两组端到端测试分别在新的 Windows 运行器上下载同一份 ZIP，核对 SHA-256 后解压。一组验证冷启动和历史恢复，另一组验证分析、缩略图、导出、退出和重启。版本标签 `v*` 需等两组均通过后，才将 ZIP 与校验文件上传到对应 Release。

默认设备目标为本机使用的 `gfx1100`。手动运行可选择 `gfx1101`、`gfx1102`、`gfx1200` 或 `gfx1201`；目标必须与 AMD 支持矩阵和实际显卡对应，选择选项不等于该设备已完成实机验证。

默认模型来源为本仓库的 `models-v4` Release、资产名 `plumelens-models-v4.tar.gz`。该包仅含未入 Git 的大模型，其他模型与元数据取自已检出的代码，两处资产均按仓库清单校验。可用仓库变量 `PLUMELENS_MODELS_RELEASE_TAG` / `PLUMELENS_MODELS_RELEASE_ASSET` 修改，或用 Secret `PLUMELENS_MODELS_URL` 指定下载地址。清单始终取自已检出的代码，下载包不能覆盖它。

标准 GitHub 托管运行器没有 AMD 显卡，启动测试显式使用 CPU 后端；GPU 数值、性能与驱动兼容性由前述本机测试覆盖。构建时使用 `-InstallOnly` 跳过需要真实 GPU 的依赖基准测试；这不表示 GPU 验证已经通过。冻结后清理开发环境、归档前清理已复制的模型和中间目录，控制托管运行器的磁盘峰值。

CI 使用单独生成的测试图片检查分析、导出和界面流程；这些图片不计入前述 300 张实拍样本。包含无鸟图片的测试会显式启用“无鸟”筛选，避免依赖默认显示档位。
