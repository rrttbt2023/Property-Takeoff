from pathlib import Path

import cv2
import numpy as np
import torch
from torch.utils.data import Dataset

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class SegmentationDataset(Dataset):
    def __init__(
        self,
        root: Path,
        *,
        size_multiple: int = 32,
        crop_size: int | None = 1024,
        training: bool = True,
        samples_per_image: int = 1,
        focus_foreground_prob: float = 0.75,
        rare_class_boost: float = 0.8,
        normalize_imagenet: bool = True,
    ):
        self.images_dir = root / "images"
        self.masks_dir = root / "masks"
        self.size_multiple = max(1, int(size_multiple))
        self.crop_size = int(crop_size) if crop_size and int(crop_size) > 0 else None
        self.training = bool(training)
        self.samples_per_image = max(1, int(samples_per_image))
        self.focus_foreground_prob = float(np.clip(focus_foreground_prob, 0.0, 1.0))
        self.rare_class_boost = float(np.clip(rare_class_boost, 0.0, 1.0))
        self.normalize_imagenet = bool(normalize_imagenet)
        self.image_paths = sorted(self.images_dir.glob("*.png"))
        self.mask_paths = [self.masks_dir / p.name for p in self.image_paths]
        for mask_path in self.mask_paths:
            if not mask_path.exists():
                raise FileNotFoundError(f"Missing mask for image: {mask_path.name}")

    def __len__(self) -> int:
        if not self.training:
            return len(self.image_paths)
        return len(self.image_paths) * self.samples_per_image

    @staticmethod
    def _pad_to_min_size(image: np.ndarray, mask: np.ndarray, min_size: int) -> tuple[np.ndarray, np.ndarray]:
        if min_size <= 0:
            return image, mask
        h, w = image.shape[:2]
        target_h = max(h, min_size)
        target_w = max(w, min_size)
        if target_h == h and target_w == w:
            return image, mask
        pad_bottom = target_h - h
        pad_right = target_w - w
        image = cv2.copyMakeBorder(
            image,
            top=0,
            bottom=pad_bottom,
            left=0,
            right=pad_right,
            borderType=cv2.BORDER_REFLECT_101,
        )
        mask = cv2.copyMakeBorder(
            mask,
            top=0,
            bottom=pad_bottom,
            left=0,
            right=pad_right,
            borderType=cv2.BORDER_CONSTANT,
            value=0,
        )
        return image, mask

    def _crop(self, image: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        if self.crop_size is None:
            return image, mask
        crop = int(self.crop_size)
        image, mask = self._pad_to_min_size(image, mask, crop)
        h, w = image.shape[:2]
        if h == crop and w == crop:
            return image, mask

        if self.training:
            use_focus = (np.random.random() < self.focus_foreground_prob) and np.any(mask > 0)
            if use_focus:
                focus_mask = mask > 0
                # Bias random crop centers toward rarer non-background classes so
                # tiny classes (like sidewalks) are sampled more often than by area.
                if np.random.random() < self.rare_class_boost:
                    classes = np.unique(mask[focus_mask]).astype(np.int64)
                    classes = classes[classes > 0]
                    if classes.size > 0:
                        class_counts = np.array(
                            [max(1, int(np.count_nonzero(mask == c))) for c in classes],
                            dtype=np.float64,
                        )
                        class_weights = 1.0 / np.sqrt(class_counts)
                        class_weights = class_weights / max(class_weights.sum(), 1e-8)
                        chosen_class = int(np.random.choice(classes, p=class_weights))
                        focus_mask = mask == chosen_class
                ys, xs = np.where(focus_mask)
                pick = np.random.randint(0, len(ys))
                cy = int(ys[pick])
                cx = int(xs[pick])
                # Jitter to avoid repeatedly extracting identical crops.
                jitter = max(8, crop // 12)
                cy = int(np.clip(cy + np.random.randint(-jitter, jitter + 1), 0, h - 1))
                cx = int(np.clip(cx + np.random.randint(-jitter, jitter + 1), 0, w - 1))
                top = int(np.clip(cy - (crop // 2), 0, h - crop))
                left = int(np.clip(cx - (crop // 2), 0, w - crop))
            else:
                top = int(np.random.randint(0, h - crop + 1))
                left = int(np.random.randint(0, w - crop + 1))
        else:
            top = (h - crop) // 2
            left = (w - crop) // 2

        return (
            image[top : top + crop, left : left + crop],
            mask[top : top + crop, left : left + crop],
        )

    def _pad_to_multiple(self, image: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        h, w = image.shape[:2]
        m = self.size_multiple
        target_h = int(np.ceil(h / m) * m)
        target_w = int(np.ceil(w / m) * m)
        if target_h == h and target_w == w:
            return image, mask

        pad_bottom = target_h - h
        pad_right = target_w - w
        # Reflective image padding preserves local texture; mask pad is background.
        image = cv2.copyMakeBorder(
            image,
            top=0,
            bottom=pad_bottom,
            left=0,
            right=pad_right,
            borderType=cv2.BORDER_REFLECT_101,
        )
        mask = cv2.copyMakeBorder(
            mask,
            top=0,
            bottom=pad_bottom,
            left=0,
            right=pad_right,
            borderType=cv2.BORDER_CONSTANT,
            value=0,
        )
        return image, mask

    def __getitem__(self, idx: int):
        if not self.image_paths:
            raise IndexError("Dataset is empty.")

        source_idx = idx
        if self.training:
            source_idx = idx % len(self.image_paths)
        image_path = self.image_paths[source_idx]
        mask_path = self.mask_paths[source_idx]

        image = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
        mask = cv2.imread(str(mask_path), cv2.IMREAD_GRAYSCALE)
        if image is None or mask is None:
            raise ValueError(f"Failed to read training sample: {image_path.name}")
        if image.shape[:2] != mask.shape[:2]:
            raise ValueError(
                f"Image/mask size mismatch for {image_path.name}: "
                f"image={image.shape[:2]} mask={mask.shape[:2]}"
            )

        image, mask = self._crop(image, mask)
        image, mask = self._pad_to_multiple(image, mask)

        if self.training and np.random.random() < 0.5:
            image = np.ascontiguousarray(image[:, ::-1, :])
            mask = np.ascontiguousarray(mask[:, ::-1])
        if self.training and np.random.random() < 0.15:
            image = np.ascontiguousarray(image[::-1, :, :])
            mask = np.ascontiguousarray(mask[::-1, :])

        image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        if self.normalize_imagenet:
            image = (image - IMAGENET_MEAN) / IMAGENET_STD
        x = torch.from_numpy(image).permute(2, 0, 1)
        y = torch.from_numpy(mask.astype(np.int64))
        return x, y
