# Vision Bridge MCP

[![CI](https://github.com/Hel10o/vision-bridge-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/Hel10o/vision-bridge-mcp/actions/workflows/test.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

给纯文本大模型补上识图能力的 [Model Context Protocol（MCP）](https://modelcontextprotocol.io/) 服务器。

主模型通过 MCP 把本地图片、网络图片或多张对比图交给外部视觉模型，取得结构化文字结果后继续分析、编程和排错。项目只使用 Node.js 内置模块，无第三方运行时依赖。

> - 当前版本：`2.0.0`
> - 适用环境：Windows、macOS、Linux；Node.js 18 或更高版本
> - 验证范围：95 项离线测试通过；真实视觉 API 测试默认跳过，需由使用者显式运行

## 目录

- [1. 项目能做什么](#1-项目能做什么)
- [2. 工作原理](#2-工作原理)
- [3. 五个识图工具](#3-五个识图工具)
- [4. 快速开始](#4-快速开始)
- [5. 如何使用](#5-如何使用)
- [6. 视觉服务商](#6-视觉服务商)
- [7. 可靠性与安全](#7-可靠性与安全)
- [8. 命令与开发](#8-命令与开发)
- [9. 项目结构](#9-项目结构)
- [10. 文档与许可证](#10-文档与许可证)

## 1. 项目能做什么

- 精确转录文档、试卷、PPT、网页、终端、代码和手写笔记截图。
- 从报错截图中提取错误类型、完整信息、堆栈、文件路径和行号。
- 把 UI 截图或设计稿转换为组件树、尺寸、间距、字号、配色和交互说明。
- 对比两张或多张图片，列出文案、布局、颜色、状态和数据差异。
- 用自然语言对照片、图表、题目等任意图片提问。
- 支持本地路径、`file://`、HTTP(S) URL、多图数组以及刚粘贴图片的 `latest` 快捷方式。
- 支持 OpenAI Chat Completions 兼容端点、Gemini 原生端点以及 Ollama、vLLM、LM Studio 等本地服务。
- 自动重试、模型降级、同请求合并和结果缓存，减少临时故障及重复计费。

## 2. 工作原理

```text
用户提供图片路径、URL 或直接粘贴图片
        ↓
MCP 客户端中的主模型调用 Vision Bridge 工具
        ↓
Vision Bridge 校验路径、图片格式、目录权限和 base64 体积
        ↓
视觉 API 或本地视觉模型识别图片
        ↓
识别正文、模型信息、耗时、用量和图片来源返回给主模型
        ↓
主模型继续回答、排错或编写代码
```

Vision Bridge 使用 MCP 的 `stdio` 传输方式。客户端负责启动 `node server.js`；通常不需要手动让服务器常驻运行。

## 3. 五个识图工具

| 工具 | 适用场景 | 主要输出 |
|---|---|---|
| `ocr_image` | 文档、试卷、PPT、网页、代码、聊天记录、手写笔记 | 逐字转录；表格转 Markdown；公式转 LaTeX；保留代码缩进 |
| `read_error_screenshot` | 终端、浏览器控制台、IDE、崩溃窗口、CI 失败截图 | 错误类型、完整信息、调用链、位置与上下文 |
| `describe_ui` | 页面截图、设计稿、界面复刻 | 组件树、文案、尺寸、间距、字号、颜色与交互状态 |
| `compare_images` | 改动前后、多个版本、视觉回归 | 逐图概述、差异、相同点与结论 |
| `analyze_image` | 照片、图表、题目等通用场景 | 根据自定义 `prompt` 回答具体问题 |

## 4. 快速开始

### 4.1 获取项目

在 PowerShell、终端或 Bash 中执行：

```bash
git clone https://github.com/Hel10o/vision-bridge-mcp.git
cd vision-bridge-mcp
node --version
```

最后一条命令应显示 `v18.0.0` 或更高版本。项目没有第三方运行时依赖，因此无需执行 `npm install`。

### 4.2 准备视觉后端

你需要以下两种后端之一：

1. 一个支持图片输入的 OpenAI Chat Completions 兼容 API；
2. 本机运行的 Ollama、vLLM 或 LM Studio 视觉模型。

下面使用项目默认的 OpenAI 兼容配置作为示例。请把 API Key 保存在 MCP 客户端配置的 `env` 中，不要写进仓库。

### 4.3 配置 ZCode

Windows 上编辑 `C:\Users\<你的用户名>\.zcode\cli\config.json`，把路径替换为实际克隆位置：

```json
{
  "mcp": {
    "servers": {
      "vision-bridge": {
        "command": "node",
        "args": ["D:/tools/vision-bridge-mcp/server.js"],
        "env": {
          "VISION_API_KEY": "<YOUR_API_KEY>",
          "VISION_API_BASE": "https://open.bigmodel.cn/api/paas/v4",
          "VISION_MODEL": "glm-4v-flash",
          "VISION_MAX_TOKENS": "4096"
        }
      }
    }
  }
}
```

配置文件已经有其它内容时，只合并 `mcp.servers.vision-bridge`，不要覆盖整个文件。

如果网络必须经过 `HTTPS_PROXY`，并且使用 Node.js 24 或更高版本，可把 `args` 改成：

```json
["--use-env-proxy", "D:/tools/vision-bridge-mcp/server.js"]
```

Node.js 18 至 23 不支持 `--use-env-proxy`，直连时也不需要该参数。

### 4.4 分层验证

在项目目录执行：

```bash
node server.js --doctor
node server.js --ping
npm test
```

- `--doctor`：检查生效配置、缓存、日志和代理状态；Key 会自动打码。
- `--ping`：生成一张左红右蓝的测试图，并真实调用视觉后端；这一步可能消耗额度。
- `npm test`：运行 95 项离线测试，不调用外部视觉 API。

看到 `--ping` 正确识别“左红右蓝”后，重启 MCP 客户端或新建会话。客户端应加载五个 `vision-bridge` 工具。

## 5. 如何使用

配置完成后直接在对话中描述目标，主模型会选择合适的工具。例如：

```text
把 D:/shots/report.png 里的文字完整转成 Markdown。
```

```text
看一下 C:/shots/error.png，这是什么报错？请给出修复步骤。
```

```text
按照 D:/design/login-page.png 还原这个页面。
```

```text
对比 D:/shots/before.png 和 D:/shots/after.png，样式改动是否生效？
```

刚把图片粘贴到 ZCode 对话框时，可以直接说：

```text
读取我刚粘贴的图片中的全部文字。
```

工具会使用 `image_path: "latest"` 查找最新落盘图片。返回结果末尾会标明实际使用的文件，建议确认它没有误取旧图。

更多参数、完整配置和逐场景教程见[详细使用教程](docs/USAGE_GUIDE.md)。

## 6. 视觉服务商

### 6.1 OpenAI 兼容端点

```json
{
  "VISION_API_KEY": "<YOUR_API_KEY>",
  "VISION_API_BASE": "https://provider.example/v1",
  "VISION_MODEL": "<VISION_MODEL_NAME>",
  "VISION_API_STYLE": "openai"
}
```

`VISION_API_BASE` 必须指向兼容端点的根路径，Vision Bridge 会在其后请求 `/chat/completions`。

### 6.2 本地 Ollama

先在本机准备一个支持图片的模型，再将 MCP 环境变量设为：

```json
{
  "VISION_API_KEY": "",
  "VISION_API_BASE": "http://localhost:11434/v1",
  "VISION_MODEL": "qwen2.5-vl",
  "NO_PROXY": "localhost,127.0.0.1"
}
```

本地地址不会发送 `Authorization` 请求头，图片也不会离开本机。

### 6.3 自动降级

同一服务商的多个模型可用逗号分隔：

```json
{
  "VISION_MODEL": "primary-vision-model,backup-vision-model"
}
```

跨服务商时建议使用 `VISION_FALLBACKS`。完整示例见[教程中的降级配置](docs/USAGE_GUIDE.md#93-配置模型降级链)。

## 7. 可靠性与安全

- **图片出站**：使用云端后端时，本地图片会上传给所配置的服务商；敏感图片优先使用本地模型。
- **目录白名单**：默认可读取当前用户有权限访问的图片。建议通过 `VISION_ALLOWED_DIRS` 限制可读取目录。
- **真实格式检查**：按 magic bytes 判断 PNG、JPEG、GIF、WebP、BMP，不盲信扩展名。
- **体积检查**：按 base64 编码后的体积限制请求，避免原图看似未超限但 API 拒绝。
- **缓存**：同图、同提示词、同模型和同参数会命中缓存，默认保留 7 天。
- **重试和降级**：网络故障、HTTP 429 和 5xx 会自动重试；不可恢复错误会尽快切换候选。
- **密钥保护**：`--doctor`、日志和 MCP 返回不会输出完整 API Key。仍应避免把密钥写入源码、截图或 Git。
- **提示注入**：图片里的文字属于待分析数据，不应被主模型当作新的系统指令执行。

## 8. 命令与开发

```bash
node server.js --help
node server.js --version
node server.js --tools
node server.js --doctor
node server.js --ping
node server.js --call ocr_image --image D:/shots/a.png
node server.js --call analyze_image --image latest --prompt "这是什么？" --json
node server.js --clear-cache
npm test
npm run test:live
```

`npm run test:live` 会读取环境变量或本机 ZCode 配置中的视觉后端，并产生真实 API 调用。只有确认愿意消耗额度时才运行。

当前离线测试覆盖图片校验、路径归一化、`latest`、目录白名单、缓存、重试、降级、参数兼容、MCP 协议和 mock API 端到端流程。

## 9. 项目结构

```text
vision-bridge-mcp/
├── server.js              # MCP 协议层与调试 CLI
├── lib/
│   ├── config.js          # 环境变量、候选模型和路径配置
│   ├── image.js           # 路径归一化、图片校验和 latest
│   ├── vision.js          # API 调用、重试、降级和响应解析
│   ├── tools.js           # 五个 MCP 工具及内置提示词
│   ├── cache.js           # 内存与磁盘缓存
│   ├── log.js             # 按天日志
│   ├── errors.js          # 可供模型理解的业务错误
│   └── pngwriter.js       # 自检测试图生成
├── test/                  # 离线、协议、mock API 和真实 API 测试
├── examples/              # 独立诊断示例
├── docs/                  # 详细教程
└── package.json
```

运行时生成的 `cache/`、`logs/` 和个人配置不会提交到 Git。

## 10. 文档与许可证

- [详细使用教程](docs/USAGE_GUIDE.md)
- [诊断脚本说明](examples/README.md)
- [MIT License](LICENSE)

如果遇到可以稳定复现的问题，请在 GitHub Issue 中附上 Node.js 版本、`node server.js --doctor` 的脱敏输出、错误现象和复现步骤，不要附 API Key 或含隐私的原始图片。
