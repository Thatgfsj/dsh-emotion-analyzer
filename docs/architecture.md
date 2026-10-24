# 架构

```
主模型回复完成
  │  agent/turn-stopping { agent, turn, signal }   （DSH 0.2.1-rc.2 实际事件名）
  ▼
EmotionScorer.score(text)            src/inference.ts
  │  onnxruntime-node + assets/model-int8.onnx（XLM-R INT8）
  │  11 个原始标签逐元素 sigmoid
  ▼
updateProjection(current, raw)       src/mapping.ts（纯函数）
  │  阈值过滤 + 衰减 + 步长 + 封顶
  ▼
appendPluginRecord(session, 'plugin:emotion-analyzer/turn', data)
  │  ignorable 会话事件 → 持久化 / 重启恢复 / fork 携带
  ▼
ctx.sessionProjections.register({ key: 'emotion', ... })   src/projection.ts
  │  纯同步 fold；wire view 推送给 Web 客户端
  ▼
客户端隐形桥 useProjection('emotion') → 模块级 store
  ▼
shell.overlay 浮层 → React portal → <emotion-monitor>（Shadow DOM）
```

## 模块边界

| 文件 | 职责 | 行数预算 |
|---|---|---|
| `src/mapping.ts` | 硬编码映射层，零依赖纯函数 | < 250 |
| `src/inference.ts` | ONNX 会话、分词、sigmoid、计时/降级 | < 400 |
| `src/projection.ts` | projection 单元定义与 schema | < 250 |
| `src/index.ts` | 插件入口、turn-stopping 钩子 | < 250 |
| `src/widget/*` | Shadow DOM 悬浮框、sparkline、样式 | 每文件 < 600 |
| `src/client/index.ts` | shell.overlay + 隐形桥 + portal | < 300 |

## 数据与隐私

- 只把**助手回复文本**送进本地 ONNX，不联网、不发往任何模型 API。
- 会话日志里新增的是 `plugin:` 命名空间、`ignorable` 的插件记录（原始分数 + 统一维度分数 + 元信息），不含用户输入原文。
- 悬浮框历史最多保留 30 轮（内存 + localStorage）。
