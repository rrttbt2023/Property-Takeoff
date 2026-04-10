import argparse
import json
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader

from dataset import SegmentationDataset
from model import build_model

CLASS_ORDER = ["background", "plowable", "sidewalks", "turf", "mulch"]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--encoder-name", type=str, default="resnet50")
    parser.add_argument("--encoder-weights", type=str, default="imagenet")
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--num-workers", type=int, default=0)
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
    parser.add_argument("--out", type=Path, default=Path("training/checkpoints"))
    parser.add_argument(
        "--device",
        type=str,
        default="auto",
        choices=["auto", "cpu", "mps", "cuda"],
        help="Compute device. auto prefers cuda, then mps, then cpu.",
    )
    return parser.parse_args()


def build_class_weights(data_root: Path, num_classes: int = 5) -> torch.Tensor:
    """Build inverse-frequency class weights from manifest pixels, robust to zeros."""
    counts = np.ones(num_classes, dtype=np.float64)
    manifest_path = data_root / "manifest.json"
    if manifest_path.exists():
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
            class_pixels = payload.get("class_pixel_counts") or {}
            manifest_counts = np.array(
                [float(class_pixels.get(name, 0.0)) for name in CLASS_ORDER],
                dtype=np.float64,
            )
            if manifest_counts.sum() > 0:
                counts = manifest_counts
        except Exception:
            pass

    positive = counts[counts > 0]
    fill_value = float(np.median(positive)) if positive.size else 1.0
    counts[counts <= 0] = fill_value
    freqs = counts / counts.sum()
    weights = 1.0 / np.sqrt(freqs)
    non_bg_mean = float(np.mean(weights[1:])) if num_classes > 1 else float(np.mean(weights))
    weights = weights / max(non_bg_mean, 1e-8)
    # Reduce background influence so minority classes can learn sooner.
    weights[0] = min(weights[0], 0.35)
    weights = np.clip(weights, 0.25, 4.0)
    return torch.tensor(weights, dtype=torch.float32)


def multiclass_dice_loss(
    logits: torch.Tensor,
    targets: torch.Tensor,
    *,
    num_classes: int,
    start_class: int = 1,
) -> torch.Tensor:
    probs = torch.softmax(logits, dim=1)
    one_hot = F.one_hot(
        targets.clamp(min=0, max=num_classes - 1), num_classes=num_classes
    ).permute(0, 3, 1, 2).float()

    probs = probs[:, start_class:, :, :]
    one_hot = one_hot[:, start_class:, :, :]
    if probs.numel() == 0:
        return logits.new_tensor(0.0)

    dims = (0, 2, 3)
    intersection = (probs * one_hot).sum(dims)
    denominator = probs.sum(dims) + one_hot.sum(dims)
    dice = (2.0 * intersection + 1e-6) / (denominator + 1e-6)
    return 1.0 - dice.mean()


def pad_collate(batch):
    """Pad variable-sized samples in a batch to max HxW, then stack."""
    xs, ys = zip(*batch)
    max_h = max(int(x.shape[1]) for x in xs)
    max_w = max(int(x.shape[2]) for x in xs)

    out_x = []
    out_y = []
    for x, y in zip(xs, ys):
        c, h, w = int(x.shape[0]), int(x.shape[1]), int(x.shape[2])
        px = torch.zeros((c, max_h, max_w), dtype=x.dtype)
        py = torch.zeros((max_h, max_w), dtype=y.dtype)
        px[:, :h, :w] = x
        py[:h, :w] = y
        out_x.append(px)
        out_y.append(py)
    return torch.stack(out_x, dim=0), torch.stack(out_y, dim=0)


def run_epoch(model, loader, optimizer, criterion, device, *, num_classes: int):
    model.train()
    # SMP backbones/ASPP include BatchNorm layers that can fail on tiny batches
    # (for example one training sample). Freeze BN stats for stability.
    for module in model.modules():
        if isinstance(module, nn.modules.batchnorm._BatchNorm):
            module.eval()

    total = 0.0
    for x, y in loader:
        x = x.to(device)
        y = y.to(device)
        optimizer.zero_grad(set_to_none=True)
        logits = model(x)
        ce_loss = criterion(logits, y)
        dice_loss = multiclass_dice_loss(logits, y, num_classes=num_classes, start_class=1)
        loss = (0.7 * ce_loss) + (0.3 * dice_loss)
        loss.backward()
        optimizer.step()
        total += float(loss.item())
    return total / max(len(loader), 1)


