# dsh-browser-control

让 DSH 的 Agent 能**查看并修改右侧边栏浏览器里打开的页面**。

DSH 自带的“浏览器”标签页（右侧边栏 → 浏览器，Windows 下 `Ctrl+T`）是用户自己的浏览窗口。这个插件把它接给 Agent：Agent 可以列出当前打开的标签页、读取页面文字与可交互元素、点击、输入、跳转、截图，也可以用 `browser_eval` 在页面里直接跑一段 JavaScript 来读数据或改内容。

> 它操作的是 **DSH 内置侧边栏浏览器里的页面**，不是系统的 Chrome/Edge，也不是 `web_fetch` 那种服务端抓取。

## 安装

插件是一个 workspace 目录下的 bundle 包，需要装进当前 profile（`desktop`）：

```powershell
node install.mjs --dry-run   # 先看会改什么
node install.mjs             # 真正安装
```

`install.mjs` 只做三件事，并且可重复执行：

1. 把包复制到 `<profile>/node_modules/dsh-browser-control`；
2. 在 `<profile>/package.json` 的 `dependencies` 里登记它（这样以后跑 pnpm 不会把它清掉）；
3. 在 `<profile>/cordis.yml` 末尾追加一行 loader 入口（会先备份成 `cordis.yml.bak`）。

卸载：`node install.mjs --uninstall`。

安装后**刷新一次 DSH 页面**，浏览器侧的工作线程才会开始轮询；然后打开侧边栏浏览器并访问任意 HTTP(S) 页面。

## Agent 拿到的能力

### `browser_frame`

| `action` | 作用 |
| --- | --- |
| `list` | 列出侧边栏里所有标签页的 id、标题、URL、是否活动/加载中。**建议先调它拿 id 或序号。** |
| `read` | 返回目标标签页的 URL、标题、可见文字，以及可交互元素（按钮/输入框/链接等）及其**可直接使用的 CSS 选择器**。 |
| `click` | 按 `selector` 或按可见 `text` 点击一个元素（会滚动到可视区并派发完整的 pointer/mouse 事件序列）。 |
| `type` | 给输入框 / textarea / contenteditable 赋值（走原生 setter 并派发 `input`、`change`）；`submit: true` 时再按一次 Enter。 |
| `navigate` | 在该标签页里加载一个 HTTP(S) 地址。 |
| `screenshot` | 截取页面可视区域，把 PNG 落盘并返回文件路径；单张过大会自动降采样（见下）。 |

常用参数：`tab`（id、标题或 URL 片段，默认活动标签页）、`selector`、`text`、`url`、`submit`、`limit`、`includeElements`、`timeoutMs`。

### `browser_eval`

在页面自己的 JS 上下文里执行一段代码（函数体，可以用 `return` 和 `await`）：

```
return [...document.querySelectorAll('a')].map((a) => a.href)
```

返回值必须是可 JSON 序列化的；DOM 节点不行，需要自己转成数组/字符串。结果过大时会落盘并只回传路径。

### 落盘位置与体积

- 截图与超大的 `eval` 结果由 Host 写到 **`$DSH_PROFILE_DIR/.dsh-browser/`**（`shots/` 与 `eval/` 两个子目录），返回的是绝对路径。实际验证时得到的是 `C:\Users\Lenovo\.dsh\profiles\desktop\.dsh-browser\shots\shot-*.png`。
- 若 Agent 的文件工具被限制在会话工作目录内，读这个路径可能被拒——把文件复制进工作目录再读即可；路径由返回值直接给出，不依赖约定。
- 页面→Host 的单次回传上限为 4 MiB（HTTP body 上限也是 4 MiB）。截图预算 2 MiB，超出时按 0.7 系数逐步降采样（下限 0.25），并在结果里标 `scaledDown`，同时提示细字可能不可读。
- 实测参考：575×704 的 B 站首页整屏 PNG 为 **286 KB**（base64 后约 382 KB）。旧版本 512 KiB 的上限曾让这个尺寸直接失败，这也是该上限被提高的原因。

## 典型流程

```
1. browser_frame { action: "list" }
   → 0. id=tab-0-xxxx [active, loaded] 登录页 — https://example.com/login

2. browser_frame { action: "read" }
   → 页面文字 + 可交互元素：
     - <input> "" (name=user) → input[name="user"]
     - <input> "" (type=password) → input[type="password"]
     - <button> "登录" → button[type="submit"]

3. browser_frame { action: "type", selector: "input[name=\"user\"]", text: "alice" }
   browser_frame { action: "type", selector: "input[type=\"password\"]", text: "…" }
   browser_frame { action: "click", text: "登录" }
```

## 工作原理

