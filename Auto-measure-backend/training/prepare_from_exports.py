#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import random
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable

import cv2
import numpy as np


CLASS_NAMES = {
    0: "background",
    1: "plowable",
    2: "sidewalks",
    3: "turf",
    4: "mulch",
}

# Support both current 0..4 masks and historical 0/64/128/192/255 masks.
MASK_VALUE_TO_CLASS = {
    0: 0,
    1: 1,
    2: 2,
    3: 3,
    4: 4,
    64: 1,
    128: 2,
    192: 3,
    255: 4,
}


@dataclass
class ExportSample:
    source: str
    metadata: dict
    image_bytes: bytes
    mask_bytes: bytes


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build training/data/{train,val}/{images,masks} from frontend "
            "One-Click Training Export files (zip or folder)."
        )
    )
    parser.add_argument(
        "--input",
        action="append",
        required=True,
        help=(
            "Input path (repeatable): export zip, export folder, or root directory "
            "to scan recursively for export JSON files."
        ),
    )
    parser.add_argument(
        "--dataset-root",
        type=Path,
        default=Path("training/data"),
        help="Output dataset root. Default: training/data",
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
        help="Random seed for deterministic train/val split. Default: 42",
    )
    parser.add_argument(
        "--append",
        action="store_true",
        help="Append to existing dataset files instead of rebuilding from scratch.",
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
        help=(
            "Optional tile size in pixels for splitting large exports into multiple "
            "training samples. 0 disables tiling. Example: 1024"
        ),
    )
    parser.add_argument(
        "--tile-overlap",
        type=int,
        default=128,
        help="Tile overlap in pixels when --tile-size > 0. Default: 128",
    )
    parser.add_argument(
        "--tile-min-foreground-px",
        type=int,
        default=32,
        help=(
            "Skip mostly-empty tiles with foreground pixels below this threshold "
            "(class id > 0). Default: 32"
        ),
    )
    return parser.parse_args()


def _is_export_metadata(payload: dict) -> bool:
    return isinstance(payload, dict) and "image_filename" in payload and "mask_filename" in payload


def _read_json(path: Path) -> dict | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if _is_export_metadata(payload) else None


def _resolve_zip_member(
    all_names: set[str],
    json_member: str,
    filename: str,
) -> str | None:
    parent = PurePosixPath(json_member).parent
    candidates = [str(parent / filename), filename]
    for candidate in candidates:
        if candidate in all_names:
            return candidate
    # Fallback to basename match if zip creator flattened paths.
    target_base = PurePosixPath(filename).name
    for name in all_names:
        if PurePosixPath(name).name == target_base:
            return name
    return None


def iter_samples_from_zip(zip_path: Path) -> Iterable[ExportSample]:
    with zipfile.ZipFile(zip_path, "r") as zf:
        names = {n for n in zf.namelist() if not n.endswith("/")}
        json_members = sorted(n for n in names if n.lower().endswith(".json"))
        for json_member in json_members:
            try:
                payload = json.loads(zf.read(json_member).decode("utf-8"))
            except Exception:
                continue
            if not _is_export_metadata(payload):
                continue
            image_member = _resolve_zip_member(names, json_member, str(payload["image_filename"]))
            mask_member = _resolve_zip_member(names, json_member, str(payload["mask_filename"]))
            if not image_member or not mask_member:
                print(
                    f"[skip] {zip_path.name}:{json_member} missing image/mask files "
                    f"declared in metadata."
                )
                continue
            yield ExportSample(
                source=f"{zip_path}:{json_member}",
                metadata=payload,
                image_bytes=zf.read(image_member),
                mask_bytes=zf.read(mask_member),
            )


def iter_samples_from_dir(root: Path, recursive: bool) -> Iterable[ExportSample]:
    pattern = "**/*.json" if recursive else "*.json"
    for json_path in sorted(root.glob(pattern)):
        if not json_path.is_file():
            continue
        payload = _read_json(json_path)
        if payload is None:
            continue

        image_path = json_path.parent / str(payload["image_filename"])
        mask_path = json_path.parent / str(payload["mask_filename"])
        if not image_path.exists() or not mask_path.exists():
            print(
                f"[skip] {json_path} missing image/mask files declared in metadata."
            )
            continue

        yield ExportSample(
            source=str(json_path),
            metadata=payload,
            image_bytes=image_path.read_bytes(),
            mask_bytes=mask_path.read_bytes(),
        )


def gather_samples(inputs: list[str], recursive: bool) -> list[ExportSample]:
    samples: list[ExportSample] = []
    for raw in inputs:
        path = Path(raw).expanduser()
        if not path.exists():
            print(f"[skip] input does not exist: {path}")
            continue
        if path.is_file() and path.suffix.lower() == ".zip":
            samples.extend(iter_samples_from_zip(path))
            continue
        if path.is_dir():
            samples.extend(iter_samples_from_dir(path, recursive))
            continue
        if path.is_file() and path.suffix.lower() == ".json":
            payload = _read_json(path)
            if payload is None:
                print(f"[skip] unsupported JSON format: {path}")
                continue
            image_path = path.parent / str(payload["image_filename"])
            mask_path = path.parent / str(payload["mask_filename"])
            if not image_path.exists() or not mask_path.exists():
                print(f"[skip] {path} missing image/mask files declared in metadata.")
                continue
            samples.append(
                ExportSample(
                    source=str(path),
                    metadata=payload,
                    image_bytes=image_path.read_bytes(),
                    mask_bytes=mask_path.read_bytes(),
                )
            )
            continue
        print(f"[skip] unsupported input type: {path}")
    return samples


