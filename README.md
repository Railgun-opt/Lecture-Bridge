# Lecture Bridge

本地优先的课堂英语实时中文字幕工具。使用清晰的两段式管线：实时英文转写 → 按停顿断句 → 文本模型翻译。支持课程背景、术语表和中英双语字幕。

转写和翻译可以使用不同供应商，分别配置各自的 Base URL、API Key 和模型名称。Realtime 服务通过 WebRTC 接收音频；Groq/Whisper 文件接口使用浏览器端 AudioWorklet、语音活动检测和 16kHz 单声道 WAV 自适应分片。应用不会在本机保存音频。正式 API Key 仅由本机 Node 服务读取，不会发送给前端。字幕保存在浏览器 LocalStorage，可导出 Markdown 或 SRT。

## 1. 环境要求

- Node.js 20 或更高版本
- Chromium 系浏览器（推荐最新版 Chrome）
- 支持 OpenAI Realtime WebRTC，或 Groq/Whisper 文件转写接口的转写服务
- 支持 OpenAI-compatible Chat Completions 接口的文本模型服务

## 2. 安装

```bash
npm install
```

启动网页后点击右上角“模型配置”，两个服务分别填写 Base URL、API Key 和 Model Name，保存后立即生效。配置由本机 Node 服务写入权限为 `600` 的 `.env`；浏览器不会读取或回显完整 API Key。

也可以直接编辑项目中的 `.env`，模型名称没有预设：

首次配置可先运行 `cp .env.example .env`。`.env`、各环境配置文件、日志和构建产物已被 Git 忽略；仓库只保留不含密钥的 `.env.example`。请勿把真实 API Key 写入源码、文档或提交记录。

```dotenv
TRANSCRIPTION_API_BASE_URL=
TRANSCRIPTION_API_KEY=
TRANSCRIPTION_MODEL=
TRANSCRIPTION_PROXY_URL=

TRANSLATION_API_BASE_URL=
TRANSLATION_API_KEY=
TRANSLATION_MODEL=
TRANSLATION_PROXY_URL=

PORT=8787
```

Base URL 可以写成 `https://api.example.com` 或 `https://api.example.com/v1`，程序会避免重复拼接 `/v1`。Realtime 模型使用 `/v1/realtime/calls`；Groq 或名称以 `whisper` 开头的模型会自动切换到 `/v1/audio/transcriptions`。程序会在老师自然停顿时提交音频，连续讲话时按照页面选项设置的 3.2～6 秒最长分片提交；相邻连续分片保留短重叠并自动去除重复文本。音频批次返回后，英文和中文会分别按句末、从句标点及字幕行长度排版，不会因为合并请求而显示成一整段。对于 Groq，服务端会把请求间隔控制在 3.2 秒以上，并根据 `Retry-After` 自动等待和重试 429，以适配每分钟 20 次的常见按需层限制。翻译供应商必须实现 `/v1/chat/completions`。当翻译模型名称包含 `translategemma` 时，服务端会自动切换到 TranslateGemma 的单条用户消息格式，明确使用英语到简体中文的语言代码，并把上下文、术语表和逐行字幕约束放在正文之前；其他模型仍使用通用 Chat Completions 提示词。网页保存的配置会立即进入当前服务内存，因此不需要重启。

如果某个供应商需要代理，只填写该服务的 Proxy URL，例如 `http://127.0.0.1:7897`。代理按服务隔离：转写服务设置代理不会影响翻译服务。支持 HTTP 和 HTTPS 代理；访问 HTTPS API 时使用 CONNECT 隧道。

## 3. 像 App 一样使用（macOS 推荐）

Lecture Bridge 支持安装为 PWA：在独立窗口中运行、拥有自己的图标并可固定到 Dock，同时保留 Chrome 的浏览器标签页音频捕获能力。本机 Node 服务由 macOS LaunchAgent 在登录后自动启动，不需要再打开终端。

首次安装：

```bash
npm run app:install
```

