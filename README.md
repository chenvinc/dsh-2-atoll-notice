# dsh-2-atoll-notice

把 DeepSeek Harness 的任务状态推送到 macOS 的 [Atoll](https://github.com/Ebullioscopic/Atoll) 灵动岛：**红灯 = 任务失败**，**黄灯 = 有任务在等你**，**绿灯 = 任务完成**。

三种状态共用同一条灵动岛状态行（灵动岛同时只显示一个第三方活动），按优先级抢占：

```
失败 (红)  >  等待你 (黄)  >  已完成 (绿)
```

同一状态有多条时显示计数，例如 `失败 2 · 等待你 1`。所有信息都来自 Host 的实时会话事件，Atoll 只是一个显示面，不参与任何决策。

## 状态怎么来的

| Host 事件 | 灯色 | 何时消失 |
| --- | --- | --- |
| `agent/error` | 红 · 任务失败 | 15 分钟后自动过期 |
| `approval/request`（工具调用待批准） | 黄 · 等你确认 | 批准/拒绝、请求结束或会话结束 |
| `user-questions/request`（Agent 在提问） | 黄 · 等你回答 | 你回答或请求结束 |
| `agent/turn-stopping`（正常结束、未被中止、且本轮没报错） | 绿 · 已完成 | 2 分钟后自动过期 |

主动中止（`Ctrl+C` / 打断）不算失败也不算完成，不会亮灯。

## 环境要求

- macOS（插件的 Host 和浏览器两半都能在别的系统上加载，但只有 macOS + Atoll 才会真的出现灵动岛）
- [Atoll](https://github.com/Ebullioscopic/Atoll) 正在运行。它在本机 `127.0.0.1:9020` 上监听一个 WebSocket JSON-RPC 服务；插件「第三方扩展」开关默认开启（`defaults read com.Ebullioscopic.Atoll enableThirdPartyExtensions`）。
- 首次连接时 Atoll 会询问是否授权，选择允许即可；插件本身不做任何写操作。

不满足条件时插件静默降级：不弹窗、不报错、不影响任何会话。

## 安装

### 方式一：作为本地插件挂载（开发/尝鲜）

在 profile 目录（例如 `~/.dsh/profiles/web`）里做两件事：

1. `package.json` 的 `dependencies` 增加 `"dsh-2-atoll-notice": "file:/绝对路径/dsh-2-atoll-notice"`，然后 `pnpm install`；
2. `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: atoll-notice
      name: dsh-2-atoll-notice
```

重启 Harness（或让该 profile 重新加载）后生效。

### 方式二：发布到 npm 后通过 GUI 插件管理安装

`pnpm publish` 之后，在 Harness 的插件管理里安装 `dsh-2-atoll-notice` 即可；`package.json` 的 `dsh.bundle.patch` 会把它挂进 bundle patch，`dsh.client` 会把浏览器端挂进 Web GUI。

## 设置

打开 **设置 → 插件**，底部会出现「Atoll 灵动岛通知」卡片，含四个开关：

- 显示失败任务（默认开）
- 显示等待你处理的任务（默认开）
- 显示已完成任务（默认开）
- 播放提示音（默认关，使用系统提示音，最短间隔 1.5 秒）

改动会即时生效并持久化到 `~/.dsh/profiles/<profile>/atoll-notice.json`（只保存你改过的字段）。Host 侧 API 是插件自己的两条路由：`GET/POST api/atoll-notice/settings`。

> 说明：宿主当前没有「按插件自动渲染配置表单」的能力（`configForms` 不对外），所以这张设置卡片是插件自带的前端，走自己的 HTTP 路由。没有可用的 Web 服务时，卡片会显示为不可用，Host 侧继续按 `cordis.patch.yml` / profile 里的配置工作。

## Agent 工具

装好后任何会话都能调用：

- `atoll_notice_status`：读取当前连接、授权状态和三条状态的数量
- `atoll_notice_test`：在灵动岛上闪一条示例（`red` / `yellow` / `green`），用来确认链路
- `atoll_notice_clear`：清空本地记录并撤下灵动岛

## 隐私

- 只与本机 `127.0.0.1` 通信，不出网。
- 只发状态行文本（标题、三种状态的计数）和图标/颜色，不发对话内容、不发错误详情、不发文件内容。
- 不读、不写 Atoll 的配置，不做任何 AppleScript/辅助功能调用。

## 可靠性

- Atoll 没开、未授权、端口变了：连接失败后按 500ms → 1s → 2s … 最多 15s 退避重连，期间一切照旧。
- 灵动岛容量满（Atoll 默认最多 4 个第三方活动）：沿用固定活动 id，重试后覆盖同一条，不堆垃圾。
- 任何畸形事件、坏配置、坏 payload 都只是记一条 warn 日志，不会抛出到会话里。

## 开发

```bash
node --test tests/*.test.mjs   # 单元测试
node scripts/smoke.mjs         # 对着真实的 Atoll 亮红/黄/绿灯（会自己撤下）
node scripts/fake-atoll.mjs    # 起一个本地假 Atoll，供集成测试使用
```

目录：`index.js`（挂载与事件绑定）、`lib/atoll.js`（WebSocket JSON-RPC 客户端）、`lib/state.js`（三态账本）、`lib/format.js`（线上格式）、`lib/http.js`（设置 API）、`lib/tools.js`（Agent 工具）、`client.js`（设置卡片）、`docs/`（架构与验证记录）。

## 致谢与许可

Atoll 由 [Ebullioscopic](https://github.com/Ebullioscopic) 开发；本插件只在它的第三方扩展协议之上做适配，与 Atoll 项目没有隶属关系。MIT 许可，见 [LICENSE](./LICENSE)。