def _decode_image(image_bytes: bytes, source: str) -> np.ndarray:
    arr = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"{source}: failed to decode source image")
    return image


def _is_likely_blank_image(image: np.ndarray) -> bool:
    if image.size == 0:
        return True
    if int(image.max()) <= 4:
        return True
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    bright_ratio = float(np.count_nonzero(gray > 16)) / float(gray.size or 1)
    return bright_ratio < 0.002 and float(gray.mean()) < 2.5


def _decode_mask(mask_bytes: bytes, source: str) -> np.ndarray:
    arr = np.frombuffer(mask_bytes, dtype=np.uint8)
    mask = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if mask is None:
        raise ValueError(f"{source}: failed to decode mask image")

    if mask.ndim == 2:
        return mask.astype(np.uint8)
    if mask.ndim == 3:
        # Most exports are RGBA with equal RGB channels; channel 0 is enough.
        return mask[:, :, 0].astype(np.uint8)
    raise ValueError(f"{source}: unsupported mask shape {mask.shape}")


def _normalize_mask(mask: np.ndarray, source: str) -> np.ndarray:
    unique_vals = np.unique(mask).astype(np.int32)
    lut = np.full(256, 255, dtype=np.uint8)
    for src, dst in MASK_VALUE_TO_CLASS.items():
        lut[src] = dst

    bad_vals = [int(v) for v in unique_vals if v < 0 or v > 255 or int(lut[v]) == 255]
    if bad_vals:
        raise ValueError(
            f"{source}: mask has unexpected values {bad_vals[:12]} "
            f"(expected class ids 0..4 or legacy values 64/128/192/255)"
        )
    return lut[mask]


def _clear_dataset_pngs(dataset_root: Path) -> None:
    for split in ("train", "val"):
        for kind in ("images", "masks"):
            target = dataset_root / split / kind
            if not target.exists():
                continue
            for png in target.glob("*.png"):
                png.unlink()


def _ensure_dirs(dataset_root: Path) -> dict[str, Path]:
    out = {}
    for split in ("train", "val"):
        for kind in ("images", "masks"):
            key = f"{split}_{kind}"
            path = dataset_root / split / kind
            path.mkdir(parents=True, exist_ok=True)
            out[key] = path
    return out


def _next_numeric_id(dataset_root: Path) -> int:
    max_idx = -1
    for split in ("train", "val"):
        for kind in ("images", "masks"):
            folder = dataset_root / split / kind
            if not folder.exists():
                continue
            for path in folder.glob("*.png"):
                try:
                    max_idx = max(max_idx, int(path.stem))
                except ValueError:
                    continue
    return max_idx + 1


def _split_indices(n: int, val_ratio: float, seed: int) -> tuple[list[int], set[int]]:
    indices = list(range(n))
    random.Random(seed).shuffle(indices)
    if n <= 1 or val_ratio <= 0:
        n_val = 0
    elif val_ratio >= 1:
        n_val = max(1, n - 1)
    else:
        n_val = int(round(n * val_ratio))
        if n > 1:
            n_val = max(1, min(n - 1, n_val))
    val_set = set(indices[:n_val])
    return indices, val_set


def _tile_origins(length: int, tile_size: int, stride: int) -> list[int]:
    if length <= tile_size:
        return [0]
    max_start = max(0, length - tile_size)
    origins = list(range(0, max_start + 1, max(1, stride)))
    if origins[-1] != max_start:
        origins.append(max_start)
    return origins


def _build_tiled_variants(
    image: np.ndarray,
    mask: np.ndarray,
    *,
    tile_size: int,
    tile_overlap: int,
    tile_min_foreground_px: int,
) -> list[tuple[np.ndarray, np.ndarray, dict | None]]:
    if tile_size <= 0:
        return [(image, mask, None)]

    h, w = image.shape[:2]
    stride = tile_size - tile_overlap
    if stride <= 0:
        stride = tile_size

    ys = _tile_origins(h, tile_size, stride)
    xs = _tile_origins(w, tile_size, stride)
    variants: list[tuple[np.ndarray, np.ndarray, dict | None]] = []

    for y0 in ys:
        for x0 in xs:
            y1 = min(h, y0 + tile_size)
            x1 = min(w, x0 + tile_size)
            tile_img = image[y0:y1, x0:x1]
            tile_mask = mask[y0:y1, x0:x1]
            if tile_img.size == 0 or tile_mask.size == 0:
                continue
            if tile_img.shape[0] < 32 or tile_img.shape[1] < 32:
                continue

            fg_pixels = int(np.count_nonzero(tile_mask > 0))
            if fg_pixels < max(0, tile_min_foreground_px):
                continue

            variants.append(
                (
                    tile_img,
                    tile_mask,
                    {
                        "x": int(x0),
                        "y": int(y0),
                        "width": int(x1 - x0),
                        "height": int(y1 - y0),
                        "foreground_px": fg_pixels,
                    },
                )
            )

    # Fallback to single full sample if all tiles were filtered out.
    if not variants:
        return [(image, mask, None)]
    return variants


