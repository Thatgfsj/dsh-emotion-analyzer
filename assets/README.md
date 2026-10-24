# assets

模型产物不提交进仓库：

- `model-int8.onnx` — Optimum 导出 + onnxruntime 动态 INT8 量化后的 XLM-RoBERTa 序列分类模型（266 MiB / 278,963,213 B）
- `tokenizer.json` — XLM-R SentencePiece Unigram 分词器（16.3 MiB，与上游逐字节一致）
- `validation-report.json` — `scripts/validate.py` 的机器可读报告（本地生成，不提交）
- `.model-src/` — Hugging Face 快照缓存（约 1.1 GB，可删除）

生成方式（幂等；`--force` 完整重建）：

```sh
python3 scripts/export_model.py
python3 scripts/validate.py
```

上游模型 `tabularisai/multilingual-emotion-classification` 的权重许可证是 **CC-BY-NC-4.0**（非商业），本项目不随仓库再分发权重。导出/量化流程、实测耗时与常见坑见 [docs/model-export.md](../docs/model-export.md)。
