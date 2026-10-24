# Web 客户端集成

浏览器半边（`src/client/index.ts`）只使用 DSH 公开的 slot 系统，不 `require` 任何 `@deepseek-ai/dsh-client-*` 运行时包。

## 两处注册

| slot | scope | 作用 |
|---|---|---|
| `shell.overlay` | root（list） | 悬浮框；React portal 到 `document.body`，SPA 切换路由后仍在 |
| `conversation.session.header.utilities` | session（list） | 隐形桥：`useProjection('emotion')` → 模块级 store |
| `settings.general.item` | root（list） | Settings → General 的「显示情绪监测悬浮框」开关 |

`apply(ctx)` 里通过 `ctx.effect(() => ctx.slots.inject(name, () => ctx.slots.register(...)))` 注册，全部随插件 fiber 卸载自动清理（`inject` 回调返回合并 disposer）。

## 数据流

```
Host projection wire view
  → session 控制流 projection frame
  → 桥组件 useProjection('emotion')
  → store.publishEmotion(...)         （按内容去重，避免重复渲染）
  → shell.overlay 组件
  → React portal → <emotion-monitor>（Shadow DOM）→ element.update(data)
```

- 桥组件只在会话视图挂载时存在；悬浮框一直存在（root overlay），因此切换会话/打开设置页不会丢失。
- 没有收到任何投影数据时，widget 显示「等待第一条回复…」。

## 关闭 / 重开

- 关闭 [×]：widget `hide()` 并把 `dsh-emotion-analyzer.visible=0` 写入 localStorage，同时广播 `emotion-analyzer-visibility` 事件；右下角保留 36px 的 💗 按钮可立即重开。
- 设置页开关：Settings → General → 「情绪监测悬浮框」复选框；这是规格要求的“通过 DSH 插件设置重新开启”。
- 折叠 [—]：48px emoji 徽章，hover/点击展开；状态由 widget 自己持久化。

## 构建

`src/client/index.ts` 由 `scripts/build.mjs` 用 esbuild 打成单个 CJS bundle，再包成：

```js
window.__ModuleLoader__.load({
  id: 'dsh-emotion-analyzer',
  factory(require) {
    var module = { exports: {} }
    // ...esbuild CJS 输出...
    return module.exports.default(require)
  },
})
```

`react` / `react-dom` 由宿主平台种子表提供；widget 源码（含 Shadow DOM 样式）被打进同一个 `lib/client.js`（minify 后 < 500 行）。

## 已知限制

- 设置开关是纯客户端偏好（localStorage），不写入 profile 配置；换浏览器/设备不同步。
- 多标签页共享 localStorage 的关闭状态，但每个标签页各自渲染一份悬浮框。
- 投影帧只在会话被打开（follow 流建立）后到达客户端；未打开过的历史会话不会主动拉取。