def main() -> None:
    args = parse_args()
    if args.val_ratio < 0 or args.val_ratio > 1:
        raise SystemExit("--val-ratio must be between 0 and 1.")
    if args.tile_size < 0:
        raise SystemExit("--tile-size must be >= 0.")
    if args.tile_overlap < 0:
        raise SystemExit("--tile-overlap must be >= 0.")
    if args.tile_min_foreground_px < 0:
        raise SystemExit("--tile-min-foreground-px must be >= 0.")

    samples = gather_samples(args.input, args.recursive)
    if not samples:
        raise SystemExit(
            "No export samples found. Point --input to your export zip/folder/json files."
        )

    dataset_root = args.dataset_root
    if not args.append:
        _clear_dataset_pngs(dataset_root)
    dirs = _ensure_dirs(dataset_root)
    next_idx = _next_numeric_id(dataset_root)

    _, val_set = _split_indices(len(samples), args.val_ratio, args.seed)
    manifest = []
    pixel_counts = np.zeros(5, dtype=np.int64)
    split_counts = {"train": 0, "val": 0}

    for src_idx, sample in enumerate(samples):
        try:
            image = _decode_image(sample.image_bytes, sample.source)
            if _is_likely_blank_image(image):
                raise ValueError(
                    f"{sample.source}: source image looks blank/black; "
                    "re-export from frontend after refreshing the map view."
                )
            mask_raw = _decode_mask(sample.mask_bytes, sample.source)
            if image.shape[:2] != mask_raw.shape[:2]:
                raise ValueError(
                    f"{sample.source}: image size {image.shape[:2]} != mask size {mask_raw.shape[:2]}"
                )
            mask = _normalize_mask(mask_raw, sample.source)
        except Exception as exc:
            print(f"[skip] {exc}")
            continue

        split = "val" if src_idx in val_set else "train"
        variants = _build_tiled_variants(
            image,
            mask,
            tile_size=int(args.tile_size),
            tile_overlap=int(args.tile_overlap),
            tile_min_foreground_px=int(args.tile_min_foreground_px),
        )

        for tile_idx, (tile_img, tile_mask, tile_meta) in enumerate(variants):
            sample_id = f"{next_idx:05d}"
            next_idx += 1

            img_out = dirs[f"{split}_images"] / f"{sample_id}.png"
            mask_out = dirs[f"{split}_masks"] / f"{sample_id}.png"
            if not cv2.imwrite(str(img_out), tile_img):
                print(f"[skip] failed to write image: {img_out}")
                continue
            if not cv2.imwrite(str(mask_out), tile_mask):
                print(f"[skip] failed to write mask: {mask_out}")
                img_out.unlink(missing_ok=True)
                continue

            split_counts[split] += 1
            pixel_counts += np.bincount(tile_mask.reshape(-1), minlength=5)
            manifest.append(
                {
                    "id": sample_id,
                    "split": split,
                    "source": sample.source,
                    "project_name": sample.metadata.get("project_name"),
                    "created_at": sample.metadata.get("created_at"),
                    "image_filename": sample.metadata.get("image_filename"),
                    "mask_filename": sample.metadata.get("mask_filename"),
                    "tile_index": int(tile_idx),
                    "tile": tile_meta,
                }
            )

    if split_counts["train"] == 0:
        raise SystemExit("No train samples were produced. Check your export files.")

    (dataset_root / "manifest.json").write_text(
        json.dumps(
            {
                "total": split_counts["train"] + split_counts["val"],
                "train": split_counts["train"],
                "val": split_counts["val"],
                "class_pixel_counts": {
                    CLASS_NAMES[i]: int(pixel_counts[i]) for i in range(5)
                },
                "samples": manifest,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    total_pixels = int(pixel_counts.sum())
    print("Dataset build complete.")
    print(
        f"- Samples: total={split_counts['train'] + split_counts['val']} "
        f"train={split_counts['train']} val={split_counts['val']}"
    )
    if args.tile_size > 0:
        print(
            f"- Tiling: tile_size={args.tile_size} overlap={args.tile_overlap} "
            f"min_fg_px={args.tile_min_foreground_px}"
        )
    if total_pixels > 0:
        for i in range(5):
            pct = 100.0 * float(pixel_counts[i]) / total_pixels
            print(f"- Pixels {CLASS_NAMES[i]}: {pixel_counts[i]} ({pct:.2f}%)")
    print(f"- Manifest: {dataset_root / 'manifest.json'}")


if __name__ == "__main__":
    main()
