# assets

模型产物不提交进仓库：

- `model-int8.onnx` — INT8 动态量化后的 XLM-RoBERTa 序列分类模型（约 280 MB）
- `tokenizer.json` — SentencePiece Unigram 分词器

生成方式：

```sh
python3 scripts/export_model.py
python3 scripts/validate.py
```

上游模型 `tabularisai/multilingual-emotion-classification` 的权重许可证是 **CC-BY-NC-4.0**（非商业），本项目不随仓库再分发权重。
