# 模型导出与量化

> Issue #2 的实现与实测记录。文中所有数字都是本机真实运行结果；重新导出后请同步更新本节（尤其是产物大小与耗时）。

本仓库的推理完全在本地进行：从 Hugging Face 下载上游多语言情绪模型，用 Optimum 导出 ONNX，再用 onnxruntime 动态量化为 INT8，最后用内置的 40 条中英文测试句自验收。

> v0.2 起默认模型是 Horizon small（官方 INT8 ONNX，可直接下载，见 [模型注册、下载与映射](models.md)）。本页的 tabularisai 导出流程保留为 **legacy 回退资产**：默认模型未下载时插件仍可用它打分（CC-BY-NC-4.0，非商业）。

## 1. 模型来源

| 项 | 值 |
|---|---|
| Hugging Face 仓库 | `tabularisai/multilingual-emotion-classification` |
| 基座模型 | `FacebookAI/xlm-roberta-base`（XLM-RoBERTa-base） |
| 参数量 | 278,052,107（fp32 权重约 1.1 GB） |
| 任务 | 11 标签**多标签**文本分类（`problem_type=multi_label_classification`） |
| 标签（id 顺序） | anger, contempt, disgust, fear, frustration, gratitude, joy, love, neutral, sadness, surprise |
| 语言 | 多语言，训练数据覆盖 zh / en 等 20+ 语言 |
| 权重许可证 | **CC-BY-NC-4.0**（非商业使用） |
| 本仓库代码许可证 | MIT |
| 上游文件 | `model.safetensors` + `config.json` + `tokenizer.json` |

模型权重**不随仓库分发**（体积 >100 MB，且 CC-BY-NC-4.0）：使用者需在本地运行导出脚本。仓库只提交脚本、文档与 tokenizer fixture，不提交权重。

## 2. 环境与依赖

- Python 3.13（系统 `python3`），项目内 `.venv`（已 gitignore）
- 依赖全部固定在 `scripts/requirements.txt`（实测通过组合）：

| 包 | 版本 | 说明 |
|---|---|---|
| torch | 2.6.0+cpu | 只用 CPU wheel，避免拉取 CUDA/nvidia-* 依赖 |
| transformers | 4.53.3 | 与 optimum 1.27.0 兼容的上界 |
| tokenizers | 0.21.4 | fast tokenizer 运行时 |
| optimum | 1.27.0（`[exporters]`） | ONNX 导出，**不要用 2.x**（ONNX 导出已拆到 `optimum-onnx`） |
| onnx | 1.18.0 | 图校验 / 量化 I/O |
| onnxruntime | 1.23.2 | CPU 推理 + 动态量化 |
| huggingface-hub | 0.34.4 | 快照下载 |
| numpy | 2.2.6 | 张量处理 |
| protobuf | 5.29.5 | onnx/transformers 依赖 |
| sentencepiece | 0.2.1 | XLM-R SentencePiece 词表 |

