# DSH 宿主 API 校准（本机 0.2.1-rc.2）

提示词里的 `turn-stopping`、`ctx.session.projection`、`ev.getLastMessage()` 是示意写法；以下是本机安装包的**真实签名**（证据文件路径以 `\$DSH/node_modules/@deepseek-ai/` 为根）。

| 提示词写法 | 实际 API | 证据 |
|---|---|---|
| `turn-stopping` | `agent/turn-stopping`，payload `{ agent, turn, signal }`，`serial` | `dsh-agent/lib/types/runtime-types.d.ts:387` |
| `ctx.session.projection.emotion` | `ctx.sessionProjections.register({ key, stateSchema, init, apply, wire, stateVersion })` | `dsh-session-projection/lib/types/index.d.ts` |
| `ev.getLastMessage()` | `event.agent.session.deriveMessages()` 取最后一条 assistant 消息 | `dsh-agent/lib/types/runtime-types.d.ts`（runtime `Agent.session`） |
| 新增事件类型 | `appendPluginRecord(session, 'plugin:<name>/<action>', data)`（`ignorable`，插件记录） | `dsh-session/lib/types/index.d.ts:117` |
| 前端 `document.body.appendChild` | 注册 `shell.overlay`（root list slot），React portal 到 `document.body`；现有插件 `dsh-approval-watch` 采用同一模式 | `dsh-client-ui-layout/lib/types/client/index.d.ts:95` |
| 前端事件总线 | session 标准 prop `useProjection('emotion')`（session 作用域），全局 `useSessions` | `dsh-client-ui-session/lib/types/client/index.d.ts` |
| Host HTTP 路由 | `ctx.connection.fetch.register({ path: '/api/<feature>', methods, requestBody: 'buffered', fetch })`；exact pathname 匹配、不支持 `:id` 参数；鉴权由 Connection 栅栏完成（非 owner → 403） | `dsh-client-connection/lib/types/rpc.d.ts`（`HostConnectionFetch` / `ConnectionFetchRoute`） |
| 可选访问 connection 服务 | `ctx.inject(['connection'], cb)` 惰性回调；不要把它放进插件 `inject` 数组，否则 CLI/headless 无 Connection 时整个插件不加载 | `dsh-client-connection/lib/index.js`（`apply` 中 `ctx.inject(['webServer'], ...)`） |
| 设置与模型目录 | 无宿主设置 API；插件自管 `$DSH_HOME/emotion-analyzer/config.json` 与 `models/<id>/` | `docs/models.md`；Node 进程的 `process.env.DSH_HOME` |

## 说明

- projection 的 `apply` **必须同步且纯**，因此推理结果不能直接在 fold 里跑模型：改为先把每轮分数写入 `plugin:` 记录，再让 projection 纯 fold 该记录。这样自然满足"重启恢复"。
- 不使用 `Session.append()` 自定义新事件类型（`Session.append` 写不出 `ignorable: true`，会让会话打不开）。
- 客户端不 `require` 任何 `@deepseek-ai/dsh-client-*` 运行时；只使用 `react`/`react-dom` 平台种子与 `ctx.slots` 服务。
- **原生模块必须惰性加载**：`onnxruntime-node` 的 InferenceSession 会持有工作线程，插件激活时就加载模型会让 CLI `dsh --help` / 一次性 headless 进程无法退出。这里改到第一次 `agent/turn-stopping` 才 `init()`（仍为单例）。
- **DELETE 路由风险**：`ConnectionFetchMethod` 类型只声明 `GET | HEAD | POST`；v0.2 的 `DELETE /model/{id}` 按契约注册（运行时只校验 path/method 唯一性），但尚未在真实 DSH 网页验证 HTTP 桥是否放行 DELETE。若被拒，需要改为 POST 变体（记录在 `docs/models.md` §8）。