安装脚本会构建生产版本、注册后台服务并用 Chrome 打开 Lecture Bridge。随后点击页面右上角的“安装应用”，确认后即可从 Dock 或 Spotlight 启动。关闭应用窗口不会停止轻量的本机后台服务，下次点击图标可以直接使用。

检查后台状态：

```bash
npm run app:status
```

更新项目代码后，再运行一次 `npm run app:install` 即可重新构建并重启后台服务。

卸载后台自动启动：

```bash
npm run app:uninstall
```

卸载脚本不会删除项目、`.env`、日志或浏览器内的字幕。PWA 本身可在 Chrome 的 Lecture Bridge 应用菜单中卸载。后台日志位于 `~/Library/Logs/Lecture Bridge/`。

## 4. 通过终端启动

开发模式：

```bash
npm run dev
```

打开 <http://127.0.0.1:5173>。

生产构建：

```bash
npm run build
npm start
```

打开 <http://127.0.0.1:8787>。

## 5. 使用

### 实体课堂

1. 选择“麦克风”。
2. 尽量使用靠近老师的外接、领夹或指向性麦克风。
3. 观察输入电平，确认老师讲话时电平明显变化。

### 在线课堂

1. 选择“浏览器标签页”。
2. 点击开始后，在 Chrome 的分享窗口中选择正在播放课程的标签页。
3. 必须勾选“共享标签页音频”。

### 字幕小窗

点击实时字幕右上方的“字幕小窗”，程序会优先打开能够悬浮在其他应用上方的浏览器画中画窗口，只同步显示上一条和当前一条字幕。不支持该能力的浏览器会自动使用可调整大小的普通弹窗。关闭小窗不会停止主页面的录音、转写或翻译，也不会增加模型请求数量。

会话设置中的英文和中文字体、大小可以分别调整，并且能在转写过程中随时修改。中文字体额外支持项目内置的“汉仪国图创新红楼梦 55U”，无需另行安装系统字体。字号以百分比显示，100% 为标准大小，可在 75%～200% 之间选择；主字幕、课堂记录和字幕小窗会同步更新并自动记住选择。旧版的小、标准、大、特大设置会自动迁移为 75%、100%、125%、150%。

### 术语表

每行一条，支持 `=`、`:`、`->` 或 `=>`：

```text
gradient descent = 梯度下降
backpropagation = 反向传播
CRISPR-Cas9 = CRISPR-Cas9
```

英文术语会同时作为实时转写关键词提示，并在文本翻译时强制使用指定中文。

## 6. 验证与故障排除

```bash
npm run check
npm run build
```

- **开始按钮不可用**：点击右上角“模型配置”，检查两个服务是否都填写了 Base URL、API Key 和 Model Name。
- **没有出现“安装应用”按钮**：确认使用 Chrome 打开生产地址 `http://127.0.0.1:8787`，刷新一次并等待几秒；已经安装时不会再次显示按钮。
- **后台服务无法连接**：运行 `npm run app:status`，并查看 `~/Library/Logs/Lecture Bridge/server-error.log`。
- **标签页没有声音**：确认选择的是 Chrome 标签页而不是整个屏幕，并开启“共享标签页音频”。
- **麦克风识别很差**：先改善距离和混响；远场收音质量通常比模型大小更重要。
- **浏览器不支持 AudioWorklet**：程序会自动退回 MediaRecorder 固定分片，不会阻止转写。
- **连接中断**：校园网络可能限制 WebRTC/UDP，尝试手机热点；WebRTC 也可能回落到其他传输路径。

## 7. 当前设计边界

- 这是个人本地应用，没有账号系统和多人广播。
- 实时字幕的时间戳是应用级近似时间，不是词级时间戳。
- 文件转写模式使用本地 VAD 按停顿分句；老师长时间不停顿时会在所选最长分片处提交，中文仍可能比英文稍慢。
- 字幕保存在当前浏览器。清理站点数据会删除未导出的历史记录。
- 录音或转写课堂前，请遵守老师、学校和当地适用的录音及无障碍辅助规定。

## 8. 官方接口依据

- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Realtime API with WebRTC](https://developers.openai.com/api/docs/guides/realtime-webrtc)
- [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