@torch.no_grad()
def validate(model, loader, criterion, device, *, num_classes: int):
    model.eval()
    total = 0.0
    confmat = np.zeros((num_classes, num_classes), dtype=np.int64)
    for x, y in loader:
        x = x.to(device)
        y = y.to(device)
        logits = model(x)
        ce_loss = criterion(logits, y)
        dice_loss = multiclass_dice_loss(logits, y, num_classes=num_classes, start_class=1)
        loss = (0.7 * ce_loss) + (0.3 * dice_loss)
        total += float(loss.item())
        preds = torch.argmax(logits, dim=1)
        flat_true = y.detach().to("cpu", dtype=torch.int64).reshape(-1)
        flat_pred = preds.detach().to("cpu", dtype=torch.int64).reshape(-1)
        valid = (flat_true >= 0) & (flat_true < num_classes)
        if bool(valid.any()):
            packed = flat_true[valid] * num_classes + flat_pred[valid]
            bins = torch.bincount(packed, minlength=num_classes * num_classes).reshape(
                num_classes, num_classes
            )
            confmat += bins.numpy().astype(np.int64)
    return total / max(len(loader), 1), confmat


def compute_segmentation_metrics(confmat: np.ndarray) -> dict:
    conf = confmat.astype(np.float64)
    tp = np.diag(conf)
    support = conf.sum(axis=1)
    predicted = conf.sum(axis=0)
    fp = predicted - tp
    fn = support - tp

    denom_iou = tp + fp + fn
    iou = np.divide(tp, denom_iou, out=np.zeros_like(tp), where=denom_iou > 0)

    denom_precision = tp + fp
    precision = np.divide(
        tp, denom_precision, out=np.zeros_like(tp), where=denom_precision > 0
    )

    denom_recall = tp + fn
    recall = np.divide(tp, denom_recall, out=np.zeros_like(tp), where=denom_recall > 0)

    denom_f1 = precision + recall
    f1 = np.divide(
        2.0 * precision * recall,
        denom_f1,
        out=np.zeros_like(tp),
        where=denom_f1 > 0,
    )

    total = float(conf.sum())
    overall_acc = float(tp.sum() / total) if total > 0 else 0.0
    mean_iou_all = float(np.mean(iou)) if iou.size else 0.0
    if iou.size > 1:
        fg_mask = denom_iou[1:] > 0
        fg_vals = iou[1:][fg_mask]
        mean_iou_fg = float(np.mean(fg_vals)) if fg_vals.size else 0.0
    else:
        mean_iou_fg = mean_iou_all

    class_metrics: dict[str, dict] = {}
    for idx, name in enumerate(CLASS_ORDER):
        class_metrics[name] = {
            "iou": float(iou[idx]),
            "f1": float(f1[idx]),
            "precision": float(precision[idx]),
            "recall": float(recall[idx]),
            "support_pixels": int(support[idx]),
            "predicted_pixels": int(predicted[idx]),
        }

    return {
        "overall_accuracy": overall_acc,
        "mean_iou_all": mean_iou_all,
        "mean_iou_fg": mean_iou_fg,
        "classes": class_metrics,
        "confusion_matrix": confmat.astype(int).tolist(),
    }


