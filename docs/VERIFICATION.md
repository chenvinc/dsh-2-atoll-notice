# 验证记录

本文件记录「凭什么相信这个插件是对的」，以及哪些事在这台机器上**没有**验证。所有命令都可以在仓库根目录复现。

## 1. 单元与集成测试

```bash
node --test tests/*.test.mjs
```

最后一次完整运行：**83 个测试，83 通过，0 失败**（约 0.9 s）。覆盖：

| 测试文件 | 覆盖 |
| --- | --- |
| `tests/state.test.mjs`（30） | 三态账本：去重、TTL、容量淘汰、敌意输入、onChange 触发时机 |
| `tests/format.test.mjs`（19） | 描述符字段、颜色、图标、计数文案、优先级 |
| `tests/atoll.test.mjs`（13） | JSON-RPC 客户端：握手、授权、present/update/dismiss、重连、超时、并发合并 |
| `tests/host.test.mjs`（10） | 配置解析、设置文件、HTTP 路由、声音节流 |
| `tests/integration.test.mjs`（4） | **真 WebSocket + 假 Atoll**：失败 → 红灯、待确认 → 黄灯并自动消失、完成 → 绿灯、中止不亮灯、设置读写落盘 |
| `tests/cordis.test.mjs`（2） | **真 Cordis Context**：`ctx.plugin(plugin, config)` 能挂载，`ctx.emit` 的事件能到达 Atoll |
| `tests/client.test.mjs`（5） | 浏览器半：沙箱加载 `client.js`，校验 slot 注册、字典覆盖、API 路径与 Host 路由一致、无顶层 import/JSX |

其中 `tests/integration.test.mjs` 和 `tests/cordis.test.mjs` 断言的是**线上真实字段**（`atoll.presentLiveActivity`、`descriptor.id === 'dsh-status'`、`accentColor.red > 0.8` 等），不是 mock 的内部结构——字段写错会直接失败。

## 2. 对着真实 Atoll 的冒烟

```bash
node scripts/smoke.mjs
```

输出（同一台机器，Atoll 正在运行）：

```
[smoke] connected: connected=true authorized=true activity=- error=-
[smoke] red: connected=true authorized=true activity=dsh-status error=-
[smoke] yellow: connected=true authorized=true activity=dsh-status error=-
[smoke] green: connected=true authorized=true activity=dsh-status error=-
[smoke] dismissed: connected=true authorized=true activity=- error=-
```

同时 Atoll 的 unified log（`com.ebullioscopic.Atoll:extensions` 分类）给出接受证据：

```
ExtensionLiveActivityViews.swift:180 - Displaying extension live activity dsh-status for dev.dsh.atoll-notice as standalone view
ExtensionRPCService.swift:358 - RPC: Presented live activity dsh-status for dev.dsh.atoll-notice
ExtensionLiveActivityViews.swift:180 - Hid extension live activity dsh-status standalone view
```

这证明：连接握手（`bundleIdentifier` 绑定）、授权、三种颜色的描述符、dismiss 都被真实 Atoll 接受并渲染，而不是被静默丢弃。

开启这些日志的方法（验证时使用，之后可关）：

```bash
defaults write com.Ebullioscopic.Atoll extensionDiagnosticsLoggingEnabled -bool true
defaults write com.Ebullioscopic.Atoll extensionRPCDiagnosticsLoggingEnabled -bool true
log stream --predicate 'process == "Atoll"' --info --debug | grep -i extension
```

## 3. 伪装/离线场景

- `node scripts/fake-atoll.mjs`：零依赖的假 Atoll（真实 WebSocket 握手 + JSON-RPC），供 CI 和没有 Atoll 的机器使用。
- Atoll 未运行、端口错误、未授权三种情况在 `tests/atoll.test.mjs` 里断言为「不抛错、不崩溃、等待重连」。

## 4. 没有验证的部分（诚实清单）

1. **浏览器里的设置卡片没有在真实浏览器中打开过。** 这台机器没有浏览器自动化工具，仓库里也没有 React 运行时可导入。已做的是：在 Node 沙箱里用 stub React 加载真实的 `client.js`，断言模块自注册、`plugins.item` 注册元数据（`id`、`order`、`locale`、`label()`）、两个语言字典覆盖所有 `t("...")` 键、API 路径与 Host 路由一致。**没有做**的是：真实渲染、点击开关、保存后的界面反馈。
   人工验证步骤：安装后在 Harness 的「设置 → 插件」页底部应出现「Atoll 灵动岛通知」卡片；拨动开关 → 点保存 → 状态行显示「已保存」；再刷新页面，开关应保持。
2. **与其它 Atoll 扩展同时活跃的情况只按源码推断**（Atoll 同一时刻只渲染一个第三方独立活动，见 `ExtensionLiveActivityViews` 的排序逻辑），没有用第二个扩展实测。
3. **声音**只验证了「开关会触发 `afplay` 调用且被节流」，没有用耳朵确认具体音色。
4. **长时间稳定性**（数小时重连、睡眠唤醒）没有跑过；重连退避逻辑只做了单元测试。

## 5. 已知风险

- 设置卡片依赖宿主 `plugins.item` slot 的契约。若宿主改版，卡片可能不显示；Host 侧功能不受影响（设置仍可通过 `cordis.patch.yml` / 配置文件控制）。
- 描述符的 `metadata.counts` 是事实上的调试线索：`"1,0,0"` 表示 1 个失败、0 个等待、0 个完成。
