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

## 说明

- projection 的 `apply` **必须同步且纯**，因此推理结果不能直接在 fold 里跑模型：改为先把每轮分数写入 `plugin:` 记录，再让 projection 纯 fold 该记录。这样自然满足"重启恢复"。
- 不使用 `Session.append()` 自定义新事件类型（`Session.append` 写不出 `ignorable: true`，会让会话打不开）。
- 客户端不 `require` 任何 `@deepseek-ai/dsh-client-*` 运行时；只使用 `react`/`react-dom` 平台种子与 `ctx.slots` 服务。
