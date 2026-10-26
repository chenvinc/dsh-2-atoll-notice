# dsh-2-atoll-notice

把 **DeepSeek Harness** 的任务状态镜像到 macOS 的 **Atoll 灵动岛**：有任务失败、有任务在等你、有任务做完了——低头看一眼灵动岛就知道。

> 简体中文 | [English](README.en.md)

## ⚠️ 只对 macOS + Atoll 有意义

装了它但没装 Atoll，等于什么都没装。请在动手前确认两件事：

1. **macOS**——Atoll 只有 macOS 版本；
2. 已经安装并运行 **[Atoll](https://github.com/Ebullioscopic/Atoll)**——本插件通过 Atoll 的第三方扩展协议（本机 WebSocket JSON-RPC，默认 `127.0.0.1:9020`）把状态画到灵动岛；没有 Atoll，就没有灵动岛，插件会安静地什么都不做。

Linux / Windows 上的 DeepSeek Harness 不需要、也用不了这个插件。

## 它只做一件事：提醒

刻意做得极简：**不接管任务、不执行命令、不收集数据**，只把 Harness 已经产生的任务状态汇总成一枚状态灯。

| 状态 | 颜色 | 含义 |
| --- | --- | --- |
| 失败 | 🔴 红 | 有任务报错了 |
| 待你处理 | 🟡 黄 | 有任务在向你提问 / 等待你授权 |
| 已完成 | 🟢 绿 | 有任务做完了 |

三种状态**共存**于同一枚灵动岛活动里，右边用 `失败·待处理·完成` 三个数字表示各自的数量（例如 `1·0·0` 表示一个失败、没有待处理、没有完成；`0·0·2` 表示完成了两个）。图标颜色取当前最要紧的那一档：失败 > 待处理 > 完成。

![失败 / 待处理 / 完成三种状态下的灵动岛](docs/images/island-states.png)

- 状态由 Host 的真实事件驱动（`agent/error`、`approval/request`、`user-questions/request`、`agent/turn-stopping`）；
- 主动中止（`Ctrl+C` / 打断）既不算失败也不算完成，不会亮灯；
- 失败状态 15 分钟自动过期、完成状态 2 分钟自动过期，空闲时插件会把活动撤下，不占地方；
- 需要声音时可以在设置里打开提示音——用 macOS 系统提示音，并且做了节流，短时间内最多响一次。

## 安装

### 方式一：本地挂载（开发 / 尝鲜）

```bash
git clone https://github.com/chenvinc/dsh-2-atoll-notice.git
```

在 profile 目录（例如 `~/.dsh/profiles/web`）里：

1. `package.json` 的 `dependencies` 增加 `"dsh-2-atoll-notice": "link:/绝对路径/dsh-2-atoll-notice"`，然后 `pnpm install`；
2. `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: atoll-notice
      name: dsh-2-atoll-notice
```

重启 `dsh web` 后生效。

### 方式二：从 npm 安装（推荐）

```bash
npm install dsh-2-atoll-notice --save
```

或直接在 Harness 的插件管理里搜索安装 `dsh-2-atoll-notice`——`package.json` 里的 `dsh.bundle` 会把 Host 半挂进 bundle patch，`dsh.client` 会把浏览器半挂进 Web GUI。

当前版本：[![npm version](https://img.shields.io/npm/v/dsh-2-atoll-notice.svg)](https://www.npmjs.com/package/dsh-2-atoll-notice)

### 前置检查

- Atoll 正在运行；
- Atoll 的第三方扩展开关是开的（默认开）；
- 端口保持默认 `9020`；改过的话，请在插件设置里同步。

## 设置

打开 **设置 → Atoll 通知**（设置面板左侧导航里的独立一项）：

![设置页：四个开关、连接状态、以及底部的 GitHub Issues 入口](docs/images/settings.png)

- 四个开关：失败任务 / 等待你处理的任务 / 已完成任务 / 提示音；
- 连接状态与端口；
- 页面底部有 GitHub Issues 入口，欢迎提意见。

设置会即时生效，并持久化到 `~/.dsh/profiles/<profile>/atoll-notice.json`（只保存你改过的字段）。

## 给智能体的工具

装好后任何会话都能调用：

- `atoll_notice_status`：读取连接、授权状态和三种状态的数量；
- `atoll_notice_test`：在灵动岛上点亮某个状态（`failure` / `attention` / `done`），用来确认链路；
- `atoll_notice_clear`：清空本地记录并撤下灵动岛。

## 工作原理

```
DeepSeek Harness ──事件──▶ 插件 Host 半 ──WebSocket JSON-RPC──▶ Atoll ──▶ 灵动岛
        ▲                      127.0.0.1:9020
        └──── 设置页 = 插件 Client 半（React，走插件自己的 HTTP 路由）────┘
```

- Host 半监听任务事件，维护三份计数，任何变化都合并成**一枚** Atoll 活动推过去；
- Atoll 重启或断线时自动重连（500ms → 1s → … 最多 15s 退避）并重新呈现当前状态；
- 设置页只读写插件自己的 `/api/atoll-notice/*` 路由，不碰其它数据。

## 排查

- 改了 Host 半（`index.js`、`lib/*.js`）要重启 `dsh web`；只改 `client.js` 会热替换，刷新页面即可；
- 插件会把加载过程写进 `~/.dsh/atoll-notice-trace.log`：`module-loaded`、`apply-enter`、`routes-mounted`、`tools-registered`，以及浏览器回报的 `bundle-loaded` / `card-registered` / `section-registered`；
- 灵动岛没反应时，先确认 Atoll 在运行、端口一致、并且设置页里的开关是打开的。

## 隐私

- 只与本机 `127.0.0.1` 通信，不出网；
- 只发状态行文本（标题、三种状态的计数）和图标/颜色，不发对话内容、错误详情或文件内容；
- 不读写 Atoll 的配置，不做 AppleScript / 辅助功能调用。

## 开发

```bash
node --test tests/*.test.mjs   # 单元测试（92 个）
node scripts/smoke.mjs         # 对着真实 Atoll 亮灯（会自己撤下）
node scripts/fake-atoll.mjs    # 本地假 Atoll，供集成测试使用
```

目录：`index.js`（挂载与事件绑定）、`lib/atoll.js`（WebSocket JSON-RPC 客户端）、`lib/state.js`（三态账本）、`lib/format.js`（线上格式）、`lib/http.js`（设置 API）、`lib/tools.js`（Agent 工具）、`client.js`（设置卡片）、`docs/`（架构与验证记录）。

## 反馈

有想法、遇到问题，都欢迎到 **[GitHub Issues](https://github.com/chenvinc/dsh-2-atoll-notice/issues)** 提意见。设置页里也有同一个入口。

## 致谢与许可

Atoll 由 [Ebullioscopic](https://github.com/Ebullioscopic) 开发；本插件只在它的第三方扩展协议之上做适配，与 Atoll 项目没有隶属关系。MIT 许可，见 [LICENSE](./LICENSE)。
