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

## 情绪映射与累积（`src/mapping.ts`）

模型的 11 个原始标签（逐标签 sigmoid，互不排斥）聚合成 7 个统一维度：

| 统一维度 | 聚合 | 原始标签 |
|---|---|---|
| `happy` | max | joy, gratitude |
| `pleasant` | max | joy, love, gratitude |
| `sad` | max | sadness, frustration |
| `angry` | max | anger, disgust, contempt, frustration |
| `anxious` | max | fear, frustration |
| `unwell` | 加权和 | sadness×0.5 + disgust×0.4 |
| `neutral` | max | neutral |

`surprise` 已知但**暂不映射**（方向不确定，等后续 issue）。`max` 让同义标签取最强的一个，避免重复放大；`wsum` 表达混合不适感。

`updateProjection(current, rawScores)` 是纯函数，按顺序执行：

1. **聚合**：11 个原始标签 → 7 个维度（越界 / 非有限值按 0 处理）。
2. **门控**：
   - 本轮没有**被映射的**输入（空对象、只有 `surprise`、全非法值）→ 视为“无输入”，所有维度纯衰减；
   - 有输入但所有维度聚合值都低于 `THRESHOLD` → 判为噪声，整轮跳过，状态不变。
3. **命中**（聚合值 ≥ `THRESHOLD`）：`next = min(CAP, old × DECAY + min(raw, STEP_MAX))`。
4. **未命中**：`next = old × DECAY`。
5. 钳制到 `[0, 1]`，返回新对象，不修改入参。

常量集中在 `src/mapping.ts` 顶部：`THRESHOLD = 0.3`、`DECAY = 0.9`、`STEP_MAX = 0.25`、`CAP = 1.0`。当前常量下 `THRESHOLD > STEP_MAX`，所以命中的单轮加分恒为 `STEP_MAX`；公式里的 `min(raw, STEP_MAX)` 是为将来独立调参保留的。

示例：连续 5 轮高强度 `sad` → `0.25 → 0.475 → 0.678 → 0.860 → 0.998`（单调上升、不超 `CAP`）；随后 10 轮 `neutral`，`sad` 衰减为原来的 `0.9¹⁰ ≈ 0.349`。

## 数据与隐私

- 只把**助手回复文本**送进本地 ONNX，不联网、不发往任何模型 API。
- 会话日志里新增的是 `plugin:` 命名空间、`ignorable` 的插件记录（原始分数 + 统一维度分数 + 元信息），不含用户输入原文。
- 悬浮框历史最多保留 30 轮（内存 + localStorage）。
