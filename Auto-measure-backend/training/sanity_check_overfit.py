#!/usr/bin/env python3
from __future__ import annotations

import argparse
import math
from pathlib import Path

import cv2
import numpy as np
import torch

from model import build_model

CLASS_ORDER = ["background", "plowable", "sidewalks", "turf", "mulch"]
FG_CLASSES = CLASS_ORDER[1:]
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Quick sanity check for train-set overfit. "
            "Runs backend-like inference and reports per-image coverage/IoU."
        )
    )
    parser.add_argument("--data-root", type=Path, default=Path("training/data"))
    parser.add_argument("--split", type=str, default="train", choices=["train", "val"])
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--torchscript", type=Path, default=None)
    parser.add_argument("--encoder-name", type=str, default="resnet50")
    parser.add_argument("--max-images", type=int, default=8)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--soft-min-prob", type=float, default=0.22)
    parser.add_argument("--soft-bg-margin", type=float, default=-0.04)
    parser.add_argument("--collapse-threshold", type=float, default=0.0015)
    return parser.parse_args()


def _resolve_path(base: Path, value: Path | None) -> Path | None:
    if value is None:
        return None
    return value if value.is_absolute() else (base / value)


def _load_model(
    *,
    backend_root: Path,
    checkpoint: Path | None,
    torchscript_path: Path | None,
    encoder_name: str,
):
    if torchscript_path is not None:
        model = torch.jit.load(str(torchscript_path), map_location="cpu")
        model.eval()
        return model, f"TorchScript:{torchscript_path}"
    if checkpoint is None:
        raise ValueError("Provide either --checkpoint or --torchscript.")
    ckpt = torch.load(checkpoint, map_location="cpu")
    model = build_model(num_classes=5, encoder_name=encoder_name, encoder_weights=None)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()
    return model, f"Checkpoint:{checkpoint}"


def _predict_probs(model, image_bgr: np.ndarray) -> np.ndarray:
    image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
    orig_h, orig_w = image_rgb.shape[:2]
    model_h = max(32, int(math.ceil(orig_h / 32) * 32))
    model_w = max(32, int(math.ceil(orig_w / 32) * 32))
    model_rgb = image_rgb
    if model_h != orig_h or model_w != orig_w:
        model_rgb = cv2.resize(image_rgb, (model_w, model_h), interpolation=cv2.INTER_LINEAR)

    tensor = torch.from_numpy(model_rgb).float().permute(2, 0, 1).unsqueeze(0) / 255.0
    mean = torch.from_numpy(IMAGENET_MEAN).view(1, 3, 1, 1)
    std = torch.from_numpy(IMAGENET_STD).view(1, 3, 1, 1)
    tensor = (tensor - mean) / std

    with torch.no_grad():
        logits = model(tensor)
        if isinstance(logits, (tuple, list)):
            logits = logits[0]
        probs = torch.softmax(logits, dim=1)[0].cpu().numpy()

    if model_h != orig_h or model_w != orig_w:
        probs = np.stack(
            [
                cv2.resize(
                    probs[c],
                    (orig_w, orig_h),
                    interpolation=cv2.INTER_LINEAR,
                )
                for c in range(probs.shape[0])
            ],
            axis=0,
        )
    return probs


def _coverage_from_class_map(class_map: np.ndarray) -> dict[str, float]:
    total = float(class_map.size or 1)
    return {
        "plowable": float(np.count_nonzero(class_map == 1)) / total,
        "sidewalks": float(np.count_nonzero(class_map == 2)) / total,
        "turf": float(np.count_nonzero(class_map == 3)) / total,
        "mulch": float(np.count_nonzero(class_map == 4)) / total,
    }


def _soft_decode(probs: np.ndarray, min_prob: float, bg_margin: float) -> np.ndarray:
    bg = probs[0]
    fg = probs[1:5]
    fg_best_class = np.argmax(fg, axis=0) + 1
    fg_best_prob = np.max(fg, axis=0)
    supported = (fg_best_prob >= min_prob) & ((fg_best_prob - bg) >= bg_margin)
    out = np.zeros_like(fg_best_class, dtype=np.uint8)
    out[supported] = fg_best_class[supported]
    return out


