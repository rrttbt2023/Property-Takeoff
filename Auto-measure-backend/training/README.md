# Backend CV Model Scaffold

This folder contains a starter training pipeline for parcel segmentation:

- Classes: `background=0`, `plowable=1`, `sidewalks=2`, `turf=3`, `mulch=4`
- Input: RGB tiles/chips
- Label: indexed PNG mask with class ids above

## 1) Install training deps

```bash
cd Auto-measure-backend
python3 -m venv .venv-train
source .venv-train/bin/activate
pip install -r training/requirements-train.txt
```

## 2) Prepare dataset

Expected structure:

```text
training/data/
  train/
    images/
      *.png
    masks/
      *.png
  val/
    images/
      *.png
    masks/
      *.png
  test/
    images/
      *.png
    masks/
      *.png
```

- Every image file must have a matching mask filename.
- Masks should be single-channel indexed PNG with values in `[0..4]`.

### Fast path: build dataset directly from frontend exports

If you used frontend **One-Click Training Export**, use this command:

```bash
python training/prepare_from_exports.py \
  --input ~/Downloads \
  --dataset-root training/data \
  --val-ratio 0.2 \
  --test-ratio 0.1 \
  --seed 42
```

Notes:

- `--input` can point to a zip file, an extracted export folder, a single export `.json`, or a root folder (scanned recursively).
- By default this **rebuilds** `training/data` from discovered exports.
- Add `--append` if you want to keep existing `training/data` samples and add new ones.
- Append mode preserves the prior manifest, skips content-identical exports, and refuses
  datasets where one property already crosses multiple splits.
- Splits are grouped by project, so tiles or repeat exports from one property cannot leak into validation/test.
- Exact duplicate image/mask exports are skipped.
- The script writes `training/data/manifest.json` with split info and class-pixel counts.
- For very large sites, tile exports during prepare:
  - `--tile-size 1024 --tile-overlap 128 --tile-min-foreground-px 48`
  - `--tile-size 0` disables tiling (default).

Validate an existing prepared dataset at any time:

```bash
python training/validate_dataset.py --data-root training/data
```

If validation reports image or property leakage, rebuild without `--append` before
training. The validator intentionally stops the one-command pipeline in that case.

## 3) Train

```bash
python training/train.py \
  --data-root training/data \
  --epochs 40 \
  --batch-size 4 \
  --num-workers 0 \
  --lr 1e-4 \
  --out training/checkpoints
```

Training now prints per-epoch foreground IoU and writes:

- `training/checkpoints/metrics.json` (overall + per-class IoU/F1/precision/recall)
- Held-out test metrics in `training/checkpoints/metrics.json` when the test split is present
- `metrics` payloads in `best.pt` and `last.pt`

## 4) Export TorchScript

```bash
python training/export_torchscript.py \
  --checkpoint training/checkpoints/best.pt \
  --out training/checkpoints/segment_model.ts
```

## One-command pipeline (prepare + train + export)

```bash
python training/run_training_pipeline.py \
  --input ~/Downloads \
  --dataset-root training/data \
  --val-ratio 0.2 \
  --test-ratio 0.1 \
  --seed 42 \
  --tile-size 1024 \
  --tile-overlap 128 \
  --tile-min-foreground-px 48 \
  --epochs 40 \
  --batch-size 4 \
  --num-workers 0 \
  --lr 1e-4 \
  --out training/checkpoints
```

## 5) Serve from backend

Set env var before running FastAPI:

```bash
export AUTO_MEASURE_SEG_MODEL_PATH=/absolute/path/to/segment_model.ts
```

Large images are automatically processed as overlapping model tiles. The defaults
match the training crop size and preserve narrow sidewalks and bed edges:

```bash
export AUTO_MEASURE_SEG_TILE_SIZE=1024
export AUTO_MEASURE_SEG_TILE_OVERLAP=192
export AUTO_MEASURE_SEG_UNCERTAINTY_THRESHOLD=0.32
```

Use endpoint:

- `POST /api/measurements/segment/upload` with form fields:
  - `image` (file)
  - `use_model` (bool, default true)
  - `min_area_px` (int, default 60)

Model visibility and operator corrections:

- `GET /api/measurements/segment/status` reports the active engine and model fingerprint.
- `POST /api/measurements/segment/corrections` stores an image, indexed mask, and metadata.
- Set `AUTO_MEASURE_TRAINING_FEEDBACK_DIR` to a persistent volume in production.
- Point `training/run_training_pipeline.py --input` at that correction directory to include reviewed samples.

When no model is configured, backend falls back to a heuristic segmenter.

## 6) Overfit sanity check (recommended)

Before trusting new checkpoints, verify the model can predict non-background on
the training split and achieve non-trivial train-set IoU:

```bash
python training/sanity_check_overfit.py \
  --data-root training/data \
  --split train \
  --checkpoint training/checkpoints/best.pt \
  --max-images 8
```

Or test the exported TorchScript (same format backend uses):

```bash
python training/sanity_check_overfit.py \
  --data-root training/data \
  --split train \
  --torchscript training/checkpoints/segment_model.ts \
  --max-images 8
```
