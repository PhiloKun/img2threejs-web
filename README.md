<div align="center">

# img2threejs-web

**把一张图片，一键变成可在浏览器里旋转的 Three.js 3D 模型。**

纯前端 · 零后端 · 无需 AI 训练 · 真实几何体（轮廓拉伸，不是贴图卡片）

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-Three.js-000000.svg)](https://threejs.org)
[![Build](https://img.shields.io/badge/build-Vite-646CFF.svg)](https://vitejs.dev)
[![GitHub](https://img.shields.io/badge/GitHub-PhiloKun%2Fimg2threejs--web-lightgrey)](https://github.com/PhiloKun/img2threejs-web)
[![Gitee](https://img.shields.io/badge/Gitee-PhiloKun%2Fimg2threejs--web-red)](https://gitee.com/PhiloKun/img2threejs-web)

</div>

---

## 这是什么

`img2threejs-web` = **一个开箱即用的 Web 应用** + **一套可程序化重建物体的 img2threejs 技能库**。

- **Web 应用（推荐，开箱即用）**：打开网页 → 拖入一张物体照片 → 点「一键生成」→ 立刻得到一个能拖动旋转、滚轮缩放的 3D 模型。全程在浏览器本地完成。
- **forge 技能库（进阶，agent 驱动）**：上游 `img2threejs` 的多阶段 Python 管线，由 Agent 完成视觉分析与编写 Three.js 代码，产出更高保真、动画就绪的纯代码模型（见文末「进阶用法」）。

> 本仓库基于 [img2threejs](https://github.com/img2threejs/img2threejs)（作者 hoainho，Apache 2.0）改造，新增了 `web/` 一键式前端应用。

---

## ✨ Web 应用特性

- 🖼️ **拖拽 / 点击上传** 任意物体照片（建议主体清晰、背景干净的实物图）。
- 🚀 **一键生成**：自动抠图 → 提取轮廓 → 拉伸成 3D 实体 → 贴图与材质一气呵成。
- 🧊 **真实 3D 几何体**：用 marching-squares 提取轮廓 + `ExtrudeGeometry` 沿轮廓真正拉伸，不是一张会穿帮的贴图卡片。
- 🎨 **PBR 材质**：正面贴原图（自定义 UV），侧面用提取出的平均色，粗糙度由图像方差算得；配 `RoomEnvironment` 环境反射 + 实时阴影。
- 🕹️ **可交互查看**：拖动旋转、滚轮缩放、右键平移；相机自动取景。
- 📦 **导出**：一键下载 `.glb` 3D 文件，或下载**纯代码的 `.ts` 工厂模块**（图片已内嵌 base64，可独立复用）。
- ⚡ **纯前端**：Vite + Three.js，无后端、无模型训练、无隐私上传。

---

## 🚀 快速开始

> 前置：本地安装 **Node.js 18+**。

```bash
# 1. 克隆仓库
git clone https://github.com/PhiloKun/img2threejs-web.git
cd img2threejs-web

# 2. 安装依赖（仅首次）
npm run setup

# 3. 启动 Web 应用
npm run web          # 开发模式 → http://localhost:5173

# 或者（macOS / Linux 一键脚本，首次自动装依赖）
./start.sh
```

打开浏览器访问 **http://localhost:5173** 即可使用。

其他命令：

| 命令 | 作用 |
| --- | --- |
| `npm run web` | 启动开发服务器（默认 5173 端口） |
| `npm run start` | 启动并监听 `--host`（局域网可访问） |
| `npm run build` | 打包到 `web/dist/` |
| `npm run preview` | 预览打包产物（4173 端口） |

---

## 🖱️ 怎么用

1. **导入图片**：把图片拖进左侧上传区，或点击选择文件。
2. **一键生成**：点击「🚀 一键生成 3D 模型」，左侧进度条会依次显示 `载入 → 提取轮廓 → 生成几何体 → 应用材质 → 完成`。
3. **查看 / 操作**：右侧画布实时出现可旋转模型——左键拖动旋转、滚轮缩放、右键平移。
4. **微调与导出**：
   - 贴图方向不对？点「翻转纹理」。
   - 点「导出 GLB」保存为 3D 文件。
   - 点「下载 .ts 工厂代码」拿到纯代码 Three.js 模块。

> 提示：用**干净背景、主体清晰的实物照片**效果最好。当前为「轮廓拉伸」方案，能还原物体外形并贴图；像马克杯把手这类**内凹细节**会被轮廓简化吃掉（见进阶用法获取更高保真）。

---

## 🧠 工作原理（Web 管线）

核心在 [`web/src/core/pipeline.ts`](web/src/core/pipeline.ts)，全部在浏览器内运行：

```
原图
  │
  ├─ 1. 去背景     角点估算背景色 + 洪水填充去阴影 → 得到物体掩膜 (mask)
  │
  ├─ 2. 轮廓提取   marching-squares 提取轮廓点 → Douglas-Peucker 简化
  │                （凸包兜底，保证闭合可填充）
  │
  ├─ 3. 拉伸成体   ExtrudeGeometry 沿轮廓真正拉伸成 3D 实体
  │                caps 用自定义 UVGenerator 把原图贴到正/背面
  │
  └─ 4. PBR 材质   正面 = 原图纹理；侧面 = 提取出的平均色
                   粗糙度由图像方差估算；Metalness/Roughness + 环境贴图
```

导出逻辑见 [`web/src/core/exporter.ts`](web/src/core/exporter.ts)（GLB 经 `GLTFExporter`，`.ts` 工厂代码由模板字符串生成）。

---

## 🗂️ 目录结构

```
img2threejs-web/
├── web/                      # 一键式 Web 应用（Vite + Three.js）
│   ├── index.html            # 页面结构
│   ├── src/
│   │   ├── main.ts           # UI 编排 + Three.js 场景（OrbitControls / 阴影 / 自动取景）
│   │   └── core/
│   │       ├── pipeline.ts   # 图 → 3D 核心管线
│   │       └── exporter.ts   # GLB / .ts 工厂代码导出
│   └── package.json
├── forge/                    # 上游 img2threejs 技能库（agent 驱动的 Python 管线）
│   ├── stage1_intake/        # 图像导入、轮廓/细节分析
│   ├── stage2_spec/          # 规格生成与严格质量门控
│   └── stage3_build/         # 生成 Three.js 工厂代码
├── start.sh                  # macOS / Linux 一键启动脚本
├── package.json              # 根脚本：setup / web / start / build / preview
└── README.md
```

---

## ⚙️ 技术栈

- **前端**：[Three.js](https://threejs.org)（WebGL 渲染）、Vite（构建/开发服务器）、TypeScript。
- **图像处理**：标准 Canvas 2D API（掩膜、轮廓、UV 映射），无第三方 ML 依赖。
- **导出**：`GLTFExporter`（GLB）、模板字符串生成纯代码 `.ts`。

---

## 🔧 进阶用法：forge 技能库（更高保真）

如果你想要**动画就绪、近乎照片级**的纯代码模型（而不是轮廓拉伸近似），可以用上游的 `forge/` Python 管线——由 Agent 完成视觉判断与写代码，确定性脚本只负责校验与质量门控。

```bash
# 仅依赖 Python 3.10+ 标准库，无需 pip install
python3 forge/stage1_intake/probe_image.py <image>
python3 forge/stage2_spec/new_pre_spec_assessment.py "Name" --image <image> --out assessment.json
python3 forge/stage2_spec/new_sculpt_spec.py "Name" --image <image> --assessment assessment.json --out spec.json
python3 forge/stage2_spec/validate_sculpt_spec.py spec.json --strict-quality
python3 forge/stage3_build/generate_threejs_factory.py spec.json --out src/createObjectModel.ts
```

> 该管线运行在 Claude Code / Codex / OpenCode 等 Agent 环境中，详细架构与脚本参考见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

---

## 📦 构建与部署

打包为纯静态站点，可部署到任意静态托管（GitHub Pages、Gitee Pages、Vercel、Netlify、对象存储等）：

```bash
npm run build        # 产物在 web/dist/
# 把 web/dist/ 上传到你的静态托管即可
```

---

## ☁️ 在线演示

- 🌐 **临时云预览**（CloudStudio，可能过期）：<https://9e57408bd09c44248cf20706891e30d1.sh4.agentos-app.net>
- 想长期可用？按上面的「构建与部署」把 `web/dist/` 部署到你自己的静态托管即可。

---

## 📄 许可证

[Apache License 2.0](LICENSE)。

本仓库在 [img2threejs](https://github.com/img2threejs/img2threejs)（hoainho，Apache 2.0）基础上新增 `web/` 前端应用，整体沿用 Apache 2.0。

---

## 🙏 参考与致谢

- 上游技能库与思路：[img2threejs](https://github.com/img2threejs/img2threejs)
- 由代码生成的模型示范画廊：[img2threejs-showcase](https://img2threejs.github.io/img2threejs-showcase/)
- 渲染引擎：[Three.js](https://threejs.org)
