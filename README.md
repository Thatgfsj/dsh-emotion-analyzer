# dsh-emotion-analyzer

> DSH（DeepSeek Harness）情绪分析器插件：对主模型的每条回复做**本地**情绪打分，把累积情绪状态投影进 Session，并在 DSH 网站注入一个可拖拽的悬浮情绪监测框。

- 本地 ONNX 推理（CPU INT8），**不调用任何第三方模型 API**
- 主模型零额外 Token 成本；每次回复后异步打分
- 多语言（中/英），XLM-RoBERTa-base 多标签情绪分类
- 状态写入 Session projection，重启/分叉可恢复
- Web Components + Shadow DOM 悬浮框：拖拽、折叠 emoji 徽章、分数条动画、30 轮 canvas sparkline、明暗主题

## 状态

工程骨架已就绪，模块实现见 Issue #2–#8（模型导出、映射、推理、宿主集成、悬浮框、客户端桥、文档）。

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-emotion-analyzer
```

模型资产需要先本地导出（见下节），因为权重不随仓库分发。

## 模型导出

模型权重不提交进仓库（CC-BY-NC-4.0，>100 MB），首次使用需在本地导出（Python 3.13 + CPU）：

```sh
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
python3 scripts/export_model.py     # 幂等；加 --force 完整重建
python3 scripts/validate.py         # 20 中文 + 20 英文，top-1 ≥ 80%
```

产物：`assets/model-int8.onnx`（266 MiB，Optimum 导出 + onnxruntime 动态 INT8 量化）与 `assets/tokenizer.json`（16.3 MiB）。本机实测 CPU 单条推理约 **6 ms**（i5-1240P，4 线程，含分词；两次运行 6.1–6.9 ms），`validate.py` 40/40 通过（中文 20/20、英文 20/20）。

模型 `tabularisai/multilingual-emotion-classification`（XLM-RoBERTa-base，278M，11 标签多标签）权重许可证为 **CC-BY-NC-4.0**（非商业）；本仓库代码为 MIT。完整流程、量化方法、实测数据与常见坑见 [模型导出与量化](docs/model-export.md)。

## 可调参数

映射层参数集中在 `src/mapping.ts` 顶部：`THRESHOLD`、`DECAY`、`STEP_MAX`、`CAP`。映射规则与累积公式见[架构文档的“情绪映射与累积”](docs/architecture.md#情绪映射与累积srcmappingts)。

## 文档

- [架构](docs/architecture.md)
- [模型导出与量化](docs/model-export.md)
- [DSH 宿主 API 校准](docs/calibration.md)
- [贡献规则](CONTRIBUTING.md)

## License

代码：MIT（见 `LICENSE`）。模型权重：CC-BY-NC-4.0（上游）。
