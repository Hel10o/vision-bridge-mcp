# Vision Bridge MCP 详细使用教程

> - 适用读者：第一次配置 MCP，或希望给纯文本大模型增加识图能力的使用者
> - 适用环境：Windows、macOS、Linux；Node.js 18 或更高版本
> - 文档目标：从克隆项目开始，完成视觉后端配置、MCP 接入、真实连通性验证和日常使用
> - 更新日期：2026-08-13
> - 验证范围：命令和配置已与 `2.0.0` 源码核对；95 项离线测试已通过；云端模型名称、权限和计费以服务商当前控制台为准

## 目录

- [1. 先理解这座“识图桥”](#1-先理解这座识图桥)
- [2. 安装前准备](#2-安装前准备)
- [3. 下载与检查项目](#3-下载与检查项目)
- [4. 选择视觉后端](#4-选择视觉后端)
- [5. 接入 ZCode](#5-接入-zcode)
- [6. 接入其它 MCP 客户端](#6-接入其它-mcp-客户端)
- [7. 分层验证](#7-分层验证)
- [8. 五个工具的完整用法](#8-五个工具的完整用法)
- [9. 常用后端配置](#9-常用后端配置)
- [10. 全部环境变量](#10-全部环境变量)
- [11. 路径、粘贴图片与多图](#11-路径粘贴图片与多图)
- [12. 缓存、重试与超时](#12-缓存重试与超时)
- [13. CLI 排查工具](#13-cli-排查工具)
- [14. 常见问题](#14-常见问题)
- [15. 安全与隐私](#15-安全与隐私)
- [16. 更新、卸载与开发](#16-更新卸载与开发)

## 1. 先理解这座“识图桥”

许多大模型擅长推理和写代码，但它们所使用的 API 不一定接受图片。Vision Bridge 把“看图”和“继续思考”拆成两个阶段：

1. 主模型判断当前任务需要看图；
2. 主模型调用一个 MCP 工具，并提供图片路径或 URL；
3. Vision Bridge 读取并校验图片；
4. Vision Bridge 把图片交给你配置的视觉模型；
5. 视觉模型返回文字；
6. 主模型拿到文字后继续排错、讲题、写代码或还原界面。

Vision Bridge 本身不包含视觉模型，也不会训练模型。它负责的是协议、路径、图片编码、请求、缓存、重试和结果格式化。

## 2. 安装前准备

需要准备：

| 项目 | 最低要求 | 检查方法 |
|---|---|---|
| Node.js | 18 或更高版本 | `node --version` |
| Git | 能执行 `git clone` | `git --version` |
| MCP 客户端 | 支持本地 `stdio` 服务器 | 查看客户端的 MCP 设置 |
| 视觉后端 | 云端 API 或本地视觉模型 | 本教程第 4 节 |

在 PowerShell 或终端执行：

```bash
node --version
git --version
```

如果 `node` 不存在，先从 [Node.js 官网](https://nodejs.org/) 安装长期支持版本。安装完成后关闭并重新打开终端，让新的 `PATH` 生效。

## 3. 下载与检查项目

### 3.1 克隆仓库

选择一个长期保留的目录，不要克隆到稍后会清理的临时文件夹。

```bash
git clone https://github.com/Hel10o/vision-bridge-mcp.git
cd vision-bridge-mcp
```

这个项目没有第三方运行时依赖，不需要先执行 `npm install`。`package.json` 主要提供版本、命令和 npm 包元数据。

### 3.2 Windows 路径写法

MCP 的 JSON 配置中推荐使用正斜杠：

```text
D:/tools/vision-bridge-mcp/server.js
```

如果使用反斜杠，则必须写成双反斜杠：

```text
D:\\tools\\vision-bridge-mcp\\server.js
```

### 3.3 确认服务器入口

在项目目录执行：

```bash
node server.js --version
node server.js --tools
```

应看到版本号和五个工具。这里仅验证本地代码能启动，不代表外部视觉 API 已连通。

## 4. 选择视觉后端

### 4.1 云端 OpenAI 兼容 API

适合希望快速使用、不想在本机加载大模型的场景。需要准备：

- API Key；
- API 根地址；
- 支持图片输入的模型名；
- 服务商确实支持 OpenAI Chat Completions 格式，或提供相应兼容层。

优点是部署简单、通常速度较快；缺点是图片会离开本机，并可能产生费用。

### 4.2 Gemini 原生 API

当 `VISION_API_BASE` 包含 `generativelanguage.googleapis.com` 且没有强制指定其它风格时，项目会自动使用 Gemini 原生 `generateContent` 端点。原生方式不接受远程图片 URL，需先把图片保存到本地。

### 4.3 本地视觉模型

适合隐私敏感、离线环境或希望控制成本的场景。Vision Bridge 可连接 Ollama、vLLM 或 LM Studio 暴露的 OpenAI 兼容端点。

本地模型不需要云端 API Key，但机器需要足够的内存或显存，识别质量与速度取决于所选模型和硬件。

## 5. 接入 ZCode

### 5.1 找到配置文件

Windows 默认位置：

```text
C:\Users\<你的用户名>\.zcode\cli\config.json
```

打开现有文件前先备份。若文件里已有其它设置，只添加 `vision-bridge` 服务器，不要用示例覆盖整个文件。

### 5.2 添加服务器配置

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
          "VISION_MAX_TOKENS": "4096",
          "VISION_ALLOWED_DIRS": "D:/Pictures,C:/Users/<你的用户名>/.zcode/cli/image-cache"
        }
      }
    }
  }
}
```

关键字段：

| 字段 | 含义 |
|---|---|
| `command` | 启动服务器的程序，这里是 `node` |
| `args` | 传给 Node.js 的参数，最后一项必须是实际 `server.js` 路径 |
| `env` | 只提供给该 MCP 进程的环境变量 |
| `VISION_ALLOWED_DIRS` | 可选目录白名单，多个目录用逗号分隔 |

### 5.3 代理环境

直连网络时保持：

```json
"args": ["D:/tools/vision-bridge-mcp/server.js"]
```

使用 Node.js 24 或更高版本，并且请求必须经过系统的 `HTTPS_PROXY` 时使用：

```json
"args": ["--use-env-proxy", "D:/tools/vision-bridge-mcp/server.js"]
```

`--use-env-proxy` 是 Node.js 启动参数，必须写在 `server.js` 之前。Node.js 18 至 23 不支持该参数。

### 5.4 让配置生效

保存 JSON 后完全退出并重新打开 ZCode，或新建一个能重新加载 MCP 服务器的会话。然后询问主模型有哪些 `vision-bridge` 工具，应该能看到五个工具。

## 6. 接入其它 MCP 客户端

不同客户端的配置文件路径和最外层键名可能不同，但 `stdio` 服务器的核心始终是下面三部分：

```json
{
  "command": "node",
  "args": ["/absolute/path/to/vision-bridge-mcp/server.js"],
  "env": {
    "VISION_API_KEY": "<YOUR_API_KEY>",
    "VISION_API_BASE": "https://provider.example/v1",
    "VISION_MODEL": "<VISION_MODEL_NAME>"
  }
}
```

接入时注意：

1. 使用 `stdio`，不是 HTTP 或 SSE；
2. 使用 `server.js` 的绝对路径；
3. 不要手动把服务器启动后一直放在终端等待，客户端会负责拉起进程；
4. 服务器的标准输出只用于 JSON-RPC，诊断信息写入日志或标准错误；
5. 客户端如果采用 `mcpServers`、`servers` 或 TOML 配置，只改变外层结构，`command`、`args` 和 `env` 的含义不变。

请以所用 MCP 客户端当前版本的官方配置格式为准。

## 7. 分层验证

### 7.1 第一层：本地代码与配置

在项目目录执行：

```bash
node server.js --doctor
```

重点检查：

- Node.js 版本是否符合要求；
- API Key 是否显示为打码状态，而不是“未设置”；
- API Base 和模型是否是你期望的值；
- 代理环境变量存在时，代理是否真的启用；
- 缓存和日志目录是否可写。

`--doctor` 不发送网络请求，因此“配置完整”仍不等于真实视觉链路成功。

### 7.2 第二层：真实视觉链路

```bash
node server.js --ping
```

命令会临时生成一张左红右蓝的 PNG，调用视觉后端，并检查回答是否包含红色和蓝色。成功证据是最后出现：

```text
✓ 视觉链路正常（颜色答对了）
```

这一步会真实调用 API，可能消耗额度。测试图会在结束后清理。

### 7.3 第三层：MCP 客户端调用

重启客户端后，在对话里发送：

```text
请列出 Vision Bridge 提供的识图工具。
```

然后用一张非敏感测试图片尝试 OCR。此层成功说明客户端配置、MCP 协议、图片读取和视觉后端已经串联起来。

### 7.4 离线回归测试

```bash
npm test
```

这组测试不使用真实 API。当前版本预期为 95 项通过、0 项失败，另有 4 项真实 API 测试跳过。

## 8. 五个工具的完整用法

### 8.1 公共图片参数

| 参数 | 类型 | 作用 |
|---|---|---|
| `image_path` | 字符串 | 一张本地图片、`latest`，也可容错接收 URL |
| `image_paths` | 字符串数组 | 多张本地图片 |
| `image_url` | 字符串 | 一张 HTTP(S) 网络图片 |
| `image_urls` | 字符串数组 | 多张 HTTP(S) 网络图片 |
| `prompt` | 字符串 | 自定义问题；专用工具中作为额外要求追加 |

至少提供一种图片参数。`compare_images` 应提供两张或更多图片。单次图片上限由 `VISION_MAX_IMAGES` 控制，默认为 8。

### 8.2 `ocr_image`：完整转录文字

适用：文档、试卷、表格、PPT、网页、聊天记录、终端、代码、公式和手写笔记。

对话示例：

```text
把 D:/shots/lecture.png 中的全部文字逐字转录出来，表格使用 Markdown。
```

额外要求示例：

```text
OCR 这张图片，只输出第二个表格，并保留所有数字的小数位。
```

如果目标是拿到原文，优先使用 `ocr_image`，不要用通用工具重新发明 OCR 提示词。

### 8.3 `read_error_screenshot`：读取报错

适用：终端、IDE、浏览器控制台、崩溃对话框和 CI 截图。

```text
读取 D:/shots/build-error.png，先逐字抄出错误，再结合当前项目定位原因。
```

Vision Bridge 负责从图中提取信息；最终根因仍应由主模型结合源码、运行环境和日志判断。

### 8.4 `describe_ui`：截图转实现规格

适用：网页、桌面应用、移动端设计稿和组件截图。

```text
分析 D:/design/dashboard.png，给出组件树、布局尺寸、间距、字号、颜色和交互状态。
```

截图只能展示可见状态，无法证明隐藏交互、响应式断点和后端行为。实现前应把这些内容当作待确认项。

### 8.5 `compare_images`：多图差异

```text
对比 D:/shots/before.png 和 D:/shots/after.png，逐项说明文字、布局、颜色和状态变化。
```

图片顺序很重要，结果使用“图 1”“图 2”指代。建议在对话中明确哪张是修改前、哪张是修改后。

### 8.6 `analyze_image`：自由提问

```text
分析 D:/charts/sales.png：趋势在哪里转折，哪些结论能直接从图中得到，哪些只是推测？
```

`prompt` 越具体，结果越稳定。可以明确要求语言、输出结构、关注区域以及是否转录可见文字。

## 9. 常用后端配置

以下代码块都是 MCP 配置中 `env` 的内容，不是完整配置文件。

### 9.1 默认 OpenAI 兼容示例

```json
{
  "VISION_API_KEY": "<YOUR_API_KEY>",
  "VISION_API_BASE": "https://open.bigmodel.cn/api/paas/v4",
  "VISION_MODEL": "glm-4v-flash",
  "VISION_API_STYLE": "openai",
  "VISION_MAX_TOKENS": "4096"
}
```

模型是否可用、是否需要开通以及如何计费，必须以服务商当前控制台为准。

### 9.2 任意 OpenAI 兼容服务

```json
{
  "VISION_API_KEY": "<YOUR_API_KEY>",
  "VISION_API_BASE": "https://provider.example/v1",
  "VISION_MODEL": "<VISION_MODEL_NAME>",
  "VISION_API_STYLE": "openai"
}
```

常见错误是 `VISION_API_BASE` 漏掉服务商要求的 `/v1` 或兼容路径，最终访问了不存在的 `/chat/completions`。

### 9.3 配置模型降级链

同一服务商、共用 Base 和 Key：

```json
{
  "VISION_MODEL": "primary-vision-model,backup-vision-model"
}
```

跨服务商建议使用 JSON 数组：

```json
{
  "VISION_API_KEY": "<PRIMARY_API_KEY>",
  "VISION_API_BASE": "https://primary.example/v1",
  "VISION_MODEL": "primary-vision-model",
  "VISION_FALLBACKS": "[{\"model\":\"backup-vision-model\",\"api_base\":\"https://backup.example/v1\",\"api_key\":\"<BACKUP_API_KEY>\",\"api_style\":\"openai\"}]"
}
```

`VISION_FALLBACKS` 是环境变量，所以它的值本身必须是一个 JSON 字符串。

### 9.4 Gemini 原生端点

```json
{
  "VISION_API_KEY": "<GEMINI_API_KEY>",
  "VISION_API_BASE": "https://generativelanguage.googleapis.com/v1beta/openai",
  "VISION_MODEL": "<GEMINI_VISION_MODEL>"
}
```

项目检测到 Google 域名后会自动切换为 `gemini-native`，去掉 `/openai` 后缀并请求 `generateContent`。原生方式会关闭 thinking 预算，以减少长 OCR 被思考内容挤占输出空间的情况。

### 9.5 通过兼容中转使用推理型视觉模型

```json
{
  "VISION_API_KEY": "<YOUR_API_KEY>",
  "VISION_API_BASE": "https://provider.example/v1",
  "VISION_MODEL": "<VISION_MODEL_NAME>",
  "VISION_API_STYLE": "openai",
  "VISION_REASONING_EFFORT": "none",
  "VISION_MAX_TOKENS": "8192"
}
```

如果中转站不接受 `reasoning_effort`，项目会自动去掉该字段再试。服务商需要私有参数时，可通过 `VISION_EXTRA_BODY` 深合并请求体。

### 9.6 本地 Ollama

先在 Ollama 中准备支持图片输入的模型。例如，模型名称以本机 `ollama list` 的实际结果为准。

```bash
ollama list
```

MCP 环境变量：

```json
{
  "VISION_API_KEY": "",
  "VISION_API_BASE": "http://localhost:11434/v1",
  "VISION_MODEL": "qwen2.5-vl",
  "VISION_API_STYLE": "openai",
  "NO_PROXY": "localhost,127.0.0.1"
}
```

`VISION_API_KEY` 可以留空。本地地址不会附带 `Authorization` 请求头。

## 10. 全部环境变量

### 10.1 服务商与生成

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_API_KEY` | 空 | 云端 API Key；本地后端可空 |
| `VISION_API_BASE` | `https://open.bigmodel.cn/api/paas/v4` | API 根地址 |
| `VISION_MODEL` | `glm-4v-flash` | 模型名或逗号分隔候选链 |
| `VISION_API_STYLE` | 自动 | `openai` 或 `gemini-native` |
| `VISION_FALLBACKS` | 空 | 跨服务商候选的 JSON 数组字符串 |
| `VISION_MAX_TOKENS` | `4096` | 最大输出 token 数 |
| `VISION_MAX_TOKENS_FIELD` | `auto` | `auto`、`max_tokens` 或 `max_completion_tokens` |
| `VISION_TEMPERATURE` | 按工具 | 全局覆盖温度 |
| `VISION_REASONING_EFFORT` | 空 | 可用于关闭兼容端点的推理模式 |
| `VISION_EXTRA_BODY` | `{}` | 深合并进请求体的 JSON 对象字符串 |

### 10.2 图片与路径

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_MAX_IMAGE_MB` | `5` | 单图 base64 编码后体积上限，单位 MB |
| `VISION_MAX_IMAGES` | `8` | 单次调用图片数上限，范围 1 至 32 |
| `VISION_BASE_DIR` | 空 | 相对路径优先搜索目录，可逗号分隔 |
| `VISION_SEARCH_DIRS` | 空 | 附加搜索目录，作用与上一项相同 |
| `VISION_PASTE_DIRS` | `~/.zcode/cli/image-cache` | `latest` 扫描目录，可逗号分隔 |
| `VISION_ALLOWED_DIRS` | 空 | 读取白名单；空表示不限制 |

### 10.3 网络、缓存与日志

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_TIMEOUT_MS` | `120000` | 单个上游请求超时，单位毫秒 |
| `VISION_RETRIES` | `3` | 每个候选的最大尝试次数 |
| `VISION_RETRY_BASE_MS` | `500` | 指数退避基数 |
| `VISION_RETRY_MAX_WAIT_MS` | `20000` | 单次重试等待上限 |
| `VISION_MAX_CONCURRENT` | `2` | 上游并发上限 |
| `VISION_CACHE` | `disk` | `disk`、`memory` 或 `off` |
| `VISION_CACHE_DIR` | `~/.zcode/vision-bridge/cache` | 磁盘缓存目录 |
| `VISION_CACHE_TTL_HOURS` | `168` | 缓存有效期，默认 7 天 |
| `VISION_CACHE_MAX` | `300` | 最大缓存条目数 |
| `VISION_LOG` | `true` | 是否写日志 |
| `VISION_LOG_DIR` | `~/.zcode/vision-bridge/logs` | 日志目录 |
| `VISION_LOG_KEEP_DAYS` | `14` | 日志保留天数 |
| `VISION_LOG_LEVEL` | `info` | `debug`、`info`、`warn` 或 `error` |
| `VISION_SHOW_META` | `true` | 是否在正文末尾附模型、耗时和用量信息 |
| `VISION_CANCEL_MODE` | `detach` | 客户端取消时使用 `detach` 或 `abort` |

## 11. 路径、粘贴图片与多图

### 11.1 支持的路径写法

Vision Bridge 会处理：

- 绝对路径；
- 相对路径；
- `~/Pictures/a.png`；
- `%USERPROFILE%/Pictures/a.png`；
- `file:///C:/Pictures/a.png`；
- Git Bash 风格 `/c/Users/...`；
- WSL 风格 `/mnt/c/Users/...`；
- HTTP(S) 图片 URL；
- `latest`、`最新`、`剪贴板`、`clipboard`。

相对路径依次在 `VISION_BASE_DIR`、`VISION_SEARCH_DIRS`、服务器当前目录、用户目录、桌面、下载和常见图片目录中查找。找不到时，错误结果会列出尝试过的位置。

### 11.2 直接粘贴图片

ZCode 通常把粘贴图片放在：

```text
~/.zcode/cli/image-cache/sess_<会话标识>/
```

工具收到 `image_path: "latest"` 后会扫描 `VISION_PASTE_DIRS`，选择最近修改的受支持图片。为避免误取：

1. 粘贴后立即发出识图请求；
2. 查看返回末尾的实际文件路径和距今时间；
3. 有歧义时直接提供完整路径。

### 11.3 多图输入

CLI 可重复传 `--image`：

```bash
node server.js --call compare_images --image D:/shots/before.png --image D:/shots/after.png
```

MCP 工具层使用 `image_paths` 或 `image_urls` 数组。项目会按输入顺序插入“图 1”“图 2”标签。

### 11.4 图片格式和大小

支持 PNG、JPEG、GIF、WebP 和 BMP。格式依据文件内容判断，不依据扩展名。HEIC、AVIF、TIFF、SVG 和 PDF 需要先转换为受支持的位图格式。

体积上限按 base64 编码后的大小计算，通常约为原文件的 1.33 倍。遇到上限错误时优先压缩、裁剪或分批处理，不要盲目提高限制。

## 12. 缓存、重试与超时

### 12.1 缓存键

缓存由图片内容 hash、提示词、工具、模型和关键生成参数共同决定。图片不变但问题变化时，会重新调用视觉后端。

清空缓存：

```bash
node server.js --clear-cache
```

该命令只删除 `VISION_CACHE_DIR` 中由本项目管理的缓存条目，不删除原始图片。

### 12.2 自动重试

HTTP 429、5xx 和可恢复网络错误会做指数退避重试，并尊重合理范围内的 `Retry-After`。401、403、404 等通常不会靠等待自愈，项目会尽快报告或切换候选。

### 12.3 相同请求合并

当两个相同请求同时到达时，Vision Bridge 只发起一次上游调用，其它请求等待同一结果。这可以避免模型重复调用造成重复计费。

### 12.4 客户端先超时

默认 `VISION_CANCEL_MODE=detach`：客户端取消后，上游继续运行并写入缓存。主模型稍后用相同参数重试时，可能直接命中进行中的请求或缓存。

如果希望按下取消后立即中断网络请求，设置：

```json
{
  "VISION_CANCEL_MODE": "abort"
}
```

输入 token 往往在中断前已经发送，因此 `abort` 不保证服务商不计费。

## 13. CLI 排查工具

### 13.1 查看帮助、版本和工具

```bash
node server.js --help
node server.js --version
node server.js --tools
```

这些命令不调用外部 API。

### 13.2 直接调用工具

```bash
node server.js --call ocr_image --image D:/shots/a.png
```

```bash
node server.js --call analyze_image --image latest --prompt "图中最重要的信息是什么？"
```

加入 `--json` 可查看 `structuredContent`、模型、缓存状态、用量和图片来源：

```bash
node server.js --call analyze_image --image D:/shots/a.png --prompt "描述这张图" --json
```

直接调用可以把“视觉后端故障”和“MCP 客户端配置故障”分开排查。

### 13.3 查看日志

默认日志目录：

```text
~/.zcode/vision-bridge/logs/
```

每日日志文件名为 `YYYY-MM-DD.log`。日志包含耗时、模型、错误码、重试和可用时的 token 用量，不记录完整 API Key。

## 14. 常见问题

| 现象 | 最可能原因 | 优先检查 |
|---|---|---|
| 未配置 `VISION_API_KEY` | 客户端没有把 `env` 传给进程，或未重启 | `node server.js --doctor` 与客户端配置 |
| HTTP 401 | Key 错误、过期或传给了错误服务商 | Key 和 API Base 是否配套 |
| HTTP 403 | Key 没有模型权限或被风控 | 服务商控制台中的权限 |
| HTTP 404 | Base 路径或模型名错误 | 是否漏掉 `/v1` 或兼容路径 |
| HTTP 429 | 限流或额度耗尽 | 降低并发、稍后重试或配置降级链 |
| 域名解析失败 | 域名、DNS 或代理问题 | `--doctor` 的代理状态 |
| 返回空内容 | 推理过程挤占输出或服务商响应异常 | 关闭推理、提高 token 上限、换模型 |
| 内容开头出现截断警告 | `finish_reason` 表明输出达到上限 | 调高 `VISION_MAX_TOKENS` 或裁图 |
| 不是可识别图片 | 扩展名与实际内容不符或格式不支持 | 转成 PNG/JPEG 后再试 |
| 找不到相对路径 | MCP 进程工作目录与项目目录不同 | 使用绝对路径或配置 `VISION_BASE_DIR` |
| `latest` 取错图片 | 粘贴目录里有更新的其它图片 | 查看结果末尾路径，改用绝对路径 |
| 客户端 30 秒超时 | 视觉模型响应慢于客户端限制 | 原样重试命中缓存，或换更快模型 |
| CLI 成功、客户端失败 | MCP JSON 路径或进程环境错误 | 重启客户端并检查绝对路径 |

## 15. 安全与隐私

### 15.1 图片是否离开本机

- 云端 API：图片会以 base64 或 URL 形式发送给配置的服务商；
- 本地 Ollama、vLLM、LM Studio：请求发往本机地址，图片无需离开本机；
- 远程图片 URL：OpenAI 兼容端点可能由服务商直接抓取该 URL。

不要把身份证、密码、密钥、Cookie、未公开源码或客户数据发送给未经授权的服务商。

### 15.2 限制可读目录

推荐在 MCP 配置中设置：

```json
{
  "VISION_ALLOWED_DIRS": "D:/Pictures,C:/Users/<你的用户名>/.zcode/cli/image-cache"
}
```

设置后，目录外文件会被拒绝。Windows 多目录用逗号或分号分隔，不要用冒号分隔，以免破坏盘符。

### 15.3 保护 API Key

- 把 Key 放在 MCP 客户端的本地 `env` 配置中；
- 不要把真实 Key 写进 README、脚本、Issue 或截图；
- 不要提交 `.env`、`.claude/`、`.vscode/` 或本地配置；
- 若 Key 曾进入 Git 历史，仅删除当前文件不够，应立即在服务商处撤销并重新生成。

### 15.4 图片中的提示注入

图片可能包含“忽略之前指令”等恶意文字。OCR 结果应被当作不可信数据，而不是新的系统指令。主模型应只围绕用户原始目标处理这些文字。

## 16. 更新、卸载与开发

### 16.1 更新项目

先确认本地没有需要保留的源码修改：

```bash
git status
git pull --ff-only
npm test
```

`git pull --ff-only` 不会自动制造合并提交；如果本地有冲突修改，它会停止并要求先处理。

### 16.2 卸载

1. 从 MCP 客户端配置中删除 `vision-bridge` 服务器；
2. 重启客户端；
3. 确认不再需要缓存和日志；
4. 手动删除项目目录以及 `~/.zcode/vision-bridge/` 状态目录。

删除操作不可由本教程替你确认目标路径。执行前务必核对绝对路径，避免误删其它项目或图片。

### 16.3 运行测试

离线测试：

```bash
npm test
```

真实 API 测试：

```bash
npm run test:live
```

真实测试会读取 `VISION_API_KEY` 等环境变量，或尝试从本机 ZCode 配置加载对应环境，并可能产生费用。

### 16.4 测试范围

当前测试覆盖：

- 图片 magic bytes、格式和 base64 体积；
- Windows、Git Bash、WSL、`file://`、相对路径与 `latest`；
- 目录白名单；
- MCP 初始化、通知、错误结果、批量请求和进程存活；
- mock API 下的重试、降级、缓存、截断、取消和参数兼容；
- 真实 API 下的颜色识别、元信息和缓存，但默认跳过。

离线测试通过证明代码在模拟环境和协议层满足断言，不等于每个第三方服务商、模型或 MCP 客户端都已完成端到端验证。
