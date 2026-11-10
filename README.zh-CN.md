# libpeek

[![CI](https://img.shields.io/github/actions/workflow/status/WeaveFox/libpeek/ci.yml?branch=main)](https://github.com/WeaveFox/libpeek/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

**不安装依赖，直接读任何 npm 包的真实源码。**

libpeek 从公共 CDN 直读指定版本的 npm 包文件：列文件树、glob 匹配（通配符或模糊文件名）、带行号读文件、grep 搜索内容（含 `.d.ts` 类型定义）。

无 `npm install`、无沙箱需求、不执行任何第三方代码。整个工具是一个可全文审计的脚本，零依赖，纯只读 HTTP。

为 vibe-coding 场景而生：在 import 之前验证一个库真实导出的 API，而不是相信模型记忆。[English](./README.md)

## 为什么

- **不需要沙箱** —— 不写磁盘、不跑生命周期脚本。npm install 钩子是供应链攻击的头号入口，libpeek 不碰它。
- **精确版本** —— 支持 `react@19.1.0`、`latest`、`^19.0.0`；不带版本时自动对齐项目 `package.json` 声明的版本——读到的就是装到的。
- **真实源码 > 模型记忆** —— 模型会幻觉 API，tarball 不会。

## 安装

### 作为 agent skill（推荐）

```bash
npx skills add WeaveFox/libpeek --skill libpeek
```

通过 [skills.sh](https://skills.sh) 适用于 Claude Code、Cursor、Codex 等 70+ agent。详见 [SKILL.md](./skills/libpeek/SKILL.md)。

### 独立脚本

整个工具就一个文件，Node.js >= 18，零依赖：

```bash
node skills/libpeek/scripts/libpeek.mjs list react
```

## 用法

```bash
# 列出包内全部文件（版本支持精确号 / dist-tag / semver range）
node skills/libpeek/scripts/libpeek.mjs list react@19.1.0

# 找文件：通配符或模糊匹配
node skills/libpeek/scripts/libpeek.mjs glob zod "dist/**/*.d.ts"
node skills/libpeek/scripts/libpeek.mjs glob lucide-react arrow-left

# 带行号读文件（单次 2000 行 / 50KB；用 --offset 续读）
node skills/libpeek/scripts/libpeek.mjs read react package.json

# 正则搜索文件内容（单次最多下载 30 个文件；--include 限定范围）
node skills/libpeek/scripts/libpeek.mjs grep zod '"exports"' --include package.json
```

**版本对齐**：不带 `--version` 时，libpeek 读取项目 `package.json` 里声明的版本，`read`/`grep` 结果与实际安装版本一致。显式 `pkg@version` 或 `--version` 优先。完整参数见 [references/usage.md](./skills/libpeek/references/usage.md)。

## 安全性

纯只读 HTTP（unpkg / jsDelivr；`--mirror cn` 优先 npmmirror 国内节点）。零依赖、无 eval、无 shell、不执行包代码。威胁模型与审计指引：[references/security.md](./skills/libpeek/references/security.md)。

## 配置

| 环境变量 | 默认值 | 说明 |
| -------- | ------ | ---- |
| `LIBPEAK_REGISTRY` | `https://registry.npmjs.org` | packument 源覆盖（私有源可换） |
| `LIBPEAK_MIRROR` | `intl` | `cn` 时文件内容优先走 npmmirror |
| `LIBPEAK_FILE_MIRRORS` | 内置链 | 逗号分隔的 URL 模板，按序回退 |
| `LIBPEAK_TIMEOUT` | `10000` | HTTP 超时（毫秒） |

## Roadmap

- `mdnpeek` —— 同样的只读方式覆盖 MDN Web 文档（搜索 / 文档 / 兼容性）
- PyPI / crates.io 适配器（复用同样的四个命令）
- 免费托管 MCP 端点（`mcp.libpeek.dev`）

## 许可证

[MIT](./LICENSE)
