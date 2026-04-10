#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "One-command pipeline: import frontend exports -> train model -> "
            "export TorchScript."
        )
    )
    parser.add_argument(
        "--input",
        action="append",
        required=True,
        help="Input path (repeatable): export zip, export folder, or root directory.",
    )
    parser.add_argument(
        "--dataset-root",
        type=Path,
        default=Path("training/data"),
        help="Dataset root for train/val images/masks. Default: training/data",
    )
    parser.add_argument(
        "--val-ratio",
        type=float,
        default=0.2,
        help="Validation split ratio in [0,1]. Default: 0.2",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for deterministic split. Default: 42",
    )
    parser.add_argument(
        "--append",
        action="store_true",
        help="Append to existing dataset instead of rebuilding it.",
    )
    parser.add_argument(
        "--recursive",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Recursively scan directory inputs for export JSON files. Default: true",
    )
    parser.add_argument(
        "--tile-size",
        type=int,
        default=0,
        help="Optional tiling size (px) for dataset preparation. 0 disables tiling.",
    )
    parser.add_argument(
        "--tile-overlap",
        type=int,
        default=128,
        help="Tile overlap in px for dataset preparation when tiling is enabled.",
    )
    parser.add_argument(
        "--tile-min-foreground-px",
        type=int,
        default=32,
        help="Minimum non-background pixels required per tile.",
    )
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--encoder-name", type=str, default="resnet50")
    parser.add_argument("--encoder-weights", type=str, default="imagenet")
    parser.add_argument("--crop-size", type=int, default=1024)
    parser.add_argument("--samples-per-image", type=int, default=6)
    parser.add_argument("--focus-foreground-prob", type=float, default=0.75)
    parser.add_argument("--rare-class-boost", type=float, default=0.8)
    parser.add_argument(
        "--normalize-imagenet",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    parser.add_argument("--lr", type=float, default=1e-4)
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("training/checkpoints"),
        help="Checkpoint output directory. Default: training/checkpoints",
    )
    parser.add_argument(
        "--height",
        type=int,
        default=1024,
        help="TorchScript export sample height (must be /32 friendly).",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=1024,
        help="TorchScript export sample width (must be /32 friendly).",
    )
    return parser.parse_args()


def _run(cmd: list[str], cwd: Path) -> None:
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=str(cwd), check=True)


def _resolve_path(base: Path, value: Path) -> Path:
    return value if value.is_absolute() else (base / value)


def main() -> None:
    args = parse_args()
    backend_root = Path(__file__).resolve().parents[1]
    training_dir = backend_root / "training"
    py = sys.executable

    prepare_cmd = [
        py,
        str(training_dir / "prepare_from_exports.py"),
    ]
    for item in args.input:
        prepare_cmd += ["--input", item]
    prepare_cmd += [
        "--dataset-root",
        str(args.dataset_root),
        "--val-ratio",
        str(args.val_ratio),
        "--seed",
        str(args.seed),
        "--tile-size",
        str(args.tile_size),
        "--tile-overlap",
        str(args.tile_overlap),
        "--tile-min-foreground-px",
        str(args.tile_min_foreground_px),
    ]
    if args.append:
        prepare_cmd.append("--append")
    if args.recursive:
        prepare_cmd.append("--recursive")
    else:
        prepare_cmd.append("--no-recursive")
    _run(prepare_cmd, cwd=backend_root)

    train_cmd = [
        py,
        str(training_dir / "train.py"),
        "--data-root",
        str(args.dataset_root),
        "--encoder-name",
        str(args.encoder_name),
        "--encoder-weights",
        str(args.encoder_weights),
        "--epochs",
        str(args.epochs),
        "--batch-size",
        str(args.batch_size),
        "--num-workers",
        str(args.num_workers),
        "--crop-size",
        str(args.crop_size),
        "--samples-per-image",
        str(args.samples_per_image),
        "--focus-foreground-prob",
        str(args.focus_foreground_prob),
        "--rare-class-boost",
        str(args.rare_class_boost),
        "--lr",
        str(args.lr),
        "--out",
        str(args.out),
    ]
    if not args.normalize_imagenet:
        train_cmd.append("--no-normalize-imagenet")
    _run(train_cmd, cwd=backend_root)

    checkpoint = _resolve_path(backend_root, args.out) / "best.pt"
    ts_out = _resolve_path(backend_root, args.out) / "segment_model.ts"
    export_cmd = [
        py,
        str(training_dir / "export_torchscript.py"),
        "--checkpoint",
        str(checkpoint),
        "--out",
        str(ts_out),
        "--encoder-name",
        str(args.encoder_name),
        "--height",
        str(args.height),
        "--width",
        str(args.width),
    ]
    _run(export_cmd, cwd=backend_root)

    env_path = ts_out.resolve()
    print("\nPipeline complete.")
    print(f"Set model path before starting backend:\nexport AUTO_MEASURE_SEG_MODEL_PATH={env_path}")
    print(
        "Then restart API server, e.g.:\n"
        "python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000"
    )
    print("If uvicorn is missing in this env: pip install -r requirements.txt")


if __name__ == "__main__":
    # Keep subprocesses unbuffered-ish for better terminal progress visibility.
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    main()
