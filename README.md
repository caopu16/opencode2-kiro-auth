# opencode2-kiro-auth（opencode v2 版 Kiro 插件）

[![npm version](https://img.shields.io/npm/v/@caopu16/opencode2-kiro-auth)](https://www.npmjs.com/package/@caopu16/opencode2-kiro-auth)
[![license](https://img.shields.io/npm/l/@caopu16/opencode2-kiro-auth)](https://www.npmjs.com/package/@caopu16/opencode2-kiro-auth)

一个用于 AWS Kiro（CodeWhisperer）的 OpenCode 插件，让你在 OpenCode 里直接使用
Claude Sonnet / Opus / Haiku 等模型，并带有相当可观的试用额度。

> **本仓库说明**
>
> 本项目在上游 [`@zhafron/opencode-kiro-auth`](https://www.npmjs.com/package/@zhafron/opencode-kiro-auth)
> （对应 GitHub `tickernelz/opencode-kiro-auth`）的基础上，**改造为支持 opencode v2 的插件接口**。
> 上游版本（截至 2.0.0 发布提交 `08f06b4`）仍然是 opencode **v1** 插件：依赖 `@opencode-ai/plugin`，
> 入口返回 `config` / `auth` / `provider` / `tool` 四个 v1 钩子。按照
> [官方 v1→v2 迁移指南](https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1/)，v1 插件
> **无法在 opencode v2 下运行**，必须移植代码。本仓库完成了这项移植。

## 相对上游的主要改动（v2 适配）

- **插件入口改为 v2 形态**：依赖从 `@opencode-ai/plugin` 换成 `@opencode/plugin`（2.0.30），
  入口改用 `Plugin.define` + `setup(ctx)`，默认导出直接是插件对象。
- **四个 v1 钩子迁移到 v2 的 transform / hook**：
  - `config`（注入 Kiro provider 与模型列表）→ `ctx.provider.transform`
  - `auth`（Kiro 登录 / 多账号 / IDC）→ `ctx.integration.transform`，OAuth 由 v1 的交互式
    `prompts` 改为 v2 的声明式表单 + device-code 流程
  - `provider.models` → `ctx.model.transform`
  - `tool`（Web 搜索）→ `ctx.tool.transform`
  - 推理请求通过 `ctx.aisdk.hook("sdk")` 为每个模型提供独立的 SDK 客户端，自定义请求路径得以保留
- **代理支持（新增）**：新增 `proxy_url` 配置项，可把 Kiro 的全部流量（推理、token 刷新、
  用量查询、Web 搜索）强制走指定 HTTP(S) 代理。详见下方「代理配置」。
- **新增模型**：补充 Claude Opus 5.5（含 `-thinking` 版本，支持到 `xhigh` 档）。

## 功能特性

- **多种登录方式**：支持 AWS Builder ID（IDC）、IAM Identity Center（自定义 Start URL）、
  以及 Kiro Desktop（基于 CLI）的登录。
- **自动同步 Kiro CLI**：自动从本地 `kiro-cli` 的 SQLite 数据库导入并同步活跃会话。
- **上下文渐进截断**：在重试过程中动态缩减上下文大小，智能规避 400 错误。
- **智能账号轮换**：按可用额度优先选择账号，支持多账号。
- **高性能存储**：使用原生 SQLite 管理账号与用量。
- **原生思考模式**：把 Kiro 的原生 reasoning 流式输出到 OpenCode 的思考块，thinking 模型
  已声明好 reasoning 标志，无需任何额外配置即可渲染。
- **Kiro Effort 映射**：自动把 OpenCode 的思考预算映射到 Kiro 原生的 effort 档位，覆盖
  `low`–`max` 全梯度。
- **自动恢复**：限流指数退避 + token 自动刷新。

## 安装

> opencode v2 的插件键名是 `plugins`（v1 为 `plugin`）。全局配置文件为
> `~/.config/opencode/opencode.jsonc`（遵循 `XDG_CONFIG_HOME`）。
> 注意 opencode **不读** v1 的 `~/.opencode/opencode.json`——如果你从 v1 升级上来，
> 旧配置里的插件不会生效，需要按下面重新注册。

### 方式一：一键脚本（推荐，从源码装）

本包尚未发布到 npm，先从 GitHub 拉下来跑安装脚本即可。脚本会装依赖、构建、并把插件按
本地路径注册进 opencode v2 全局配置（幂等，已有配置会合并而非覆盖）：

```bash
git clone https://github.com/caopu16/opencode2-kiro-auth.git
cd opencode2-kiro-auth
./scripts/install.sh
```

需要一步到位配好代理（见「代理配置」）时，可带上环境变量：

```bash
KIRO_PROXY_URL="http://127.0.0.1:7890" ./scripts/install.sh
```

脚本做的事：

1. 检查 Node.js（建议 >= 20）和 opencode 是否就绪；
2. `npm ci`（有 lock 文件）或 `npm install`，然后 `npm run build`；
3. 把本仓库绝对路径写进 `~/.config/opencode/opencode.jsonc` 的 `plugins` 数组
   （已存在则合并，不重复、不覆盖已有插件）；
4. 若设置了 `KIRO_PROXY_URL` 且 `kiro.json` 不存在，则写入代理配置。

### 方式二：手动注册

构建后在 `~/.config/opencode/opencode.jsonc` 里把本仓库路径加进 `plugins`：

```jsonc
{
  "plugins": ["/绝对路径/opencode2-kiro-auth"]
}
```

> 待本包发布到 npm 后，也可直接写包名：`"plugins": ["@caopu16/opencode2-kiro-auth"]`。

装好后，插件会注册 `kiro` provider，并自动列出 Kiro 暴露的全部模型，其中每个支持 reasoning
的模型都会额外带一个 `-thinking` 版本。重启 opencode 后运行 `/models` 选择即可。

如果你自己在配置里定义了 `provider.kiro.models`，会**整体替换**插件内置的模型表。只有在需要
重命名或限制模型时才这么做，并且注意下面关于 reasoning 标志的说明。

## 代理配置

Kiro 的推理端点会校验请求的**出口 IP** 和 **User-Agent**。而 AWS SDK 和 Node 的 `fetch`
默认都会**忽略系统代理、直连真实 IP**，这会导致：

- `400 ValidationException`（表现为 "Invalid model" / 让你换模型），因为出口 IP 不被接受；
- `403 AccessDeniedException`（"subscription does not support this application"），因为 SDK
  内置中间件把 User-Agent 覆盖成了 `aws-sdk-js/...`。

本插件的解决办法：

- 把 SDK 流量通过 `NodeHttpHandler` + `HttpsProxyAgent` 强制塞进你指定的代理；
- 移除 SDK 内置的 UA 中间件，显式设回 Kiro IDE 的 User-Agent；
- `token` 刷新、用量查询、Web 搜索统一走同一个代理（`kiroFetch`）。

在 `~/.config/opencode/kiro.json` 里设置：

```json
{
  "proxy_url": "http://127.0.0.1:7890"
}
```

取值规则：

- 填一个代理 URL（如 `http://127.0.0.1:7890` 或某个专用出口 `http://1.2.3.4:1082`）：所有
  Kiro 流量强制走它，和你本机当前的代理模式无关。
- 留空 / 不设置：按环境变量 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 处理，都没有则直连。
- 设为 `"direct"`：完全关闭代理（强制直连）。

> 提示：如果你用 mihomo 这类带分流规则的本地代理，可以把 `proxy_url` 指向它的混合端口，让分流
> 规则把 `amazonaws.com` 导到正确的出口节点；也可以直接把 `proxy_url` 指向那个出口，钉死走它。

## 思考 Effort 配置

每个支持 effort 的 Claude 模型都带一个 `-thinking` 版本，已经携带好 reasoning 标志，并把
effort 梯度做成 variant。无需配置：选一个 `-thinking` 模型，切换它的 variant 就能改变思考深度。

每个 `-thinking` 条目都声明了 OpenCode 渲染 reasoning 所需的两个字段：

```json
{
  "reasoning": true,
  "interleaved": { "field": "reasoning_content" }
}
```

两个都必须有。`reasoning` 声明能力，`interleaved.field` 告诉 OpenCode reasoning 是通过本插件
发出的非标准 `reasoning_content` 增量到达的。缺任意一个，OpenCode 会静默丢弃全部 reasoning，
思考块不会出现。

如果你在自己的配置里覆盖了 `provider.kiro.models`，就整体替换了插件的模型表——记得把这两个
字段复制到你定义的每个 `-thinking` 模型上，否则 reasoning 不再渲染。

reasoning 本身来自 API：Kiro 在 thinking 模型上流式发送 `reasoningContentEvent`，插件把每个
转发成 `reasoning_content` 增量，无需额外开启。对于那种把 reasoning 以 `<thinking>` 标签内联在
回答里的模型，也有兜底解析处理。

variant 设置的是 `thinkingConfig.thinkingBudget`，插件把它映射到 Kiro 原生的 `effort` 字段。
档位按 Kiro 真实思考上限缩放（opus-4.8 / opus-5 为 1024–128000），因此仅凭预算即可触达每个
档位（含 `xhigh`）：

| OpenCode 预算 | Kiro effort |
| ------------- | ----------- |
| `<= 16384` | `low` |
| `<= 32768` | `medium` |
| `<= 65536` | `high` |
| `<= 98304` | `xhigh` |
| `> 98304` | `max` |

`xhigh` 仅在 opus-4.7、opus-4.8、opus-5、opus-5.5、sonnet-5 上可用。这些模型得到五档梯度，
其余为四档，落在 `xhigh` 区间的预算会被钳到 `max`。

Kiro 的 GPT-5.6 系列未纳入：它们通过 `reasoning.effort` / `reasoning.mode` 配置 reasoning，
而非 `output_config.effort`，需要单独的请求路径。

`~/.config/opencode/kiro.json` 用于全局行为，例如登录同步、账号选择、重试上限、
`auto_effort_mapping`。顶层的 `effort` 设置是对所有支持模型的全局覆盖，而非逐模型设置。

## 登录设置

1. **通过 Kiro CLI 登录（推荐）**：
   - 直接在终端执行 `kiro-cli login`。
   - 插件检测到 Kiro CLI 数据库后，会在 OpenCode 的 `auth.json` 里自动写入一个最小的 `kiro`
     占位项，然后在启动时导入并同步你的活跃会话。
   - 对 AWS IAM Identity Center（SSO/IDC），插件会从 `kiro-cli` 数据库同时导入 token 和设备
     注册信息（OIDC 客户端凭据）。
2. **直接登录**：
   - 执行 `opencode auth login`。
   - 选择 `Other`，输入 `kiro`，回车。
   - 会提示你输入 **IAM Identity Center Start URL** 和 **region**（`sso_region`）。
     - 留空则使用 **AWS Builder ID** 登录。
     - 填公司的 Start URL（如 `https://your-company.awsapps.com/start`）则使用 **IAM Identity
       Center（SSO）**。
   - 注意：当前 TUI 的 `/connect` 流程**不会**执行插件的 OAuth 表单（Start URL / region），
     所以 Identity Center 登录可能回落到 Builder ID，除非你用 `opencode auth login`（或在
     `~/.config/opencode/kiro.json` 预先配好默认值）。
   - 对 **IAM Identity Center**，可能还需要 **profile ARN**（`profileArn`）：
     - 如果装了 `kiro-cli` 且选过一次 profile（`kiro-cli profile`），插件会自动识别。
     - 否则在 `~/.config/opencode/kiro.json` 里设置 `idc_profile_arn`。
   - 浏览器会直接打开 AWS 的验证页面（没有本地认证服务器）。如果没自动打开，复制粘贴 URL 并
     输入 OpenCode 打印的 code。
   - 也可以在 `~/.config/opencode/kiro.json` 通过 `idc_start_url` 和 `idc_region` 预配默认值。
3. 配置会自动落在 `~/.config/opencode/kiro.db`。

## 本地开发

测试本地改动最简单的方式是在 `opencode.jsonc` 里直接指向本仓库路径：

```jsonc
{
  "plugins": ["/path/to/opencode2-kiro-auth"]
}
```

然后构建并重启 OpenCode 以加载改动：

```bash
npm run build
```

运行测试：

```bash
bun test
```

## 常见问题

### 所有模型都报 "Invalid model" / 让你换模型

这通常**不是模型 ID 的问题**，而是出口 IP 没被 Kiro 接受——SDK 直连了真实 IP。设置
`proxy_url` 把流量导到被接受的出口即可。详见上面「代理配置」。

### 错误：Status 403（AccessDeniedException / User is not authorized）

如果你用的是 **IAM Identity Center**（自定义 Start URL），Q Developer / CodeWhisperer API
通常需要 **profile ARN**。

本插件会从本地 `kiro-cli` 数据库读取当前 profile ARN（`state.key = api.codewhisperer.profile`）
并作为 `profileArn` 发送。

修复：

1. 执行 `kiro-cli profile` 并选择一个 profile（如 `QDevProfile-us-east-1`）。
2. 重试 `opencode auth login`（或重启 OpenCode 让它重新同步）。

> 另一种 403（"subscription does not support this application"）通常是 User-Agent 被 SDK
> 覆盖导致的，本插件已通过代理层修复，一般无需你处理。

### 错误：No accounts

出现在插件在 `~/.config/opencode/kiro.db` 里没有任何记录时。

1. 确认 `kiro-cli login` 成功。
2. 确认 `~/.config/opencode/kiro.json` 里 `auto_sync_kiro_cli` 为 `true`。
3. 重试请求；插件检测到零账号时会尝试同步 Kiro CLI。

### `/connect` 与 `opencode auth login` 的区别

如果你需要为 OAuth 登录输入 provider 专属值（如 IAM Identity Center Start URL / region），
请用 `opencode auth login`。当前 TUI 的 `/connect` 流程可能不显示插件的 OAuth 表单，无法收集
这些输入。

IDC/SSO（OIDC）提示：若同步时暂时取不到真实邮箱（如离线），插件可能先用占位邮箱创建账号，
等用量 / 邮箱查询成功后再替换为真实邮箱。

### 用 Google/GitHub OAuth 登录 Kiro CLI 的用户：插件同步没启动

如果你是用 `kiro-cli login` 的 Google 或 GitHub OAuth（而非 AWS Builder ID 或 IAM Identity
Center）登录的，OpenCode 仍需要一个已存储的 `kiro` auth 条目，才会调用插件加载器。

插件现在会在检测到本地 Kiro CLI 数据库时自动创建这个最小占位项。`kiro-cli login` 之后重启
OpenCode，加载器就会运行并把你的真实 token 同步进 `kiro.db`。占位值不会用于 API 调用。

如果因为 `auth.json` 格式损坏而跳过了初始化，请先修好 JSON。插件不会覆盖损坏的 auth 文件，
因为里面可能含有其他 provider 的凭据。

**重要**：确认 `~/.config/opencode/kiro.json` 里 `auto_sync_kiro_cli` 为 `true` 且
`kiro-cli login` 成功。

## 配置项

编辑 `~/.config/opencode/kiro.json`：

```json
{
  "auto_sync_kiro_cli": true,
  "account_selection_strategy": "lowest-usage",
  "default_region": "us-east-1",
  "idc_start_url": "https://your-company.awsapps.com/start",
  "idc_region": "us-east-1",
  "proxy_url": "http://127.0.0.1:7890",
  "rate_limit_retry_delay_ms": 5000,
  "rate_limit_max_retries": 3,
  "max_request_iterations": 20,
  "request_timeout_ms": 120000,
  "token_expiry_buffer_ms": 120000,
  "usage_sync_max_retries": 3,
  "usage_tracking_enabled": true,
  "auto_effort_mapping": true,
  "enable_log_api_request": false
}
```

- `auto_sync_kiro_cli`：自动从 Kiro CLI 同步会话（默认 `true`）。
- `account_selection_strategy`：账号轮换策略（`sticky`、`round-robin`、`lowest-usage`）。
- `default_region`：AWS region（`us-east-1`、`us-west-2`）。
- `idc_start_url`：默认 IAM Identity Center Start URL。留空则默认 AWS Builder ID。
- `idc_region`：IAM Identity Center（SSO OIDC）region（`sso_region`），默认 `us-east-1`。
- `proxy_url`：把全部 Kiro 流量导向指定 HTTP(S) 代理。留空按环境变量处理，`"direct"` 强制直连。
- `rate_limit_retry_delay_ms`：限流重试间隔（1000–60000ms）。
- `rate_limit_max_retries`：限流最大重试次数（0–10）。
- `max_request_iterations`：防止卡死的最大循环次数（10–1000）。
- `request_timeout_ms`：请求超时（60000–600000ms）。
- `token_expiry_buffer_ms`：token 刷新缓冲时间（30000–300000ms）。
- `usage_sync_max_retries`：用量同步重试次数（0–5）。
- `auth_server_port_start` / `auth_server_port_range`：遗留项，已忽略（无本地认证服务器）。
- `usage_tracking_enabled`：开启用量跟踪与 toast 通知。
- `auto_effort_mapping`：自动把 OpenCode 思考预算映射到 Kiro effort 档位（默认 `true`）。
- `enable_log_api_request`：开启详细的 API 请求日志。日志里包含解析后的
  `additionalModelRequestFields`，可据此确认实际发出的 effort 档位。

## 存储位置

**Linux/macOS：**

- SQLite 数据库：`~/.config/opencode/kiro.db`
- 插件配置：`~/.config/opencode/kiro.json`

**Windows：**

- SQLite 数据库：`%APPDATA%\opencode\kiro.db`
- 插件配置：`%APPDATA%\opencode\kiro.json`

## 致谢

- 上游项目 [`@zhafron/opencode-kiro-auth`](https://github.com/tickernelz/opencode-kiro-auth)
  （tickernelz），本仓库在其基础上适配 opencode v2。
- 感谢 [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) 提供了基础的 Kiro
  认证逻辑与请求模式。

## 免责声明

本插件仅供学习与教育用途。它是独立实现，与 Amazon Web Services (AWS) 或 Anthropic 无任何
从属、背书或支持关系。使用风险自负。

欢迎提 PR 继续优化。