```
┌─ Host 进程（DSH 服务端 / Electron 主进程）─────────────┐
│  index.js                                              │
│   • ctx.tools.register(browser_frame / browser_eval)   │
│   • ctx.webServer.register('/dsh-browser-control')     │
│        GET  /next    长轮询，认领一个任务               │
│        POST /result  页面回报结果                       │
│        GET  /status  桥接状态（调试用）                 │
└───────────────────────────┬────────────────────────────┘
                            │ 本机回环 HTTP（127.0.0.1）
┌───────────────────────────┴────────────────────────────┐
│  渲染进程（DSH 页面）                                   │
│  client.js                                             │
│   • 轮询 /next 认领任务                                 │
│   • 在 <webview data-sidebar-browser-frame> 上调用      │
│     executeJavaScript / loadURL / capturePage          │
│   • 把结果 POST 回 /result                              │
└────────────────────────────────────────────────────────┘
```

页面本体活在渲染进程的 Electron `<webview>` 访客里，Host 插件够不到它；而工具又必须由 Host 注册。所以两边用插件自己的回环路由做一次“任务下发 → 结果回报”。几次设计取舍：

- **长轮询而不是定时轮询**：空闲时页面侧只有一个挂起的请求，没有定时器，也没有持续流量；有新任务时立刻唤醒。
- **超时归还任务**：任务被认领后若迟迟没有回报（页面被关掉、渲染进程重启），Host 会把它放回队列，而不是让 Agent 一直等。
- **结果大小上限**：单次页面数据超过阈值就落盘成 `.dsh-browser/` 下的文件并只返回路径，避免把对话撑爆。
- **不为 UI 服务**：插件不画任何界面，因此客户端 bundle 不必引入 `react`。

## 配置

在 profile 的 `cordis.yml` 行里可选覆盖（都有默认值，一般不用改）：

```yaml
- id: dsh-browser-control
  name: dsh-browser-control
  config:
    pollWaitMs: 50000      # 一次长轮询最多挂多久
    taskTimeoutMs: 60000   # 一个任务等页面回报的上限
    clientGraceMs: 30000   # 心跳静默多久后认为页面已断开
```

## 已知限制

- **只能在桌面版用**：页面内容通过 Electron `<webview>` 的 `executeJavaScript` / `capturePage` 访问。Web profile 下侧边栏浏览器用的是 `<iframe>`，跨域时读不到内容，插件会明确报错而不是静默失败。
- **截图不会自动进入对话**：PNG 落盘并返回路径。没有把它作为图片附件回传，因为那需要额外走附件服务的路由与模型能力检查。
- **受页面沙箱与站点策略限制**：目标站点若是 `X-Frame-Options`/CSP 拒绝嵌入，或者侧边栏那个标签关闭了沙箱，行为由侧边栏浏览器自身决定，本插件不绕过。
- **页面是共享的、活的**：Agent 的点击和输入对用户可见。工具描述里已要求“先读后写、未经要求不做提交/登录/删除”等破坏性动作，但这仍是提示而非强制。
- **`tabId` 在页面刷新后重新分配**：每次 `list` 拿到的 id 在同一个页面生命周期内稳定，刷新后会变。

## 自检

三个离线测试都不需要打开浏览器界面：

```powershell
node test/harness.mjs         # Host 半边：路由协议、任务生命周期、两个工具的 schema 与渲染
node test/client-harness.mjs  # Client 半边：注入页面的表达式生成、read/click/type/eval 行为（假 DOM）

# 用 DSH 自己的校验器（而不是本地复刻）确认工具 schema 合法
$env:ELECTRON_RUN_AS_NODE = 1
& "E:\Deepseek Harness\DeepSeek Harness.exe" --expose-internals test/real-schema-check.mjs
```

- `harness.mjs`：用真实的回环 HTTP 服务加一个假页面端点跑完 `list/read/click/type/navigate/screenshot` 与失败路径，并审计两个工具的 schema 只使用 Harness 支持的写法。
- `client-harness.mjs`：用小型假 DOM 验证注入访客页的代码能解析、helper 能经 `toString()` 搬运、参数数组与各 action 语义正确。
- `real-schema-check.mjs`：直接 import 应用内的 `assertSupportedJsonSchema`，把「schema 拼写错误」这类只在注册期才暴露的问题挡在提交前。**这一项必须用应用的 Electron 二进制跑**（普通 Node 读不了 `app.asar`）。

**未覆盖**：真实 `<webview>` 里的 `executeJavaScript` / `capturePage` / `loadURL`，以及侧边栏自身的 DOM 结构。这些只能在运行中的 DSH 桌面版里验证。

## 排查激活失败

profile 插件如果拿不到依赖服务、或工具 schema 非法，只会表现为那一条 Loader 入口不激活：

```
dsh: warning: 1 entry did not activate
```

宿主不写日志文件，页面也照常打开，所以很难发现。本插件内置了开关——在会话工作目录放一个标记文件，下次启动就会记录加载与激活过程：

| 标记文件 | 输出 |
| --- | --- |
| `<工作目录>/.dsh-browser/TRACE` | `<工作目录>/.dsh-browser/boot.log` |
| `<工作目录>/.dsh-browser/TRACE_ABS` | `$env:DSH_BROWSER_CONTROL_TRACE` 指定的绝对路径 |

`boot.log` 会依次记录「模块已加载」→「apply() 进入」→「路由注册 / 拿到 tools 服务」，正好区分三种失败：模块没被解析、激活早于依赖服务、schema 被拒。排查完请删掉标记文件。

