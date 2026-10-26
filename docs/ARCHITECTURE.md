# 架构

## 一句话

Host 订阅 DeepSeek Harness 的会话事件，维护一个三态账本，把「失败 / 等待你 / 完成」合成**一条** Atoll 灵动岛活动推送出去；浏览器端只负责渲染设置卡片，通过插件自己的 HTTP 路由读写设置。

```
session events ──► lib/state.js (账本) ──► lib/format.js (线上格式) ──► lib/atoll.js ──► ws://127.0.0.1:9020
                          ▲                                                              │
                          │                                                    Atoll RPC (JSON-RPC 2.0)
浏览器卡片 ◄── lib/http.js /api/atoll-notice/* ◄── lib/settings-store.js ◄── 用户开关
```

## 为什么是一条活动而不是三条

Atoll 的第三方扩展同时只渲染**一个**独立活动（`ExtensionLiveActivityViews` 取排序后的第一个），其余排队在同一条状态行里。因此这里不做「三条并列」，而是把三种状态聚合成一个活动：

- 颜色与图标按最高优先级状态决定：`failure > attention > done`
- 副标题给出计数，例如 `失败 2 · 等待你 1`，一眼能看出还有几件事
- 活动 id 固定为 `dsh-status`，状态变化用 `updateLiveActivity` 而不是反复 present/dismiss，避免闪烁和容量占用

这也是描述符里 `id` 稳定的原因：Atoll 用 `(bundleIdentifier, id)` 去重，重复 present 会覆盖同一条。

## 模块

| 文件 | 职责 | 关键决策 |
| --- | --- | --- |
| `index.js` | 挂载、事件绑定、生命周期 | 所有来源都用 `try/catch` 包住；任何异常只记 warn |
| `lib/state.js` | 三态账本 | 纯函数式、可注入 clock；按键去重；TTL 过期；`onChange` 只在真变化时触发 |
| `lib/format.js` | 账本 → Atoll 描述符 | 唯一知道线上字段名的地方，便于对着 Atoll 源码核对 |
| `lib/atoll.js` | WebSocket + JSON-RPC 客户端 | 握手时用 `bundleIdentifier` 绑定连接；指数退避重连；请求超时；容量满时重试覆盖 |
| `lib/config.js` | 配置解析 | 每个字段都有类型/范围/正则兜底，永不抛错 |
| `lib/settings-store.js` | 用户层持久化 | 只保存白名单字段；原子写（临时文件 + rename）；坏文件静默忽略 |
| `lib/http.js` | 设置/状态路由 | 同源相对路径；64KB 体积上限；四种错误码（400/405/413/415） |
| `lib/tools.js` | Agent 工具 | 工具注册是可选的：没有 tools 服务就跳过 |
| `client.js` | 设置卡片 | 走自己的 HTTP 路由（宿主没有按插件渲染表单的能力） |

## 事件映射

| 事件 | 动作 |
| --- | --- |
| `agent/error` | 记一条 `failure`，15 分钟 TTL；同一轮重复报错按 id 去重 |
| `approval/request`（waterfall） | 记一条 `attention`；`next()` 结束后精确移除该条 |
| `user-questions/request`（waterfall） | 同上，按 `wait.callId` 去重 |
| `agent/turn-stopping` | 先清掉该 agent 的 `attention`（本轮结束了）；`signal.aborted` 直接返回；本轮已有 `failure` 则不再点绿灯；否则记一条 `done`，2 分钟 TTL |

`pending()` 包装器保证黄灯的生命周期**恰好**等于等待期：先把灯点亮再 `await next()`，`finally` 里移除。请求被取消、抛错、进程被杀，黄灯都会消失。

## 线上格式（对着 Atoll 源码核对）

`atoll.presentLiveActivity` / `atoll.updateLiveActivity` 的 `params` 是 `{ descriptor }`，描述符字段：

```js
{
  id: 'dsh-status',
  bundleIdentifier: 'dev.dsh.atoll-notice',
  priority: 1,                       // AtollLiveActivityPriority
  title: 'DSH 任务',
  subtitle: '失败 1 · 等待你 2',
  leadingIcon: { type: 'symbol', name: '...' },   // 结构化枚举
  leadingContent: { type: 'icon', descriptor: {...} },
  trailingContent: { type: 'text', text: '...' },
  accentColor: { red, green, blue, alpha },        // 结构体，不是 hex 字符串
  allowsMusicCoexistence: true,
  estimatedDuration: 900,
  metadata: { ... },                 // ≤32 个键
}
```

两个容易踩的坑（都在实现中踩过）：

1. **枚举不是字符串**。Atoll 客户端做 JSON 转换时只处理它认识的枚举键（`leadingIcon`、`trailingContent`、`progressIndicator`、`badgeIcon`、`leadingContent`、`icon`、`tint`），值是 `{"type":"caseName", ...}` 形式，Swift 侧再解成关联值。写成 `leadingIcon: "circle.fill"` 会被服务端拒绝（`-32002 invalid-activity`），日志里只有一行校验失败。
2. **颜色是结构体**。`accentColor` 需要 `{red,green,blue,alpha}` 四个 0..1 的 Double，`#FF453A` 这类字符串直接解码失败。

## 失败与降级

| 情况 | 行为 |
| --- | --- |
| Atoll 没运行 | 连接被拒 → 记账本照常 → 退避重连（500ms 起，封顶 15s） |
| 未授权 | `requestAuthorization` 后仍 `authorized=false` → 不发送，等下次重连 |
| 端口被改 | 设置里改 `port` → 客户端重建连接 |
| 容量满（默认 4） | 用同 id 重试，服务端按 id 覆盖；仍失败则下次变化再试 |
| 设置文件损坏 | 读失败当作没有，用 patch 默认值 |
| 浏览器端不可用 | 卡片显示「不可用」，Host 侧继续工作 |

## 隐私边界

- 只连接 `127.0.0.1`，没有任何外部网络请求。
- 只发送标题、计数和截断到 60 字的错误摘要；不发送对话正文、工具参数、文件内容。
- 不读写 Atoll 的 plist，不调用 AppleScript / 辅助功能 / 截图。

## 已知限制

- **只在 macOS + Atoll 上有可见效果**；其他平台插件可以正常加载，只是没有显示面。
- Atoll 同时只显示一个第三方活动，所以本插件在和其他 Atoll 扩展（例如音乐）同时活跃时，会按 `allowsMusicCoexistence` 与优先级让位。
