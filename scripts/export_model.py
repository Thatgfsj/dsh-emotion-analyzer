#!/usr/bin/env python3
"""Download, export and quantize the emotion model used by DSH Emotion Analyzer.

Pipeline (Issue #2):

  1. download tabularisai/multilingual-emotion-classification from Hugging Face
     (XLM-RoBERTa-base, 278M params, 11 multi-label emotions, CC-BY-NC-4.0);
  2. export it to ONNX with Hugging Face Optimum (task: text-classification);
  3. dynamically quantize the fp32 graph to INT8 (QuantType.QInt8) with
     onnxruntime.quantization;
  4. write assets/model-int8.onnx + assets/tokenizer.json and sanity check that
     both load correctly and that the exported tokenizer matches the original
     transformers fast tokenizer token-for-token.

The script is idempotent: it exits early when both artifacts already exist.
Pass --force to regenerate them. Model weights are NEVER committed
(assets/.gitignore keeps them out of git).

Usage:

    python3 -m venv .venv && . .venv/bin/activate
    pip install -r scripts/requirements.txt
    python scripts/export_model.py            # first run / no-op when present
    python scripts/export_model.py --force    # rebuild the artifacts
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import tempfile
import time
from pathlib import Path

MODEL_ID = "tabularisai/multilingual-emotion-classification"
EXPECTED_LABELS = [
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

REPO_ROOT = Path(__file__).resolve().parents[1]
ASSETS_DIR = REPO_ROOT / "assets"
MODEL_PATH = ASSETS_DIR / "model-int8.onnx"
TOKENIZER_PATH = ASSETS_DIR / "tokenizer.json"
SRC_DIR = ASSETS_DIR / ".model-src"

# Sentences used for the export/quantization sanity check. They are independent
# from the real evaluation set in scripts/validate.py.
SANITY_SENTENCES = [
    "I am so happy today!",
    "\u542c\u5230\u8fd9\u4e2a\u6d88\u606f\uff0c\u6211\u5f88\u96be\u8fc7\u3002",
]


class ExportError(RuntimeError):
    """A recoverable, user-facing export failure."""


def log(msg: str) -> None:
    print(f"[export] {msg}", flush=True)


def human_size(num_bytes: int) -> str:
    value = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024.0 or unit == "GB":
            return f"{value:.1f} {unit}" if unit != "B" else f"{value:.0f} B"
        value /= 1024.0
    return f"{value:.1f} GB"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_dependencies() -> None:
    """Fail fast with an actionable message when the venv is incomplete."""
    missing = []
    for module in ("torch", "transformers", "optimum", "onnx", "onnxruntime"):
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        raise ExportError(
            "missing Python dependencies: "
            + ", ".join(missing)
            + "\nInstall them first:\n"
            "  python3 -m venv .venv\n"
            "  . .venv/bin/activate\n"
            "  pip install -r scripts/requirements.txt"
        )


def check_disk_space(required_gib: float = 6.0) -> None:
    free = shutil.disk_usage(ASSETS_DIR.parent).free
    if free < required_gib * 1024**3:
        raise ExportError(
            f"not enough free disk space: {human_size(free)} available, "
            f"need ~{required_gib:.0f} GB for the fp32 ONNX graph + INT8 copy"
        )


def download_source(force: bool) -> Path:
    """Fetch the HF snapshot into assets/.model-src (idempotent)."""
    from huggingface_hub import snapshot_download

    if force and SRC_DIR.exists():
        log("removing cached model source (--force)")
        shutil.rmtree(SRC_DIR)
    SRC_DIR.mkdir(parents=True, exist_ok=True)

    log(f"downloading {MODEL_ID} (~1.1 GB, may take a few minutes)")
    started = time.monotonic()
    try:
        snapshot_download(
            repo_id=MODEL_ID,
            local_dir=str(SRC_DIR),
            allow_patterns=["*.json", "*.safetensors", "*.txt"],
            ignore_patterns=["*.bin", "*.h5", "*.msgpack", "*.ot"],
        )
    except Exception as exc:  # network / auth / disk errors
        raise ExportError(
            f"failed to download {MODEL_ID}: {exc}\n"
            "Check network access to https://huggingface.co and retry."
        ) from exc

    for name in ("config.json", "tokenizer.json"):
        if not (SRC_DIR / name).is_file():
            raise ExportError(f"downloaded snapshot is incomplete: missing {name}")
    if not any(SRC_DIR.glob("*.safetensors")) and not (SRC_DIR / "pytorch_model.bin").is_file():
        raise ExportError("downloaded snapshot is incomplete: no model weights found")

    log(f"model source ready in {time.monotonic() - started:.1f}s -> {SRC_DIR}")
    return SRC_DIR


def describe_model_config() -> None:
    from transformers import AutoConfig

    config = AutoConfig.from_pretrained(str(SRC_DIR))
    id2label = {int(k): v for k, v in config.id2label.items()}
    labels = [id2label[i] for i in sorted(id2label)]
    if labels != EXPECTED_LABELS:
        raise ExportError(
            "unexpected label space for " + MODEL_ID + f": {labels}\n"
            "The rest of the pipeline assumes: " + ", ".join(EXPECTED_LABELS)
        )
    if getattr(config, "problem_type", None) != "multi_label_classification":
        raise ExportError(
            "unexpected problem_type=" + repr(getattr(config, "problem_type", None)) +
            " (expected 'multi_label_classification' - the model needs per-element sigmoid)"
        )
    log(
        "config ok: 11 multi-label emotions, hidden=%d, layers=%d"
        % (config.hidden_size, config.num_hidden_layers)
    )


def export_fp32(work_dir: Path) -> Path:
    """Export the transformers checkpoint to a plain ONNX graph via Optimum."""
    from optimum.exporters.onnx import main_export

    out_dir = work_dir / "onnx-fp32"
    log("exporting ONNX with optimum (fp32, CPU)")
    started = time.monotonic()
    try:
        main_export(
            model_name_or_path=str(SRC_DIR),
            output=str(out_dir),
            task="text-classification",
            device="cpu",
        )
    except Exception as exc:
        raise ExportError(
            f"optimum ONNX export failed: {exc}\n"
            "Make sure the requirement pins in scripts/requirements.txt are "
            "installed in the active virtualenv."
        ) from exc

    candidates = sorted(out_dir.glob("*.onnx"))
    if not candidates:
        raise ExportError(f"optimum reported success but wrote no .onnx file into {out_dir}")
    if len(candidates) > 1:
        raise ExportError(
            "unexpected: multiple ONNX files exported: "
            + ", ".join(p.name for p in candidates)
        )
    log(
        "exported fp32 graph in %.1fs: %s"
        % (time.monotonic() - started, human_size(candidates[0].stat().st_size))
    )
    return candidates[0]


def _make_session(onnx_path: Path):
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    return ort.InferenceSession(
        str(onnx_path), sess_options=options, providers=["CPUExecutionProvider"]
    )


def _sanity_infer(session, tokenizer, text: str):
    import numpy as np

    encoded = tokenizer(text, return_tensors="np")
    feeds = {
        "input_ids": encoded["input_ids"].astype(np.int64),
        "attention_mask": encoded["attention_mask"].astype(np.int64),
    }
    logits = session.run(None, feeds)[0]
    probs = 1.0 / (1.0 + np.exp(-logits))
    return probs.reshape(-1)


def verify_int8(model_path: Path, tokenizer_path: Path) -> None:
    """Load the INT8 graph and check inputs, outputs and a tiny inference."""
    import numpy as np
    import onnx

    log("verifying INT8 artifacts")
    onnx.checker.check_model(str(model_path))
    session = _make_session(model_path)
    input_names = {i.name for i in session.get_inputs()}
    output_names = [o.name for o in session.get_outputs()]
    if "input_ids" not in input_names or "attention_mask" not in input_names:
        raise ExportError(f"unexpected ONNX inputs: {sorted(input_names)}")
    if len(output_names) != 1:
        raise ExportError(f"unexpected ONNX outputs: {output_names}")
    output_shape = session.get_outputs()[0].shape
    if output_shape[-1] not in (len(EXPECTED_LABELS), "11", None):
        raise ExportError(f"unexpected logits shape: {output_shape}")

    from transformers import PreTrainedTokenizerFast

    tokenizer = PreTrainedTokenizerFast(tokenizer_file=str(tokenizer_path))
    for text in SANITY_SENTENCES:
        probs = _sanity_infer(session, tokenizer, text)
        if probs.shape != (len(EXPECTED_LABELS),):
            raise ExportError(f"bad logits vector for {text!r}: {probs.shape}")
        if not np.all(np.isfinite(probs)):
            raise ExportError(f"non-finite sigmoid output for {text!r}")
    log("INT8 model loads and runs (CPUExecutionProvider, 11 logits per input)")


def export_tokenizer() -> None:
    """Copy the HF tokenizer.json into assets/ and verify token-for-token equality."""
    from huggingface_hub import hf_hub_download
    from transformers import AutoTokenizer, PreTrainedTokenizerFast

    log("staging assets/tokenizer.json")
    try:
        downloaded = Path(hf_hub_download(repo_id=MODEL_ID, filename="tokenizer.json"))
    except Exception as exc:
        raise ExportError(f"failed to download tokenizer.json: {exc}") from exc

    tmp_path = TOKENIZER_PATH.with_suffix(".json.tmp")
    shutil.copyfile(downloaded, tmp_path)
    tmp_path.replace(TOKENIZER_PATH)

    reference = AutoTokenizer.from_pretrained(str(SRC_DIR), use_fast=True)
    exported = PreTrainedTokenizerFast(tokenizer_file=str(TOKENIZER_PATH))
    for text in SANITY_SENTENCES:
        got = exported(text)["input_ids"]
        expected = reference(text)["input_ids"]
        if got != expected:
            raise ExportError(
                "tokenizer.json does not match the reference fast tokenizer:\n"
                f"  text     = {text!r}\n  exported = {got}\n  expected = {expected}"
            )
    log("tokenizer.json matches the transformers fast tokenizer token-for-token")


def run(force: bool) -> int:
    started = time.monotonic()
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    if not force and MODEL_PATH.is_file() and TOKENIZER_PATH.is_file():
        log("artifacts already present, nothing to do (use --force to rebuild)")
        log(f"  {MODEL_PATH.relative_to(REPO_ROOT)}: {human_size(MODEL_PATH.stat().st_size)}")
        log(f"  {TOKENIZER_PATH.relative_to(REPO_ROOT)}: {human_size(TOKENIZER_PATH.stat().st_size)}")
        return 0

    check_dependencies()
    check_disk_space()
    download_source(force)
    describe_model_config()

    work_dir = Path(tempfile.mkdtemp(prefix=".export-", dir=str(ASSETS_DIR)))
    try:
        fp32_path = export_fp32(work_dir)
        quantized_path = work_dir / "model-int8.onnx"

        log("quantizing fp32 -> INT8 (dynamic, QuantType.QInt8)")
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quant_started = time.monotonic()
        try:
            quantize_dynamic(
                str(fp32_path),
                str(quantized_path),
                weight_type=QuantType.QInt8,
            )
        except Exception as exc:
            raise ExportError(f"INT8 dynamic quantization failed: {exc}") from exc
        log(
            "quantized in %.1fs: %s -> %s"
            % (
                time.monotonic() - quant_started,
                human_size(fp32_path.stat().st_size),
                human_size(quantized_path.stat().st_size),
            )
        )

        # Move artifacts into place only once every step succeeded.
        quantized_path.replace(MODEL_PATH)
        export_tokenizer()
        verify_int8(MODEL_PATH, TOKENIZER_PATH)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    model_size = MODEL_PATH.stat().st_size
    tokenizer_size = TOKENIZER_PATH.stat().st_size
    log("done in %.1fs" % (time.monotonic() - started))
    log(
        f"model     : {MODEL_PATH.relative_to(REPO_ROOT)} "
        f"({human_size(model_size)}, sha256={sha256_file(MODEL_PATH)[:16]}...)"
    )
    log(
        f"tokenizer : {TOKENIZER_PATH.relative_to(REPO_ROOT)} "
        f"({human_size(tokenizer_size)}, sha256={sha256_file(TOKENIZER_PATH)[:16]}...)"
    )
    log("weights stay untracked (assets/.gitignore); commit only scripts/docs")
    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export tabularisai/multilingual-emotion-classification to INT8 ONNX.",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="rebuild assets/model-int8.onnx and assets/tokenizer.json even if they exist",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run(force=args.force)
    except ExportError as exc:
        print(f"[export] ERROR: {exc}", file=sys.stderr, flush=True)
        return 1
    except KeyboardInterrupt:
        print("[export] interrupted", file=sys.stderr, flush=True)
        return 130


if __name__ == "__main__":
    sys.exit(main())
