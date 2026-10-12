# 打字雞 (typing chicken)

> 打字阅读一体化的桌面打字练习软件 —— 导入你自己的电子书，边读边打字。（可以去z.library下载电子书）
> A premium desktop typing practice app — import your own e-books and type along.

## ✨ 功能特性

- 📚 **导入电子书**：支持 EPUB / PDF 格式，导入后直接作为打字练习素材
- ⌨️ **打字引擎**：跟随书籍原文逐字练习，实时反馈正确率与速度
- 📖 **阅读一体**：练习界面即阅读界面，打字与阅读无缝切换
- 📊 **进度统计**：记录练习时长、正确率、WPM 等数据，可视化展示
- 💾 **本地存储**：所有数据保存在本地 SQLite（rusqlite），不上传任何云端
- 🎨 **多主题**：明暗主题切换，沉浸式阅读体验
- 🔤 **拼音支持**：内置 pinyin-pro，中文输入练习更精准

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | [Tauri 2](https://tauri.app) (Rust) |
| 前端 | React 18 + TypeScript + Vite 6 |
| 样式 | Tailwind CSS 3 |
| 状态管理 | Zustand |
| 本地数据库 | rusqlite (SQLite) |
| 文档解析 | epub / lopdf |
| 中文拼音 | pinyin-pro |

## 🚀 开发环境要求

- Node.js ≥ 18
- Rust（stable，≥ 1.77）
- Windows / macOS / Linux（Tauri 2 跨平台）

## 🏃 本地开发

```bash
# 1. 安装前端依赖
npm install

# 2. 启动 Web 端开发服务器（仅前端，用于调试 UI）
npm run dev

# 3. 以桌面应用方式启动（Tauri 窗口）
npm run tauri dev
```

## 📦 打包安装包

```bash
npm run tauri build
```

打包产物输出在 `src-tauri/target/release/bundle/` 目录下（Windows 为 `.msi` / `.exe` 安装程序）。

## 📁 项目结构

```
├── src/                  # 前端代码 (React)
│   ├── components/       # UI 组件（书架 / 阅读器 / 练习 / 统计）
│   ├── hooks/            # 自定义 Hooks（打字引擎 / 自动保存 / 导入 / 主题）
│   ├── store/            # Zustand 状态管理
│   ├── types/            # 类型定义
│   └── lib/              # 工具函数
├── src-tauri/            # Rust / Tauri 后端
│   ├── src/              # Rust 源码（文件读写 / 书籍解析 / SQLite）
│   ├── icons/            # 应用图标
│   └── tauri.conf.json   # Tauri 配置
├── scripts/              # 构建辅助脚本
└── package.json
```

## 📄 许可证

本项目当前未指定开源许可证。若计划公开分发，建议选择 [MIT](https://choosealicense.com/licenses/mit/) 等许可证并在本段注明。
