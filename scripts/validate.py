#!/usr/bin/env python3
"""Validate the exported INT8 ONNX model on a fixed bilingual test set.

What this script does (Issue #2):

  * loads assets/model-int8.onnx with onnxruntime (CPU) and
    assets/tokenizer.json with the transformers fast tokenizer;
  * runs 40 hand-written sentences (20 Chinese + 20 English) covering six
    unified emotions: happy / pleasant / sad / angry / anxious / neutral;
  * applies **per-element sigmoid** (the model is a multi-label classifier,
    softmax would be wrong) and reads the top-1 raw label;
  * projects the 11 raw probabilities onto the unified dimensions the DSH
    plugin exposes, compares the top-1 unified dimension with the expected one
    and asserts accuracy >= 80% (exit code 1 otherwise);
  * prints one line per sentence (text, raw top-1 label, unified dimension,
    hit/miss, latency) and writes a machine-readable report to
    assets/validation-report.json (git-ignored, not committed).

Unified mapping (mirrors the TS plugin, see docs/model-export.md):

    happy   <- max(joy, gratitude)
    pleasant<- max(joy, love, gratitude)
    sad     <- max(sadness, frustration)
    angry   <- max(anger, disgust, contempt, frustration)
    anxious <- max(fear, frustration)
    unwell  <- sadness * 0.5 + disgust * 0.4   (weighted sum)
    neutral <- neutral
    surprise has no unified dimension yet (raw score is kept in the report).

Ties between unified dimensions are broken deterministically in this order:
happy, pleasant, sad, angry, anxious, unwell, neutral. A sentence whose raw
top-1 label is surprise counts as a miss (surprise is not mapped yet), even if
another dimension happens to score high.

Usage:

    python3 -m venv .venv && . .venv/bin/activate
    pip install -r scripts/requirements.txt
    python scripts/validate.py
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

LABELS = [
    "anger",
    "contempt",
    "disgust",
    "fear",
    "frustration",
    "gratitude",
    "joy",
    "love",
    "neutral",
    "sadness",
    "surprise",
]
LABEL_INDEX = {label: idx for idx, label in enumerate(LABELS)}

# Deterministic tie-break order for equal unified scores (documented above).
TIE_BREAK_ORDER = ["happy", "pleasant", "sad", "angry", "anxious", "unwell", "neutral"]

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = REPO_ROOT / "assets" / "model-int8.onnx"
DEFAULT_TOKENIZER = REPO_ROOT / "assets" / "tokenizer.json"
DEFAULT_REPORT = REPO_ROOT / "assets" / "validation-report.json"
MAX_LENGTH = 512
MIN_ACCURACY = 0.80

# (language, expected unified dimension, sentence)
CASES: list[tuple[str, str, str]] = [
    # ------------------------------- Chinese (20) -------------------------------
    ("zh", "happy", "今天收到录取通知书，我太开心了！"),
    ("zh", "happy", "谢谢你三年来的帮助，我真的很感激你。"),
    ("zh", "happy", "宝宝第一次叫妈妈，我高兴得流下了眼泪。"),
    ("zh", "happy", "我们队赢了决赛，全场都在欢呼庆祝。"),
    ("zh", "pleasant", "我真的很爱我的猫，它是我最好的伙伴。"),
    ("zh", "pleasant", "和你在一起的时候，我觉得特别安心、温暖。"),
    ("zh", "pleasant", "我很爱我的家人，他们是我生命中最重要的人。"),
    ("zh", "sad", "听到奶奶去世的消息，我难过得说不出话。"),
    ("zh", "sad", "养了三年的狗走丢了，我每天都特别伤心。"),
    ("zh", "sad", "分手以后，我一直沉浸在失落和难过里。"),
    ("zh", "angry", "他当着所有人的面羞辱我，我气得浑身发抖。"),
    ("zh", "angry", "这种欺骗消费者的行为真让人愤怒。"),
    ("zh", "angry", "我讨厌别人不尊重我的劳动成果。"),
    ("zh", "anxious", "明天就要面试了，我紧张得整晚睡不着。"),
    ("zh", "anxious", "深夜独自走在空无一人的小巷里，我很害怕。"),
    ("zh", "anxious", "我担心体检结果会很糟糕，心里七上八下。"),
    ("zh", "neutral", "今天下午三点在五楼会议室开会。"),
    ("zh", "neutral", "这份报告的格式需要按照模板重新调整。"),
    ("zh", "neutral", "水在一百摄氏度时沸腾。"),
    ("zh", "neutral", "请把文件发到我的邮箱，并在周五前提交。"),
    # ------------------------------- English (20) -------------------------------
    ("en", "happy", "I got the offer today and I am absolutely thrilled!"),
    ("en", "happy", "Thank you so much for your support, I really appreciate it."),
    ("en", "happy", "Our team won the final and everyone is celebrating!"),
    ("en", "happy", "She said yes and I have never been happier in my life."),
    ("en", "pleasant", "I love my girlfriend and want to spend the rest of my life with her."),
    ("en", "pleasant", "Cuddling with my cat on a rainy Sunday feels wonderful."),
    ("en", "pleasant", "Spending time with my family always fills me with warmth."),
    ("en", "sad", "My grandfather passed away last week and I still cannot believe it."),
    ("en", "sad", "My dog ran away and I have been crying all day."),
    ("en", "sad", "I feel so lonely and empty since she left me."),
    ("en", "angry", "He humiliated me in front of everyone and I am furious."),
    ("en", "angry", "This company cheated its customers and it makes me sick."),
    ("en", "angry", "I hate how rude the staff were to us."),
    ("en", "anxious", "I have a job interview tomorrow and I cannot stop worrying."),
    ("en", "anxious", "Walking home alone in the dark really scares me."),
    ("en", "anxious", "I am terrified that the medical test results will be bad."),
    ("en", "neutral", "The meeting is scheduled for 3 p.m. in room 502."),
    ("en", "neutral", "Please reformat the report according to the template."),
    ("en", "neutral", "Water boils at 100 degrees Celsius at sea level."),
    ("en", "neutral", "Send the file to my email and submit it before Friday."),
]


def sigmoid(x):
    import numpy as np

    return 1.0 / (1.0 + np.exp(-x))


def unified_scores(probs) -> dict[str, float]:
    """Project the 11 raw multi-label probabilities onto unified dimensions."""
    p = {label: float(probs[LABEL_INDEX[label]]) for label in LABELS}
    return {
        "happy": max(p["joy"], p["gratitude"]),
        "pleasant": max(p["joy"], p["love"], p["gratitude"]),
        "sad": max(p["sadness"], p["frustration"]),
        "angry": max(p["anger"], p["disgust"], p["contempt"], p["frustration"]),
        "anxious": max(p["fear"], p["frustration"]),
        "unwell": min(1.0, p["sadness"] * 0.5 + p["disgust"] * 0.4),
        "neutral": p["neutral"],
    }


def top_unified(scores: dict[str, float]) -> str:
    best = max(scores.values())
    for dim in TIE_BREAK_ORDER:
        # Compare with a tiny epsilon so float noise does not reorder real ties.
        if best - scores[dim] <= 1e-9:
            return dim
    return TIE_BREAK_ORDER[0]


def make_session(model_path: Path, threads: int):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(
        str(model_path), sess_options=options, providers=["CPUExecutionProvider"]
    )


def run_inference(session, tokenizer, text: str):
    """Return (raw_probs, raw_top_label, tokenize_ms, infer_ms)."""
    import numpy as np

    started = time.perf_counter()
    encoded = tokenizer(
        text, return_tensors="np", truncation=True, max_length=MAX_LENGTH
    )
    input_ids = np.asarray(encoded["input_ids"], dtype=np.int64)
    attention_mask = np.asarray(encoded["attention_mask"], dtype=np.int64)
    tokenize_ms = (time.perf_counter() - started) * 1000.0

    started = time.perf_counter()
    logits = session.run(
        None,
        {"input_ids": input_ids, "attention_mask": attention_mask},
    )[0]
    infer_ms = (time.perf_counter() - started) * 1000.0

    probs = sigmoid(np.asarray(logits, dtype=np.float64)).reshape(-1)
    raw_top_index = int(probs.argmax())
    return probs, LABELS[raw_top_index], tokenize_ms, infer_ms


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1))))
    return ordered[index]


def human_size(num_bytes: int) -> str:
    value = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024.0 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{value:.0f} B"
        value /= 1024.0
    return f"{value:.1f} GB"


def load_runtime_versions() -> dict[str, str]:
    import onnxruntime
    import transformers

    return {
        "python": sys.version.split()[0],
        "onnxruntime": onnxruntime.__version__,
        "transformers": transformers.__version__,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate assets/model-int8.onnx on 20 Chinese + 20 English sentences.",
    )
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--tokenizer", type=Path, default=DEFAULT_TOKENIZER)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument(
        "--min-accuracy", type=float, default=MIN_ACCURACY,
        help="required top-1 unified accuracy (default: 0.8)",
    )
    parser.add_argument(
        "--threads", type=int, default=4,
        help="onnxruntime intra-op threads (default: 4)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if not args.model.is_file():
        print(
            f"[validate] ERROR: model not found: {args.model}\n"
            "Run scripts/export_model.py first (weights are not committed).",
            file=sys.stderr,
        )
        return 1
    if not args.tokenizer.is_file():
        print(
            f"[validate] ERROR: tokenizer not found: {args.tokenizer}\n"
            "Run scripts/export_model.py first.",
            file=sys.stderr,
        )
        return 1

    from transformers import PreTrainedTokenizerFast

    try:
        tokenizer = PreTrainedTokenizerFast(tokenizer_file=str(args.tokenizer))
    except Exception as exc:
        print(f"[validate] ERROR: cannot load tokenizer: {exc}", file=sys.stderr)
        return 1
    try:
        session = make_session(args.model, threads=max(1, args.threads))
    except Exception as exc:
        print(f"[validate] ERROR: cannot load ONNX model: {exc}", file=sys.stderr)
        return 1

    # Warm up so the per-sentence timings are not dominated by lazy init.
    for _ in range(3):
        for _lang, _expected, text in CASES[:2]:
            run_inference(session, tokenizer, text)

    results = []
    for index, (lang, expected, text) in enumerate(CASES, start=1):
        probs, raw_top_label, tokenize_ms, infer_ms = run_inference(session, tokenizer, text)
        scores = unified_scores(probs)
        predicted = top_unified(scores)
        hit = predicted == expected and raw_top_label != "surprise"
        results.append(
            {
                "index": index,
                "lang": lang,
                "text": text,
                "expected": expected,
                "predicted": predicted,
                "raw_top_label": raw_top_label,
                "raw_top_prob": round(float(probs[LABEL_INDEX[raw_top_label]]), 6),
                "unified_scores": {key: round(value, 6) for key, value in scores.items()},
                "hit": hit,
                "latency_ms": round(tokenize_ms + infer_ms, 3),
                "tokenize_ms": round(tokenize_ms, 3),
                "infer_ms": round(infer_ms, 3),
                "num_tokens": None,
            }
        )

    correct = sum(1 for row in results if row["hit"])
    total = len(results)
    accuracy = correct / total if total else 0.0
    latencies = [row["latency_ms"] for row in results]
    summary = {
        "total": total,
        "correct": correct,
        "accuracy": round(accuracy, 4),
        "min_accuracy": args.min_accuracy,
        "passed": accuracy >= args.min_accuracy,
        "by_language": {},
        "latency_ms": {
            "mean": round(statistics.mean(latencies), 3) if latencies else 0.0,
            "median": round(statistics.median(latencies), 3) if latencies else 0.0,
            "p95": round(percentile(latencies, 0.95), 3),
            "min": round(min(latencies), 3) if latencies else 0.0,
            "max": round(max(latencies), 3) if latencies else 0.0,
        },
        "misses": [
            {
                "index": row["index"],
                "lang": row["lang"],
                "text": row["text"],
                "expected": row["expected"],
                "predicted": row["predicted"],
                "raw_top_label": row["raw_top_label"],
            }
            for row in results
            if not row["hit"]
        ],
    }
    for lang in ("zh", "en"):
        rows = [row for row in results if row["lang"] == lang]
        hits = sum(1 for row in rows if row["hit"])
        summary["by_language"][lang] = {
            "total": len(rows),
            "correct": hits,
            "accuracy": round(hits / len(rows), 4) if rows else 0.0,
        }

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": {
            "repo_id": "tabularisai/multilingual-emotion-classification",
            "path": str(args.model),
            "size_bytes": args.model.stat().st_size,
            "size_human": human_size(args.model.stat().st_size),
            "quantization": "onnxruntime.quantization.quantize_dynamic(weight_type=QuantType.QInt8)",
            "activation": "per-element sigmoid (multi-label)",
            "labels": LABELS,
        },
        "tokenizer": {
            "path": str(args.tokenizer),
            "size_bytes": args.tokenizer.stat().st_size,
            "max_length": MAX_LENGTH,
        },
        "runtime": {**load_runtime_versions(), "threads": args.threads},
        "mapping": {
            "happy": "max(joy, gratitude)",
            "pleasant": "max(joy, love, gratitude)",
            "sad": "max(sadness, frustration)",
            "angry": "max(anger, disgust, contempt, frustration)",
            "anxious": "max(fear, frustration)",
            "unwell": "sadness*0.5 + disgust*0.4 (clamped to 1.0)",
            "neutral": "neutral",
            "surprise": "unmapped (raw score kept; raw top-1 surprise counts as a miss)",
            "tie_break_order": TIE_BREAK_ORDER,
        },
        "summary": summary,
        "cases": results,
    }

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # ------------------------------- console output -------------------------------
    print("=== DSH emotion model validation ===========================================")
    print(f"model    : {args.model} ({human_size(args.model.stat().st_size)})")
    print(f"tokenizer: {args.tokenizer}")
    versions = load_runtime_versions()
    print(
        f"runtime  : onnxruntime {versions['onnxruntime']}, transformers "
        f"{versions['transformers']}, python {versions['python']}, threads={args.threads}"
    )
    print(f"cases    : {total} (20 zh + 20 en), min accuracy {args.min_accuracy:.0%}")
    print("-" * 78)
    print(f"{'#':>3}  {'lang':<4} {'expected':<9} {'raw top-1':<14} {'unified':<9} {'ms':>7}  hit  text")
    for row in results:
        raw = f"{row['raw_top_label']} {row['raw_top_prob']:.3f}"
        hit = "Y" if row["hit"] else "N"
        print(
            f"{row['index']:>3}  {row['lang']:<4} {row['expected']:<9} {raw:<14} "
            f"{row['predicted']:<9} {row['latency_ms']:>7.2f}  {hit}    {row['text']}"
        )
    print("-" * 78)
    zh, en = summary["by_language"]["zh"], summary["by_language"]["en"]
    print(
        f"accuracy : {correct}/{total} = {accuracy:.1%} "
        f"(zh {zh['correct']}/{zh['total']}, en {en['correct']}/{en['total']})"
    )
    latency = summary["latency_ms"]
    print(
        f"latency  : mean {latency['mean']:.2f} ms | median {latency['median']:.2f} ms | "
        f"p95 {latency['p95']:.2f} ms | max {latency['max']:.2f} ms (CPU, {args.threads} threads)"
    )
    if summary["misses"]:
        print("misses   :")
        for miss in summary["misses"]:
            print(
                f"  #{miss['index']:>2} [{miss['lang']}] expected {miss['expected']}, "
                f"got {miss['predicted']} (raw {miss['raw_top_label']}): {miss['text']}"
            )
    print(f"report   : {args.report}")
    if accuracy >= args.min_accuracy:
        print(f"RESULT   : PASS (accuracy {accuracy:.1%} >= {args.min_accuracy:.0%})")
        return 0
    print(
        f"RESULT   : FAIL (accuracy {accuracy:.1%} < {args.min_accuracy:.0%})",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