def main():
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    train_ds = SegmentationDataset(
        args.data_root / "train",
        crop_size=args.crop_size,
        training=True,
        samples_per_image=args.samples_per_image,
        focus_foreground_prob=args.focus_foreground_prob,
        rare_class_boost=args.rare_class_boost,
        normalize_imagenet=args.normalize_imagenet,
    )
    val_ds = SegmentationDataset(
        args.data_root / "val",
        crop_size=args.crop_size,
        training=False,
        samples_per_image=1,
        normalize_imagenet=args.normalize_imagenet,
    )
    train_loader = DataLoader(
        train_ds,
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=max(0, int(args.num_workers)),
        collate_fn=pad_collate,
    )
    val_loader = DataLoader(
        val_ds,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=max(0, int(args.num_workers)),
        collate_fn=pad_collate,
    )

    if args.device == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("Requested --device cuda but CUDA is not available.")
        device = torch.device("cuda")
    elif args.device == "mps":
        if not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
            raise RuntimeError("Requested --device mps but MPS is not available.")
        device = torch.device("mps")
    elif args.device == "cpu":
        device = torch.device("cpu")
    else:
        if torch.cuda.is_available():
            device = torch.device("cuda")
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = torch.device("mps")
        else:
            device = torch.device("cpu")
    print(f"device={device}")
    num_classes = len(CLASS_ORDER)
    encoder_weights = args.encoder_weights
    if isinstance(encoder_weights, str) and encoder_weights.lower() in {"none", "null", ""}:
        encoder_weights = None
    model = build_model(
        num_classes=num_classes,
        encoder_name=args.encoder_name,
        encoder_weights=encoder_weights,
    ).to(device)
    print(f"model=DeepLabV3Plus encoder={args.encoder_name} weights={encoder_weights or 'none'}")
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr)
    class_weights = build_class_weights(args.data_root, num_classes=num_classes).to(device)
    print(
        "class_weights="
        + ", ".join(
            f"{CLASS_ORDER[i]}:{class_weights[i].item():.3f}"
            for i in range(num_classes)
        )
    )
    print(
        f"dataset_samples train={len(train_ds)} val={len(val_ds)} "
        f"(crop={args.crop_size}, samples_per_image={args.samples_per_image})"
    )
    criterion = nn.CrossEntropyLoss(weight=class_weights)

    best_val = float("inf")
    best_epoch = 0
    best_metrics = None
    history: list[dict] = []
    for epoch in range(1, args.epochs + 1):
        train_loss = run_epoch(
            model,
            train_loader,
            optimizer,
            criterion,
            device,
            num_classes=num_classes,
        )
        val_loss, confmat = validate(
            model,
            val_loader,
            criterion,
            device,
            num_classes=num_classes,
        )
        metrics = compute_segmentation_metrics(confmat)
        history_item = {
            "epoch": int(epoch),
            "train_loss": float(train_loss),
            "val_loss": float(val_loss),
            "overall_accuracy": float(metrics["overall_accuracy"]),
            "mean_iou_all": float(metrics["mean_iou_all"]),
            "mean_iou_fg": float(metrics["mean_iou_fg"]),
            "classes": metrics["classes"],
        }
        history.append(history_item)

        class_summary = ", ".join(
            f"{name[:1].upper()}:IoU {metrics['classes'][name]['iou']:.3f}/F1 {metrics['classes'][name]['f1']:.3f}"
            for name in CLASS_ORDER[1:]
        )
        print(
            f"epoch={epoch} train_loss={train_loss:.4f} val_loss={val_loss:.4f} "
            f"mIoU_fg={metrics['mean_iou_fg']:.4f} mIoU_all={metrics['mean_iou_all']:.4f}"
        )
        print(f"  {class_summary}")

        ckpt = {
            "model_state_dict": model.state_dict(),
            "epoch": epoch,
            "val_loss": val_loss,
            "metrics": metrics,
        }
        torch.save(ckpt, args.out / "last.pt")
        if val_loss < best_val:
            best_val = val_loss
            best_epoch = epoch
            best_metrics = metrics
            torch.save(ckpt, args.out / "best.pt")

    metrics_path = args.out / "metrics.json"
    metrics_payload = {
        "class_order": CLASS_ORDER,
        "best_epoch": int(best_epoch),
        "best_val_loss": float(best_val),
        "best_metrics": best_metrics,
        "history": history,
    }
    metrics_path.write_text(json.dumps(metrics_payload, indent=2) + "\n", encoding="utf-8")
    if best_metrics:
        print(
            "best_metrics "
            f"epoch={best_epoch} "
            f"mIoU_fg={best_metrics['mean_iou_fg']:.4f} "
            f"mIoU_all={best_metrics['mean_iou_all']:.4f}"
        )
    print(f"metrics_json={metrics_path}")


if __name__ == "__main__":
    main()
