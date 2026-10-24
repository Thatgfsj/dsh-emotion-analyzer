# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- 新增统一维度 **confused（疑问）**：以模型 `surprise` 作为代理（当前模型没有 confusion/uncertainty 标签），悬浮框新增「疑问 🤔」分数条与趋势线。
- 新增 **Settings → 情绪分析器** 设置页：显示/隐藏悬浮框、立即显示、重置悬浮框位置。
- 关闭悬浮框后的 💗 重开按钮移动位置并加大可发现性；修复重新显示时 widget 自身 closed 持久化导致仍然隐藏的问题。

### Changed

- Session projection `stateVersion` 1 → 2（映射语义变化，旧持久化缓存会重放日志）。
- 重新导出/校验脚本的映射表同步 confused。

## [0.1.0] - 2026-10-24

### Added

- 本地 ONNX 情绪推理：`EmotionScorer`（懒加载、INT8、int64 张量、逐元素 sigmoid、512 截断、200ms 告警、异常降级）。
- 模型流水线：`scripts/export_model.py`（HF → ONNX → INT8 动态量化）与 `scripts/validate.py`（20 中文 + 20 英文自验收，40/40）。
- 硬编码映射层 `src/mapping.ts`：11 原始标签 → 7 统一维度，THRESHOLD/DECAY/STEP_MAX/CAP。
- 宿主集成：`agent/turn-stopping` 钩子、`plugin:emotion-analyzer/turn` ignorable 会话记录、`emotion` session projection（纯同步 fold、wire view、重启/fork 恢复）。
- Web 客户端：`shell.overlay` 悬浮框（React portal + Shadow DOM）、session 投影桥（`useProjection('emotion')`）、Settings → General 显示开关。
- 悬浮框：拖拽/位置记忆、折叠 48px emoji 徽章、300ms 分数条动画、30 轮 canvas sparkline、明暗主题、关闭/重开、rAF 合并。
- 测试：mapping 16 / inference 13 / projection 6 / text 5 / store 2 / widget 21 / restore 4，含真实模型与 tokenizer 对齐用例（无资产时显式 skip）。
- 文档：architecture、calibration、client-integration、widget、model-export、e2e、贡献规则。
- Build-time-only CI（`v*` tag 或手动 dispatch）；PR 不跑 CI。

### Known limitations

- 真实模型完整 turn 的端到端未在本机复跑（测试环境缺少可用模型路由/API key）；各段已分别验证。
- 跨平台原生模块安装仅验证 Linux + Node 24。
- 模型权重许可证为 CC-BY-NC-4.0（非商业）。