def _mean_iou(pred: np.ndarray, target: np.ndarray) -> tuple[float, dict[str, float]]:
    per_class: dict[str, float] = {}
    vals: list[float] = []
    for cls_id, cls_name in enumerate(FG_CLASSES, start=1):
        p = pred == cls_id
        t = target == cls_id
        union = float(np.count_nonzero(p | t))
        if union <= 0:
            # Ignore absent class in both prediction and target.
            continue
        inter = float(np.count_nonzero(p & t))
        iou = inter / union
        per_class[cls_name] = iou
        vals.append(iou)
    if not vals:
        return 0.0, per_class
    return float(np.mean(vals)), per_class


def _fmt_pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def main() -> None:
    args = parse_args()
    backend_root = Path(__file__).resolve().parents[1]
    checkpoint = _resolve_path(backend_root, args.checkpoint)
    torchscript_path = _resolve_path(backend_root, args.torchscript)

    model, model_label = _load_model(
        backend_root=backend_root,
        checkpoint=checkpoint,
        torchscript_path=torchscript_path,
        encoder_name=args.encoder_name,
    )
    print(f"model={model_label}")

    images_dir = _resolve_path(backend_root, args.data_root) / args.split / "images"
    masks_dir = _resolve_path(backend_root, args.data_root) / args.split / "masks"
    if not images_dir.exists():
        raise FileNotFoundError(f"Images dir not found: {images_dir}")

    paths = sorted(images_dir.glob("*.png"))
    if not paths:
        raise ValueError(f"No images found in {images_dir}")

    rng = np.random.default_rng(args.seed)
    if args.max_images > 0 and len(paths) > args.max_images:
        choose_idx = np.sort(rng.choice(len(paths), size=args.max_images, replace=False))
        paths = [paths[int(i)] for i in choose_idx]

    collapse_count = 0
    hard_mious: list[float] = []
    soft_mious: list[float] = []

    print(f"split={args.split} samples={len(paths)}")
    for p in paths:
        image = cv2.imread(str(p), cv2.IMREAD_COLOR)
        if image is None:
            print(f"[skip] {p.name}: failed to load image")
            continue
        probs = _predict_probs(model, image)
        if probs.shape[0] < 5:
            print(f"[skip] {p.name}: model output classes={probs.shape[0]} expected>=5")
            continue

        hard_map = np.argmax(probs, axis=0).astype(np.uint8)
        hard_cov = _coverage_from_class_map(hard_map)
        hard_sum = sum(hard_cov.values())

        soft_map = _soft_decode(
            probs=probs,
            min_prob=args.soft_min_prob,
            bg_margin=args.soft_bg_margin,
        )
        soft_cov = _coverage_from_class_map(soft_map)
        soft_sum = sum(soft_cov.values())

        collapsed = hard_sum < float(args.collapse_threshold)
        if collapsed:
            collapse_count += 1

        mask_path = masks_dir / p.name
        hard_miou = 0.0
        soft_miou = 0.0
        if mask_path.exists():
            mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
            if mask is not None and mask.shape == hard_map.shape:
                hard_miou, _ = _mean_iou(hard_map, mask)
                soft_miou, _ = _mean_iou(soft_map, mask)
                hard_mious.append(hard_miou)
                soft_mious.append(soft_miou)

        print(
            f"{p.name}: "
            f"hard_fg={_fmt_pct(hard_sum)} soft_fg={_fmt_pct(soft_sum)} "
            f"hard(P/S/T/M)="
            f"{_fmt_pct(hard_cov['plowable'])}/"
            f"{_fmt_pct(hard_cov['sidewalks'])}/"
            f"{_fmt_pct(hard_cov['turf'])}/"
            f"{_fmt_pct(hard_cov['mulch'])} "
            f"mIoU(hard/soft)={hard_miou:.3f}/{soft_miou:.3f}"
            + (" COLLAPSED" if collapsed else "")
        )

    n = max(1, len(paths))
    collapse_ratio = collapse_count / n
    print("\nSummary:")
    print(f"- collapse_count={collapse_count}/{len(paths)} ({collapse_ratio * 100:.1f}%)")
    if hard_mious:
        print(f"- mean_mIoU_hard={float(np.mean(hard_mious)):.3f}")
    if soft_mious:
        print(f"- mean_mIoU_soft={float(np.mean(soft_mious)):.3f}")

    if collapse_ratio >= 0.5:
        print("- verdict=FAIL (model frequently collapses to background)")
    elif hard_mious and float(np.mean(hard_mious)) < 0.15:
        print("- verdict=FAIL (train-set fit is too weak)")
    else:
        print("- verdict=PASS (no major collapse on sampled split)")


if __name__ == "__main__":
    main()

