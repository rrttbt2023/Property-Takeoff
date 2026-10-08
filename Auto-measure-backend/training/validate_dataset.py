#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

import cv2
import numpy as np


CLASS_NAMES = ["background", "plowable", "sidewalks", "turf", "mulch"]
VALID_CLASS_IDS = set(range(len(CLASS_NAMES)))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate segmentation images, masks, split isolation, and class coverage."
    )
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument(
        "--strict-class-coverage",
        action="store_true",
        help="Fail if a non-empty split is missing any foreground class.",
    )
    return parser.parse_args()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _manifest_group(sample: dict) -> str:
    direct = str(sample.get("group") or "").strip()
    if direct:
        return direct
    project_name = str(sample.get("project_name") or "").strip().lower()
    if project_name:
        normalized = re.sub(
            r"\s+(?:#|section\s+|part\s+|area\s+|zone\s+)?\d+\s*$",
            "",
            project_name,
            flags=re.IGNORECASE,
        ).strip()
        return f"project:{normalized or project_name}"
    image_name = str(sample.get("image_filename") or "").strip().lower()
    if image_name:
        return f"image:{Path(image_name).stem}"
    return ""


def main() -> None:
    args = parse_args()
    root = args.data_root
    errors: list[str] = []
    warnings: list[str] = []
    image_hash_splits: dict[str, set[str]] = {}
    class_counts_by_split: dict[str, np.ndarray] = {}
    sample_counts: dict[str, int] = {}

    for split in ("train", "val", "test"):
        images_dir = root / split / "images"
        masks_dir = root / split / "masks"
        image_paths = sorted(images_dir.glob("*.png")) if images_dir.exists() else []
        mask_paths = sorted(masks_dir.glob("*.png")) if masks_dir.exists() else []
        image_names = {path.name for path in image_paths}
        mask_names = {path.name for path in mask_paths}
        for name in sorted(image_names - mask_names):
            errors.append(f"{split}: missing mask for {name}")
        for name in sorted(mask_names - image_names):
            errors.append(f"{split}: missing image for {name}")

        class_counts = np.zeros(len(CLASS_NAMES), dtype=np.int64)
        valid_pairs = 0
        for image_path in image_paths:
            mask_path = masks_dir / image_path.name
            if not mask_path.exists():
                continue
            image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
            mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
            if image is None:
                errors.append(f"{split}: unreadable image {image_path.name}")
                continue
            if mask is None:
                errors.append(f"{split}: unreadable mask {mask_path.name}")
                continue
            if image.shape[:2] != mask.shape[:2]:
                errors.append(
                    f"{split}: size mismatch {image_path.name} "
                    f"image={image.shape[:2]} mask={mask.shape[:2]}"
                )
                continue
            if image.size == 0 or (int(image.max()) <= 4 and float(image.mean()) < 2.5):
                errors.append(f"{split}: blank image {image_path.name}")
            unique_ids = {int(value) for value in np.unique(mask)}
            invalid_ids = sorted(unique_ids - VALID_CLASS_IDS)
            if invalid_ids:
                errors.append(f"{split}: invalid mask ids {invalid_ids} in {mask_path.name}")
                continue
            class_counts += np.bincount(mask.reshape(-1), minlength=len(CLASS_NAMES))
            image_hash_splits.setdefault(_sha256(image_path), set()).add(split)
            valid_pairs += 1

        class_counts_by_split[split] = class_counts
        sample_counts[split] = valid_pairs
        if split == "train" and valid_pairs == 0:
            errors.append("train: no valid image/mask pairs")
        if valid_pairs > 0:
            missing_classes = [
                CLASS_NAMES[index]
                for index in range(1, len(CLASS_NAMES))
                if int(class_counts[index]) == 0
            ]
            if missing_classes:
                message = f"{split}: missing foreground classes {', '.join(missing_classes)}"
                if args.strict_class_coverage:
                    errors.append(message)
                else:
                    warnings.append(message)

    for digest, splits in image_hash_splits.items():
        if len(splits) > 1:
            errors.append(
                f"image leakage: hash {digest[:12]} appears in splits {', '.join(sorted(splits))}"
            )

    manifest_path = root / "manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            split_ratios = manifest.get("split_ratios") or {}
            for split in ("val", "test"):
                requested_ratio = float(split_ratios.get(split) or 0.0)
                if requested_ratio > 0 and sample_counts.get(split, 0) == 0:
                    errors.append(
                        f"{split}: split ratio is {requested_ratio:g} but no valid samples were produced; "
                        "provide exports from more distinct properties"
                    )
            groups: dict[str, set[str]] = {}
            for sample in manifest.get("samples") or []:
                group = _manifest_group(sample)
                split = str(sample.get("split") or "").strip()
                if group and split:
                    groups.setdefault(group, set()).add(split)
            for group, splits in groups.items():
                if len(splits) > 1:
                    errors.append(
                        f"property leakage: {group} appears in splits {', '.join(sorted(splits))}"
                    )
        except Exception as error:
            errors.append(f"manifest.json could not be validated: {error}")
    else:
        warnings.append("manifest.json is missing; property-level split leakage cannot be checked")

    print("Dataset validation report")
    for split in ("train", "val", "test"):
        counts = class_counts_by_split.get(split, np.zeros(len(CLASS_NAMES), dtype=np.int64))
        class_summary = ", ".join(
            f"{CLASS_NAMES[index]}={int(counts[index])}" for index in range(len(CLASS_NAMES))
        )
        print(f"- {split}: samples={sample_counts.get(split, 0)}; {class_summary}")
    for warning in warnings:
        print(f"[warning] {warning}")
    for error in errors:
        print(f"[error] {error}")
    if errors:
        raise SystemExit(f"Dataset validation failed with {len(errors)} error(s).")
    print("Dataset validation passed.")


if __name__ == "__main__":
    main()