安装：

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r scripts/requirements.txt
```

测试机：Intel Core i5-1240P（16 线程），Linux，无 GPU。

## 3. 产物

| 文件 | 大小 | 说明 |
|---|---|---|
| `assets/model-int8.onnx` | 266.0 MiB（278,963,213 B） | ONNX opset 14；输入 `input_ids`/`attention_mask`（int64），输出 `logits` [`batch_size`, 11] |
| `assets/tokenizer.json` | 16.3 MiB（17,098,086 B） | XLM-R SentencePiece Unigram，250,002 词表，与上游逐字节一致 |
| `assets/.model-src/` | ≈1.1 GB | HF 快照缓存，可随时删除（下次运行会重新下载） |
| `assets/validation-report.json` | ≈25 KB | validate.py 的机器可读报告，**不提交** |

fp32 ONNX 中间产物约 1.0 GiB，量化后立即删除，不保留。相对 fp32 压缩约 **3.8×**（266 MiB / 1010 MiB）。

本次实测 sha256（前 16 位）：

- `model-int8.onnx`：`0b7e861491ce57aa`…
- `tokenizer.json`：`acbd420e2269cdc1`…

忽略规则：`assets/.gitignore` 忽略该目录下除 `README.md`/`.gitignore` 外的所有文件；根 `.gitignore` 另有 `assets/model*.onnx`、`assets/tokenizer.json` 兜底。

## 4. 导出与量化流程

```sh
python3 scripts/export_model.py           # 幂等：产物已存在时直接跳过
python3 scripts/export_model.py --force   # 删除缓存并完整重建
```

脚本执行的步骤（`scripts/export_model.py`）：

1. 用 `huggingface_hub.snapshot_download` 把上游快照拉到 `assets/.model-src/`（只取 `*.json / *.safetensors`，跳过用不到的 `*.bin`）；
2. `AutoConfig` 校验 11 个标签的顺序，以及 `problem_type == "multi_label_classification"`（防上游改版）；
3. `optimum.exporters.onnx.main_export(task="text-classification", device="cpu")` 导出 fp32 ONNX（opset 14，约 21 s）；
4. `onnxruntime.quantization.quantize_dynamic(weight_type=QuantType.QInt8)` 动态量化（约 24 s）；
5. 全部步骤成功后才把产物原子替换进 `assets/`（失败不会留下半成品）；
6. 把上游 `tokenizer.json` 复制为 `assets/tokenizer.json`，并断言其分词结果与 transformers fast tokenizer **逐 token 一致**；
7. `onnx.checker` + ORT 加载 + 两条中英文样例推理，校验输入名、输出名与 [batch, 11] 形状。

首次完整运行约 220 s（含 1.1 GB 下载）；`--force` 完整重建实测 262 s（下载约 200 s + 导出/量化约 50 s）；产物已存在时默认模式立即退出。两次独立重建得到的 `model-int8.onnx` sha256 完全一致（导出与量化结果是确定的）。

### 量化方法

- **动态量化（dynamic quantization）**：权重离线转成 int8，激活值在推理时按 batch 动态求量化参数，无需校准数据集。
- onnxruntime 默认只量化 `MatMul`/`Gemm` 等矩阵乘权重；XLM-R 的 embedding（`Gather`）保持 fp32，所以是 1.0 GiB → 266 MiB（≈3.8×），而非理论 4×。
- 用 `QuantType.QInt8`（有符号 int8 权重 + 动态 uint8 激活），CPU 上走 x86 AVX/VNNI 内核；不用 fp16 是因为 CPU 无原生 fp16 加速且部分算子不支持。
- 量化未做 pre-processing / 校准（ORT 的 warning 属正常）：本模型输入是常规 token id 序列，且自验收实测 100%，不需要额外校准集。若后续发现长文本精度下降，可考虑 `per_channel=True` 或换静态量化。

## 5. 自验收结果（validate.py）

```sh
python3 scripts/validate.py
```

内置 **20 条中文 + 20 条英文**，覆盖 pleasant / sad / angry / anxious / neutral 五个统一维度（happy 已并入 pleasant）。逐元素 sigmoid 后取 top-1 原始标签，再投影到统一维度与期望比较。

**实测结果（INT8，CPU）：**

- 准确率：**40/40 = 100%**（中文 20/20，英文 20/20），阈值 80% → PASS
- 单条耗时（含分词 + 推理，单条、预热 3 轮后计时，4 intra-op threads）：
  - mean **6.1–6.9 ms**（同机两次运行 6.08 / 6.91），median 6.1–6.8 ms，p95 6.7–8.0 ms，max ≤11.5 ms
- 机器可读报告：`assets/validation-report.json`（每条含 text、raw top-1 标签与概率、统一维度分数、是否命中、tokenize/infer 耗时）
- 准确率低于 `--min-accuracy`（默认 0.8）时以退出码 1 退出，可直接接进 CI。

测试句在第一次运行前写好，运行后未做针对性调参；40 条的完整明细见 PR 评论与 `assets/validation-report.json`。INT8 精度损失在本测试集上没有体现（原始 fp32 同日对照未单独跑）。

**2026-10-24 映射重构后复算（Python venv 已清理）：** 用 Node `lib/inference.js` + `lib/mapping.js` 复算同一 40 条 CASES，映射已与 `validate.py` 同步（sad=sadness、angry 去掉 disgust、anxious=fear、unwell=max(disgust, 0.5×fear)）：**40/40 = 100%**（zh 20/20、en 20/20，无 miss），Node 侧含分词中位 8.34ms / p95 11.56ms。完整数据见 [端到端验收 §0.1.3](e2e.md)。

## 6. 统一维度映射

模型输出 11 个独立概率，插件对上层暴露 7 个统一维度（happy 已并入 pleasant；unwell 与 sad 解耦）：

| 统一维度 | 计算方式 |
|---|---|
| pleasant（愉快） | max(joy, love, gratitude)；happy 已合并 |
| sad | max(sadness) |
| angry | max(anger, contempt, frustration)；disgust 只归 unwell（#32） |
| anxious | max(fear) |
| unwell（反感） | max(disgust, fear × 0.5)，与 sad 解耦（#32） |
| confused（疑问） | max(surprise, doubt) — **代理指标**；`doubt` 是插件运行时的文本启发式（问号/疑问词/不确定词），不是模型输出，validate.py 只验证模型侧的 surprise |
| neutral | neutral |

说明：

- **top-1 统一维度存在并列**（例如只有 joy 高时多个维度分数接近），实现里用固定顺序破平：pleasant → sad → angry → anxious → unwell → confused → neutral。
- `confused` 是 **surprise 的代理指标**：模型没有真正的 confusion/uncertainty 标签，语义上最接近的是 surprise；文档与 UI 都按“疑问”展示，不代表模型具备真实困惑分类能力。测试集仍以五类基础情绪为主。
- `disgust` 只归 `unwell`：实测“恶心”句 disgust≈0.99，若同时进 angry 会重复点亮两条（#32）。
- 该映射必须与 TS 端 `src/mapping.ts`（Issue #4）保持一致；改动时同步 `scripts/validate.py` 与本文。

## 7. tokenizer fixture（TS 端逐 token 对齐）

仓库提交 `tests/fixtures/tokenizer-reference.json`，供 TS 端推理实现做验收：2 条中文 + 2 条英文（含中英混排），格式为

```json
{ "cases": [ { "text": "...", "ids": [0, ...], "attention_mask": [1, ...] } ] }
```

fixture 由 Python `AutoTokenizer(fast)` 生成，并额外断言与独立加载的 `PreTrainedTokenizerFast(tokenizer_file="assets/tokenizer.json")` 完全一致，包括 `<s>`（id 0）与 `</s>`（id 2）两个特殊 token：

```python
from transformers import AutoTokenizer, PreTrainedTokenizerFast

