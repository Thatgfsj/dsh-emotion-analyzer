# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/).

## [0.1.3] - 2026-10-24

### Changed

- **合并 happy → pleasant（#30）**：统一维度收敛为 7 个（pleasant / sad / angry / anxious / unwell / confused / neutral）。joy / love / gratitude 统一映射到「愉快」，悬浮框、projection、类型定义、测试与文档同步；旧缓存由 `stateVersion` 回放日志重建。
- **映射精修（#30）**：`frustration` 只归 angry；`sad` 只看 `sadness`；`anxious` 只看 `fear`，不再因 frustration 同时抬高 sad / anxious。
- **unwell 与 sad 解耦（#32）**：`unwell` 由 `sadness×0.5 + disgust×0.4` 改为 `max(disgust, 0.5×fear)`。40 条验收集上 unwell↔sad 相关系数 **r=0.965 → 0.028**；纯悲伤不再点亮「反感」，「头晕恶心」句 unwell 0.404 → 0.991。
- **disgust 单一归属（#32）**：`angry` 的 terms 去掉 `disgust`，避免“恶心”句同时高亮 angry + unwell 两条重复（disgust=0.994 时旧 angry=0.994 → 新 angry=0.008）。
- **THRESHOLD 0.3 → 0.2（#30）**：模型对“难过”常给 sadness≈0.27，原阈值会丢弃真实悲伤；8 条中性句其余维度最大仅 0.018，未引入误报。
- **投影新增 `turnScores` / `turnDominant`（#30）**：保存“本回合原始聚合”分数与主导情绪（不经 `STEP_MAX` 累积），悬浮框“本回合”分数条/emoji 使用该字段；session projection `stateVersion` 2 → 3，旧缓存回放日志重建。
- **悬浮框默认 compact（#31）**：默认 48px emoji 徽章，点击展开、点 `—` 收起；移除 hover 自动预览，关闭后仍可从设置页/右上角 💗 重开。
- **模型校验同步**：`scripts/validate.py` 的 `unified_scores` / report mapping 与 `src/mapping.ts` 对齐（含 disgust 只归 unwell），40 条用例期望由 happy 改为 pleasant。
- **文档**：architecture / model-export / widget / e2e 的映射表、阈值、示例与实测数据；README 参数表同步。

### Fixed

- 疑问维度的回归数据与映射说明随本轮调整更新（`doubt` 启发式本身的修复见 0.1.2）。

### Verification

- Node 24.21 + INT8 真实模型复算 `scripts/validate.py` 的 40 条 CASES：**40/40 = 100%**（zh 20/20、en 20/20，无 miss），tie-break 与 validate.py 一致。
- `npm run check` 全绿（含真实模型端到端与 tokenizer 对齐；无 assets 时显式 skip）。

## [0.1.2] - 2026-10-24

### Fixed

- 「疑问」维度提取不到：实测模型 surprise 对中文疑问句不响应（0.006~0.075），新增宿主文本启发式 `doubt`（问号/疑问词/不确定词），与 surprise 取 max 后映射到 confused；补充单测与文档（#28 / #29）。

### Changed

- 记录里的 `raw` 新增派生键 `doubt`（非模型标签，schema 允许任意 0~1 键）。

## [0.1.1] - 2026-10-24

### Added

- 新增统一维度 **confused（疑问）**：以模型 `surprise` 作为代理（模型没有 confusion/uncertainty 标签），悬浮框新增「疑问 🤔」分数条与趋势线（#25）。
- 新增 **Settings → 情绪分析器** 设置页：显示/隐藏悬浮框、立即显示、重置悬浮框位置（#26）。
- 关闭悬浮框后的 💗 重开按钮移动位置并加大可发现性（#26）。

### Changed

- Session projection `stateVersion` 1 → 2（映射语义变化，旧持久化缓存回放日志）。

### Fixed

- 重新显示时 widget 自身 `closed` 持久化导致仍然隐藏（#27）。

## [0.1.0] - 2026-10-24

### Added

- 本地 ONNX 情绪推理：`EmotionScorer`（懒加载、INT8、int64 张量、逐元素 sigmoid、512 截断、200ms 告警、异常降级）。
- 模型流水线：`scripts/export_model.py`（HF → ONNX → INT8 动态量化）与 `scripts/validate.py`（20 中文 + 20 英文自验收）。
- 硬编码映射层 `src/mapping.ts`：11 原始标签 → 统一维度，THRESHOLD / DECAY / STEP_MAX / CAP。
- 宿主集成：`agent/turn-stopping` 钩子、`plugin:emotion-analyzer/turn` ignorable 会话记录、`emotion` session projection（纯同步 fold、wire view、重启/fork 恢复）。
- Web 客户端：`shell.overlay` 悬浮框（React portal + Shadow DOM）、session 投影桥（`useProjection('emotion')`）、Settings → General 显示开关。
- 悬浮框：拖拽/位置记忆、折叠 48px emoji 徽章、300ms 分数条动画、30 轮 canvas sparkline、明暗主题、关闭/重开、rAF 合并。
- 测试：mapping / inference / projection / text / store / widget / restore，含真实模型与 tokenizer 对齐用例（无资产时显式 skip）。
- 文档：architecture、calibration、client-integration、widget、model-export、e2e、贡献规则。
- Build-time-only CI（`v*` tag 或手动 dispatch）；PR 不跑 CI。

### Known limitations

- 真实模型完整 turn 的端到端未在本机复跑（测试环境缺少可用模型路由/API key）；各段已分别验证。
- 跨平台原生模块安装仅验证 Linux + Node 24。
- 模型权重许可证为 CC-BY-NC-4.0（非商业）。