ref = AutoTokenizer.from_pretrained("assets/.model-src", use_fast=True)
standalone = PreTrainedTokenizerFast(tokenizer_file="assets/tokenizer.json")
for text in ["我今天真的很开心，feels great！", "I feel 有点难过 today, not gonna lie."]:
    assert ref(text)["input_ids"] == standalone(text)["input_ids"]
```

TS 端验收方式：对 fixture 里的 `text` 分词后，`ids` 与 `attention_mask` 必须逐元素相等（包括特殊 token，不额外手动拼接）。若不一致，优先检查是否用了 SentencePiece 原始模型重新转换、special tokens 配置、或 normalization（NFC）差异。

## 8. 常见坑

### 8.1 tokenizer 对齐

XLM-R 是 SentencePiece **Unigram** 词表，必须直接用上游的 `tokenizer.json`（fast tokenizer 格式），不要用 `sentencepiece` 模型或自己转的词表。导出脚本已内置"导出 → 独立加载 → 逐 token 比对"三步校验；TS 端用 fixture 验收。特殊 token：`<s>=0`、`<pad>=1`、`</s>=2`、`<unk>=3`、`<mask>=250001`。

### 8.2 int64

ONNX 图的 `input_ids`/`attention_mask` 是 **int64**（opset 14 的 `tensor(int64)`）。numpy 在 64 位 Linux 上通常是 int64，但在 Windows/32 位 Python 上可能拿到 int32，会直接报类型错误；脚本里显式 `astype(np.int64)`。TS/onnxruntime-node 侧应使用 `BigInt64Array`（`Int64` tensor），不是 `int32`。

### 8.3 sigmoid vs softmax

模型是 **11 个标签的多标签分类**（`problem_type=multi_label_classification`，训练用 BCE），logits 必须**逐元素 sigmoid**，不能 softmax：多个情绪可以同时高（例如 joy 与 love 同时 0.9），softmax 会把它们强行归一化并改变 top-1。插件里的阈值判断也基于独立概率。

### 8.4 512 截断

XLM-R 位置编码上限是 514（512 + 2 个特殊 token），`tokenizer(...)` 必须带 `truncation=True, max_length=512`，否则超长回复会在 ONNX 里报 position embedding 越界或直接被截。插件对超长主模型回复会截断到 512 token（只影响打分，不改回复本身）。注意上游模型主要用短文本训练，超长文本的情绪分会被稀释，需要时可在插件层做分段平均。

### 8.5 版本漂移

optimum 2.x 已把 ONNX 导出拆到 `optimum-onnx`，`main_export` 的旧路径会变；transformers 也都有限制区间。必须按 `scripts/requirements.txt` 的固定版本安装，否则导出脚本会在 import/签名处失败（报错信息里会提示重装依赖）。升级依赖后请重跑 `scripts/validate.py` 并更新本文数字。

### 8.6 缓存、磁盘与内存

- 下载的东西都在 `assets/.model-src/`（约 1.1 GB），`--force` 会删掉重下；日常重建用默认幂等模式即可。
- 导出/量化峰值内存约 2–3 GB，需要至少 ~6 GB 空闲磁盘（脚本会预检），低内存机器建议先关掉其它进程。
- 量化产物不保留 fp32 图；如果要做 FP32/INT8 对比，请在导出后自行保留中间文件。

## 9. 参考

- 上游模型：<https://huggingface.co/tabularisai/multilingual-emotion-classification>
- Optimum ONNX 导出文档：<https://huggingface.co/docs/optimum/exporters/onnx/usage_guides/export_a_model>
- onnxruntime 动态量化：<https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html>
