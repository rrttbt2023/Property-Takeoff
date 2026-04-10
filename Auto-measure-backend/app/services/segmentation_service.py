import math
import os
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from app.schemas import Point, SegmentationClassResult, SegmentationResponse


class SegmentationService:
    """Segmentation service with optional TorchScript model and heuristic fallback."""

    _model = None
    _model_loaded = False
    _model_error: str | None = None

    @classmethod
    def segment_uploaded(
        cls,
        *,
        image_bytes: bytes,
        use_model: bool = True,
        min_area_px: int = 60,
    ) -> SegmentationResponse:
        image = cls._decode_image_bytes(image_bytes)
        if cls._is_nearly_blank_image(image):
            raise ValueError(
                "Uploaded image looks blank/black. Re-capture map image after panning or zooming."
            )
        notes: list[str] = []
        heuristic_masks, heuristic_confidences = cls._heuristic_masks(image)
        blend_mode = os.getenv("AUTO_MEASURE_SEG_BLEND_MODE", "heuristic_anchor").strip().lower()
        if blend_mode not in {"model_priority", "heuristic_anchor"}:
            blend_mode = "model_priority"
        notes.append(f"Blend mode: {blend_mode}.")

        if use_model:
            model_out = cls._predict_with_model(image)
        else:
            model_out = None

        if model_out is None:
            masks, confidences = heuristic_masks, heuristic_confidences
            notes.append("Torch model unavailable; used HSV heuristic segmentation.")
            if cls._model_error:
                notes.append(f"Model load/predict error: {cls._model_error}")
        else:
            model_masks, model_confidences, model_decode_note = model_out
            if model_decode_note:
                notes.append(model_decode_note)
            model_coverage = cls._coverage_by_class(model_masks)
            notes.append(
                "Raw model coverage "
                f"P:{model_coverage['plowable'] * 100:.1f}% "
                f"S:{model_coverage['sidewalks'] * 100:.1f}% "
                f"T:{model_coverage['turf'] * 100:.1f}% "
                f"M:{model_coverage['mulch'] * 100:.1f}%"
            )
            if cls._is_degenerate_prediction(model_masks):
                masks, confidences = heuristic_masks, heuristic_confidences
                notes.append("Torch model output looked degenerate; used heuristic segmentation.")
            else:
                masks, confidences = cls._blend_model_and_heuristics(
                    blend_mode=blend_mode,
                    model_masks=model_masks,
                    model_confidences=model_confidences,
                    heuristic_masks=heuristic_masks,
                    heuristic_confidences=heuristic_confidences,
                )
                if blend_mode == "heuristic_anchor":
                    notes.append("Used TorchScript model with heuristic-anchored refinement.")
                else:
                    notes.append("Used TorchScript model with model-priority refinement.")

        masks = cls._stabilize_masks(
            masks=masks,
            heuristic_masks=heuristic_masks,
            image_bgr=image,
            notes=notes,
        )

        polygons_by_class = {
            key: cls._mask_to_polygons(mask, min_area_px=min_area_px)
            for key, mask in masks.items()
        }
        total_polygons = sum(len(polys) for polys in polygons_by_class.values())
        if total_polygons == 0 and min_area_px > 6:
            retry_min_area_px = max(6, int(min_area_px / 3))
            polygons_by_class = {
                key: cls._mask_to_polygons(mask, min_area_px=retry_min_area_px)
                for key, mask in masks.items()
            }
            notes.append(
                f"No polygons at min_area_px={min_area_px}; retried at {retry_min_area_px}."
            )
        total_polygons = sum(len(polys) for polys in polygons_by_class.values())
        if total_polygons == 0:
            rescue_masks, rescue_confidences = cls._rescue_masks(image)
            rescue_polygons = {
                key: cls._mask_to_polygons(mask, min_area_px=1)
                for key, mask in rescue_masks.items()
            }
            rescue_total = sum(len(polys) for polys in rescue_polygons.values())
            if rescue_total > 0:
                masks = rescue_masks
                polygons_by_class = rescue_polygons
                confidences = {
                    key: float(max(confidences.get(key, 0.0), rescue_confidences.get(key, 0.0)))
                    for key in ("plowable", "sidewalks", "turf", "mulch")
                }
                notes.append("Primary segmentation returned no contours; used rescue extraction.")
        coverage = cls._coverage_by_class(masks)
        notes.append(
            "Coverage "
            f"P:{coverage['plowable'] * 100:.1f}% "
            f"S:{coverage['sidewalks'] * 100:.1f}% "
            f"T:{coverage['turf'] * 100:.1f}% "
            f"M:{coverage['mulch'] * 100:.1f}%"
        )

        return SegmentationResponse(
            plowable=SegmentationClassResult(
                polygons=polygons_by_class["plowable"],
                confidence=confidences["plowable"],
            ),
            sidewalks=SegmentationClassResult(
                polygons=polygons_by_class["sidewalks"],
                confidence=confidences["sidewalks"],
            ),
            turf=SegmentationClassResult(
                polygons=polygons_by_class["turf"],
                confidence=confidences["turf"],
            ),
            mulch=SegmentationClassResult(
                polygons=polygons_by_class["mulch"],
                confidence=confidences["mulch"],
            ),
            notes=notes,
        )

    @classmethod
    def _predict_with_model(
        cls, image_bgr: np.ndarray
    ) -> tuple[dict[str, np.ndarray], dict[str, float], str | None] | None:
        model = cls._get_model()
        if model is None:
            return None

        try:
            import torch

            image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
            orig_h, orig_w = image_rgb.shape[:2]
            model_h = max(32, int(math.ceil(orig_h / 32) * 32))
            model_w = max(32, int(math.ceil(orig_w / 32) * 32))

            if model_h != orig_h or model_w != orig_w:
                model_rgb = cv2.resize(image_rgb, (model_w, model_h), interpolation=cv2.INTER_LINEAR)
            else:
                model_rgb = image_rgb

            tensor = (
                torch.from_numpy(model_rgb).float().permute(2, 0, 1).unsqueeze(0) / 255.0
            )
            mean = torch.tensor([0.485, 0.456, 0.406], dtype=tensor.dtype).view(1, 3, 1, 1)
            std = torch.tensor([0.229, 0.224, 0.225], dtype=tensor.dtype).view(1, 3, 1, 1)
            tensor = (tensor - mean) / std
            with torch.no_grad():
                logits = model(tensor)
                if isinstance(logits, (tuple, list)):
                    logits = logits[0]
                probs = torch.softmax(logits, dim=1)[0].cpu().numpy()

            # Class order expected by this scaffold:
            # 0 background, 1 plowable, 2 sidewalks, 3 turf, 4 mulch
            if probs.shape[0] < 5:
                cls._model_error = (
                    f"Model output has {probs.shape[0]} classes, expected at least 5."
                )
                return None

            if model_h != orig_h or model_w != orig_w:
                probs_orig = np.stack(
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
            else:
                probs_orig = probs

            class_map = np.argmax(probs_orig, axis=0).astype(np.uint8)
            masks = {
                "plowable": class_map == 1,
                "sidewalks": class_map == 2,
                "turf": class_map == 3,
                "mulch": class_map == 4,
            }
            decode_note: str | None = None
            hard_cov = cls._coverage_by_class(masks)
            hard_sum = (
                hard_cov["plowable"]
                + hard_cov["sidewalks"]
                + hard_cov["turf"]
                + hard_cov["mulch"]
            )
            if hard_sum < 0.0015:
                soft_masks = cls._soft_non_background_decode(probs_orig)
                soft_cov = cls._coverage_by_class(soft_masks)
                soft_sum = (
                    soft_cov["plowable"]
                    + soft_cov["sidewalks"]
                    + soft_cov["turf"]
                    + soft_cov["mulch"]
                )
                if soft_sum > hard_sum:
                    masks = soft_masks
                    decode_note = "Applied soft non-background decode for weak logits."
            confidences = {
                "plowable": float(np.mean(probs_orig[1][masks["plowable"]])) if np.any(masks["plowable"]) else 0.0,
                "sidewalks": float(np.mean(probs_orig[2][masks["sidewalks"]])) if np.any(masks["sidewalks"]) else 0.0,
                "turf": float(np.mean(probs_orig[3][masks["turf"]])) if np.any(masks["turf"]) else 0.0,
                "mulch": float(np.mean(probs_orig[4][masks["mulch"]])) if np.any(masks["mulch"]) else 0.0,
            }
            return masks, confidences, decode_note
        except Exception as exc:  # pragma: no cover
            cls._model_error = cls._summarize_error(exc)
            return None

    @classmethod
    def _get_model(cls):
        if cls._model_loaded:
            return cls._model

        cls._model_loaded = True
        model_path = os.getenv("AUTO_MEASURE_SEG_MODEL_PATH", "").strip()
        if not model_path:
            default_path = (
                Path(__file__).resolve().parents[2]
                / "training"
                / "checkpoints"
                / "segment_model.ts"
            )
            if default_path.exists():
                model_path = str(default_path)
        if not model_path:
            cls._model = None
            return None
        path = Path(model_path)
        if not path.exists():
            cls._model_error = f"Model file not found: {path}"
            cls._model = None
            return None

        try:  # pragma: no cover
            import torch

            cls._model = torch.jit.load(str(path), map_location="cpu")
            cls._model.eval()
            return cls._model
        except Exception as exc:  # pragma: no cover
            cls._model_error = cls._summarize_error(exc)
            cls._model = None
            return None

    @staticmethod
    def _decode_image_bytes(image_bytes: bytes) -> np.ndarray:
        frame = np.frombuffer(image_bytes, dtype=np.uint8)
        image = cv2.imdecode(frame, cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Failed to decode image bytes.")
        return image

    @staticmethod
    def _is_nearly_blank_image(image_bgr: np.ndarray) -> bool:
        if image_bgr.size == 0:
            return True
        if int(image_bgr.max()) <= 4:
            return True
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        bright_ratio = float(np.count_nonzero(gray > 16)) / float(gray.size or 1)
        return bright_ratio < 0.001 and float(gray.mean()) < 2.0

    @staticmethod
    def _summarize_error(exc: Exception | str, max_len: int = 260) -> str:
        text = str(exc) if not isinstance(exc, str) else exc
        text = " ".join(text.split())
        if len(text) <= max_len:
            return text
        return f"{text[:max_len - 3]}..."

    @staticmethod
    def _heuristic_masks(
        image_bgr: np.ndarray,
    ) -> tuple[dict[str, np.ndarray], dict[str, float]]:
        hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
        lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB).astype(np.int16)

        h = hsv[:, :, 0]
        s = hsv[:, :, 1]
        v = hsv[:, :, 2]
        l = lab[:, :, 0]
        a = lab[:, :, 1].astype(np.int16)
        b = lab[:, :, 2].astype(np.int16)
        r = rgb[:, :, 0]
        g = rgb[:, :, 1]
        blue = rgb[:, :, 2]

        # ExG is a common vegetation index in RGB image segmentation.
        exg = (2 * g) - r - blue
        turf_primary = (
            (h >= 32)
            & (h <= 95)
            & (s >= 45)
            & (v >= 35)
            & (g >= (r + 8))
            & (g >= (blue + 8))
            & (exg >= 25)
        )
        turf_relaxed = (
            (h >= 28)
            & (h <= 102)
            & (s >= 32)
            & (v >= 28)
            & (g >= (r + 5))
            & (g >= (blue + 5))
            & (exg >= 18)
        )
        turf = turf_primary | turf_relaxed

        mulch_primary = (
            (h >= 5)
            & (h <= 30)
            & (s >= 62)
            & (v >= 38)
            & (v <= 220)
            & (r >= (g + 5))
            & (g >= (blue - 8))
        )
        mulch_relaxed = (
            (h >= 8)
            & (h <= 35)
            & (s >= 40)
            & (v >= 55)
            & (r >= (blue + 8))
            & (g >= (blue + 4))
        )
        mulch = mulch_primary | mulch_relaxed

        asphalt_dark = (s <= 95) & (v >= 35) & (v <= 185)
        asphalt_mid = (s <= 75) & (v > 60) & (v <= 230)
        blue_gray = (h >= 90) & (h <= 130) & (s <= 130) & (v >= 40) & (v <= 210)
        paved_surface = asphalt_dark | asphalt_mid | blue_gray

        neutral = (np.abs(a - 128) <= 8) & (np.abs(b - 128) <= 10)
        sidewalks_seed = (s <= 30) & (v >= 162) & (l >= 140) & neutral
        sidewalks_support = SegmentationService._dilate_mask(paved_surface, kernel_size=7)
        sidewalks = sidewalks_seed & sidewalks_support

        # Positive paved-surface detection for plowable instead of "everything else".
        plowable = paved_surface & ~turf & ~mulch & ~sidewalks

        turf = SegmentationService._clean_mask(turf, kernel_size=3, open_iters=1, close_iters=2)
        sidewalks = SegmentationService._clean_mask(sidewalks, kernel_size=3, open_iters=1, close_iters=1)
        mulch = SegmentationService._clean_mask(mulch, kernel_size=3, open_iters=1, close_iters=1)
        plowable = SegmentationService._clean_mask(plowable, kernel_size=5, open_iters=1, close_iters=2)
        plowable = SegmentationService._fill_small_holes(
            plowable,
            max_hole_area_px=max(120, int(plowable.size * 0.003)),
        )

        masks = SegmentationService._enforce_exclusive_masks(
            {
                "plowable": plowable,
                "sidewalks": sidewalks,
                "turf": turf,
                "mulch": mulch,
            }
        )

        confidences = {
            "plowable": 0.58,
            "sidewalks": 0.48,
            "turf": 0.56,
            "mulch": 0.44,
        }
        return masks, confidences

    @staticmethod
    def _rescue_masks(
        image_bgr: np.ndarray,
    ) -> tuple[dict[str, np.ndarray], dict[str, float]]:
        hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
        lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB).astype(np.int16)
        h = hsv[:, :, 0]
        s = hsv[:, :, 1]
        v = hsv[:, :, 2]
        l = lab[:, :, 0]
        a = lab[:, :, 1].astype(np.int16)
        b = lab[:, :, 2].astype(np.int16)
        r = rgb[:, :, 0]
        g = rgb[:, :, 1]
        blue = rgb[:, :, 2]
        exg = (2 * g) - r - blue

        turf = (
            (v >= 20)
            & ((h >= 25) & (h <= 110))
            & (g >= (r + 2))
            & (g >= (blue + 2))
            & (exg >= 8)
        )
        neutral = (np.abs(a - 128) <= 10) & (np.abs(b - 128) <= 12)
        sidewalks = (s <= 40) & (v >= 140) & (l >= 120) & neutral
        mulch = (
            (h >= 5)
            & (h <= 34)
            & (s >= 45)
            & (v >= 35)
            & (r >= (g + 3))
            & (r >= (blue + 3))
        )
        paved_seed = (s <= 95) & (v >= 32) & (v <= 235)
        paved_support = SegmentationService._dilate_mask(sidewalks | mulch, kernel_size=9)
        plowable = (paved_seed | paved_support) & ~turf & ~mulch
        if int(np.count_nonzero(plowable)) < 50:
            plowable = (s <= 85) & (v >= 38) & ~turf & ~mulch

        masks = SegmentationService._enforce_exclusive_masks(
            {
                "plowable": SegmentationService._fill_small_holes(
                    SegmentationService._clean_mask(plowable, kernel_size=3, open_iters=0, close_iters=1),
                    max_hole_area_px=max(60, int(plowable.size * 0.002)),
                ),
                "sidewalks": SegmentationService._clean_mask(
                    sidewalks,
                    kernel_size=3,
                    open_iters=0,
                    close_iters=1,
                ),
                "turf": SegmentationService._clean_mask(
                    turf,
                    kernel_size=3,
                    open_iters=0,
                    close_iters=1,
                ),
                "mulch": SegmentationService._clean_mask(
                    mulch,
                    kernel_size=3,
                    open_iters=0,
                    close_iters=1,
                ),
            }
        )
        confidences = {
            "plowable": 0.42,
            "sidewalks": 0.38,
            "turf": 0.44,
            "mulch": 0.34,
        }
        return masks, confidences

    @classmethod
    def _stabilize_masks(
        cls,
        *,
        masks: dict[str, np.ndarray],
        heuristic_masks: dict[str, np.ndarray],
        image_bgr: np.ndarray,
        notes: list[str] | None = None,
    ) -> dict[str, np.ndarray]:
        """Conservative guardrails to reduce gross false positives on small datasets."""
        out = cls._enforce_exclusive_masks(
            {
                "plowable": cls._clean_mask(masks["plowable"], kernel_size=5, open_iters=1, close_iters=2),
                "sidewalks": cls._clean_mask(masks["sidewalks"], kernel_size=3, open_iters=1, close_iters=1),
                "turf": cls._clean_mask(masks["turf"], kernel_size=3, open_iters=1, close_iters=2),
                "mulch": cls._clean_mask(masks["mulch"], kernel_size=3, open_iters=1, close_iters=1),
            }
        )
        cov = cls._coverage_by_class(out)
        heur_cov = cls._coverage_by_class(heuristic_masks)

        # Turf should be vegetation-like; suppress large turf if heuristic support is tiny.
        if cov["turf"] > 0.40 and heur_cov["turf"] < 0.12:
            if np.count_nonzero(heuristic_masks["turf"]) == 0:
                out["turf"] = np.zeros_like(out["turf"], dtype=bool)
            else:
                turf_support = cls._dilate_mask(heuristic_masks["turf"], kernel_size=15)
                out["turf"] = out["turf"] & turf_support
            if notes is not None:
                notes.append("Reduced turf using vegetation support guardrail.")

        # Sidewalks are usually a small fraction; keep only nearby heuristic support if overgrown.
        if cov["sidewalks"] > 0.20 and heur_cov["sidewalks"] < 0.06:
            if np.count_nonzero(heuristic_masks["sidewalks"]) == 0:
                out["sidewalks"] = np.zeros_like(out["sidewalks"], dtype=bool)
            else:
                sidewalks_support = cls._dilate_mask(heuristic_masks["sidewalks"], kernel_size=13)
                out["sidewalks"] = out["sidewalks"] & sidewalks_support
            if notes is not None:
                notes.append("Reduced sidewalks using support guardrail.")

        # Optional hard sidewalk cap for heuristic-heavy runs: prevent parking lots/roads
        # from being mislabeled as sidewalks.
        enable_sidewalk_cap = os.getenv("AUTO_MEASURE_ENABLE_SIDEWALK_CAP", "1").strip().lower() not in {
            "0",
            "false",
            "no",
            "off",
        }
        sidewalk_cap = float(os.getenv("AUTO_MEASURE_MAX_SIDEWALK_COVERAGE", "0.10"))
        cov = cls._coverage_by_class(out)
        if enable_sidewalk_cap and cov["sidewalks"] > sidewalk_cap:
            strict_sidewalk = cls._strict_sidewalk_mask(image_bgr)
            if np.count_nonzero(strict_sidewalk) > 0:
                out["sidewalks"] = out["sidewalks"] & cls._dilate_mask(strict_sidewalk, kernel_size=5)
            else:
                # Last resort: shrink wide sidewalk blobs.
                out["sidewalks"] = cls._clean_mask(
                    out["sidewalks"],
                    kernel_size=5,
                    open_iters=2,
                    close_iters=0,
                )
            if notes is not None:
                notes.append(
                    f"Applied sidewalk cap guardrail ({int(sidewalk_cap * 100)}% max coverage target)."
                )

        # Mulch should be sparse; suppress broad mulch hallucinations.
        if cov["mulch"] > 0.12 and heur_cov["mulch"] < 0.04:
            if np.count_nonzero(heuristic_masks["mulch"]) == 0:
                out["mulch"] = np.zeros_like(out["mulch"], dtype=bool)
            else:
                mulch_support = cls._dilate_mask(heuristic_masks["mulch"], kernel_size=11)
                out["mulch"] = out["mulch"] & mulch_support
            if notes is not None:
                notes.append("Reduced mulch using support guardrail.")

        # Prevent whole-site plowable unless heuristic paved support also indicates it.
        if cov["plowable"] > 0.92 and heur_cov["plowable"] < 0.55:
            paved_support = cls._dilate_mask(
                heuristic_masks["plowable"] | heuristic_masks["sidewalks"],
                kernel_size=21,
            )
            out["plowable"] = out["plowable"] & paved_support
            if notes is not None:
                notes.append("Trimmed plowable by paved-support guardrail.")

        building_mask = cls._detect_building_mask(image_bgr)
        if np.count_nonzero(building_mask) > 0:
            before = cls._coverage_by_class(out)
            out = {
                key: (mask & ~building_mask)
                for key, mask in out.items()
            }
            after = cls._coverage_by_class(out)
            removed = (
                (before["plowable"] - after["plowable"])
                + (before["sidewalks"] - after["sidewalks"])
                + (before["turf"] - after["turf"])
                + (before["mulch"] - after["mulch"])
            )
            if notes is not None and removed > 0.002:
                notes.append("Suppressed likely building roofs from all classes.")

        image_area = int(next(iter(out.values())).size) if out else 0
        min_area = {
            "plowable": max(80, int(image_area * 0.00018)),
            "sidewalks": max(40, int(image_area * 0.00006)),
            "turf": max(60, int(image_area * 0.00012)),
            "mulch": max(30, int(image_area * 0.00004)),
        }
        for key in ("plowable", "sidewalks", "turf", "mulch"):
            out[key] = cls._remove_small_components(out[key], min_area_px=min_area[key])

        return cls._enforce_exclusive_masks(out)

    @staticmethod
    def _clean_mask(
        mask: np.ndarray,
        *,
        kernel_size: int = 3,
        open_iters: int = 1,
        close_iters: int = 1,
    ) -> np.ndarray:
        if kernel_size < 1:
            kernel_size = 1
        if kernel_size % 2 == 0:
            kernel_size += 1
        m = (mask.astype(np.uint8) * 255)
        kernel = np.ones((kernel_size, kernel_size), np.uint8)
        if open_iters > 0:
            m = cv2.morphologyEx(m, cv2.MORPH_OPEN, kernel, iterations=open_iters)
        if close_iters > 0:
            m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, kernel, iterations=close_iters)
        return m > 0

    @staticmethod
    def _mask_to_polygons(mask: np.ndarray, min_area_px: int = 60) -> list[list[Point]]:
        out: list[list[Point]] = []
        m = (mask.astype(np.uint8) * 255)
        contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < min_area_px:
                continue
            eps = 0.005 * cv2.arcLength(contour, True)
            approx = cv2.approxPolyDP(contour, eps, True)
            points = [Point(x=float(p[0][0]), y=float(p[0][1])) for p in approx]
            if len(points) >= 3:
                out.append(points)
                continue

            # Some thin/aliased masks collapse to a line after simplification.
            # Fall back to the contour bounding box so we still return a polygon.
            x, y, w, h = cv2.boundingRect(contour)
            if w * h < min_area_px:
                continue
            out.append(
                [
                    Point(x=float(x), y=float(y)),
                    Point(x=float(x + w), y=float(y)),
                    Point(x=float(x + w), y=float(y + h)),
                    Point(x=float(x), y=float(y + h)),
                ]
            )
        return out

    @staticmethod
    def _dilate_mask(mask: np.ndarray, kernel_size: int = 5, iterations: int = 1) -> np.ndarray:
        if kernel_size < 1:
            kernel_size = 1
        if kernel_size % 2 == 0:
            kernel_size += 1
        kernel = np.ones((kernel_size, kernel_size), np.uint8)
        m = (mask.astype(np.uint8) * 255)
        m = cv2.dilate(m, kernel, iterations=max(1, iterations))
        return m > 0

    @staticmethod
    def _soft_non_background_decode(probs: np.ndarray) -> dict[str, np.ndarray]:
        # If argmax collapses to background, recover weak non-background evidence.
        if probs.shape[0] < 5:
            return {
                "plowable": np.zeros(probs.shape[1:], dtype=bool),
                "sidewalks": np.zeros(probs.shape[1:], dtype=bool),
                "turf": np.zeros(probs.shape[1:], dtype=bool),
                "mulch": np.zeros(probs.shape[1:], dtype=bool),
            }
        bg = probs[0]
        fg = probs[1:5]
        fg_best_class = np.argmax(fg, axis=0) + 1
        fg_best_prob = np.max(fg, axis=0)

        min_prob = float(os.getenv("AUTO_MEASURE_SEG_SOFT_MIN_PROB", "0.22"))
        bg_margin = float(os.getenv("AUTO_MEASURE_SEG_SOFT_BG_MARGIN", "-0.04"))
        supported = (fg_best_prob >= min_prob) & ((fg_best_prob - bg) >= bg_margin)
        return {
            "plowable": (fg_best_class == 1) & supported,
            "sidewalks": (fg_best_class == 2) & supported,
            "turf": (fg_best_class == 3) & supported,
            "mulch": (fg_best_class == 4) & supported,
        }

    @staticmethod
    def _enforce_exclusive_masks(masks: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
        sidewalks = masks["sidewalks"]
        mulch = masks["mulch"] & ~sidewalks
        turf = masks["turf"] & ~sidewalks & ~mulch
        plowable = masks["plowable"] & ~sidewalks & ~mulch & ~turf
        return {
            "plowable": plowable,
            "sidewalks": sidewalks,
            "turf": turf,
            "mulch": mulch,
        }

    @staticmethod
    def _remove_small_components(mask: np.ndarray, min_area_px: int) -> np.ndarray:
        if min_area_px <= 1:
            return mask
        src = mask.astype(np.uint8)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(src, connectivity=8)
        out = np.zeros_like(mask, dtype=bool)
        for label in range(1, num_labels):
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area >= min_area_px:
                out[labels == label] = True
        return out

    @staticmethod
    def _detect_building_mask(image_bgr: np.ndarray) -> np.ndarray:
        """Conservative roof detector used only as exclusion mask."""
        hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
        lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB).astype(np.int16)

        h = hsv[:, :, 0]
        s = hsv[:, :, 1]
        v = hsv[:, :, 2]
        l = lab[:, :, 0]
        a = lab[:, :, 1].astype(np.int16)
        b = lab[:, :, 2].astype(np.int16)
        r = rgb[:, :, 0]
        g = rgb[:, :, 1]
        blue = rgb[:, :, 2]
        exg = (2 * g) - r - blue

        neutral = (np.abs(a - 128) <= 20) & (np.abs(b - 128) <= 20)
        # Catch white/light gray roofs frequently seen in commercial imagery.
        roof_white = (s <= 28) & (v >= 175) & (l >= 170)
        roof_light = (s <= 70) & (v >= 120) & (l >= 125) & neutral
        # Keep dark-roof branch stricter so parking asphalt is less likely to be removed.
        roof_dark = (s <= 35) & (v >= 55) & (v <= 140) & (l >= 70) & (l <= 155) & neutral
        non_veg = exg <= 18

        candidate = (roof_white | roof_light | roof_dark) & non_veg
        candidate = SegmentationService._clean_mask(candidate, kernel_size=3, open_iters=1, close_iters=2)

        area = candidate.size
        min_component = max(180, int(area * 0.00020))
        max_component = max(
            min_component + 1,
            int(area * float(os.getenv("AUTO_MEASURE_SEG_BUILDING_MAX_FRAC", "0.65"))),
        )

        src = candidate.astype(np.uint8)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(src, connectivity=8)
        out = np.zeros_like(candidate, dtype=bool)
        for label in range(1, num_labels):
            comp_area = int(stats[label, cv2.CC_STAT_AREA])
            if comp_area < min_component or comp_area > max_component:
                continue
            w = int(stats[label, cv2.CC_STAT_WIDTH])
            h_px = int(stats[label, cv2.CC_STAT_HEIGHT])
            if w < 8 or h_px < 8:
                continue
            rect_area = max(1, w * h_px)
            extent = float(comp_area) / float(rect_area)
            aspect = float(max(w, h_px)) / float(max(1, min(w, h_px)))
            is_large = comp_area >= int(area * 0.08)
            min_extent = 0.20 if is_large else 0.30
            max_aspect = 4.5 if is_large else 6.5
            if extent < min_extent or aspect > max_aspect:
                continue
            out[labels == label] = True

        return SegmentationService._dilate_mask(out, kernel_size=5)

    @staticmethod
    def _strict_sidewalk_mask(image_bgr: np.ndarray) -> np.ndarray:
        """High-precision sidewalk detector used only to rein in over-segmentation."""
        hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
        lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
        h = hsv[:, :, 0]
        s = hsv[:, :, 1]
        v = hsv[:, :, 2]
        l = lab[:, :, 0]
        a = lab[:, :, 1].astype(np.int16)
        b = lab[:, :, 2].astype(np.int16)

        neutral = (np.abs(a - 128) <= 7) & (np.abs(b - 128) <= 9)
        bright_concrete = (
            (s <= 26)
            & (v >= 168)
            & (l >= 145)
            & neutral
            & ((h <= 30) | (h >= 150))
        )
        return SegmentationService._clean_mask(bright_concrete, kernel_size=3, open_iters=1, close_iters=1)

    @staticmethod
    def _fill_small_holes(mask: np.ndarray, max_hole_area_px: int) -> np.ndarray:
        if max_hole_area_px <= 0:
            return mask
        inverse = (~mask).astype(np.uint8)
        num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(inverse, connectivity=8)
        border_labels = set(np.unique(np.concatenate(
            [
                labels[0, :],
                labels[-1, :],
                labels[:, 0],
                labels[:, -1],
            ]
        )))
        filled = mask.copy()
        for label in range(1, num_labels):
            if label in border_labels:
                continue
            area = int(stats[label, cv2.CC_STAT_AREA])
            if area <= max_hole_area_px:
                filled[labels == label] = True
        return filled

    @staticmethod
    def _coverage_by_class(masks: dict[str, np.ndarray]) -> dict[str, float]:
        any_mask = next(iter(masks.values()), None)
        if any_mask is None:
            return {key: 0.0 for key in ("plowable", "sidewalks", "turf", "mulch")}
        total = float(any_mask.size) or 1.0
        return {
            key: float(np.count_nonzero(mask)) / total
            for key, mask in masks.items()
        }

    @classmethod
    def _is_degenerate_prediction(cls, masks: dict[str, np.ndarray]) -> bool:
        coverage = cls._coverage_by_class(masks)
        summed = coverage["plowable"] + coverage["sidewalks"] + coverage["turf"] + coverage["mulch"]
        dominant = max(coverage.values())
        if summed < 0.002:
            return True
        if dominant >= 0.995 and summed >= 0.95:
            return True
        return False

    @classmethod
    def _blend_model_and_heuristics(
        cls,
        *,
        blend_mode: str,
        model_masks: dict[str, np.ndarray],
        model_confidences: dict[str, float],
        heuristic_masks: dict[str, np.ndarray],
        heuristic_confidences: dict[str, float],
    ) -> tuple[dict[str, np.ndarray], dict[str, float]]:
        if blend_mode == "heuristic_anchor":
            return cls._blend_heuristic_anchor(
                model_masks=model_masks,
                model_confidences=model_confidences,
                heuristic_masks=heuristic_masks,
                heuristic_confidences=heuristic_confidences,
            )
        return cls._blend_model_priority(
            model_masks=model_masks,
            model_confidences=model_confidences,
            heuristic_masks=heuristic_masks,
            heuristic_confidences=heuristic_confidences,
        )

    @classmethod
    def _blend_model_priority(
        cls,
        *,
        model_masks: dict[str, np.ndarray],
        model_confidences: dict[str, float],
        heuristic_masks: dict[str, np.ndarray],
        heuristic_confidences: dict[str, float],
    ) -> tuple[dict[str, np.ndarray], dict[str, float]]:
        # Start from model predictions, then use heuristics only to rescue classes
        # that are entirely missing.
        plowable = cls._fill_small_holes(
            cls._clean_mask(model_masks["plowable"], kernel_size=5, open_iters=1, close_iters=2),
            max_hole_area_px=max(120, int(model_masks["plowable"].size * 0.003)),
        )
        sidewalks = cls._clean_mask(model_masks["sidewalks"], kernel_size=3, open_iters=1, close_iters=1)
        turf = cls._clean_mask(model_masks["turf"], kernel_size=3, open_iters=1, close_iters=2)
        mulch = cls._clean_mask(model_masks["mulch"], kernel_size=3, open_iters=1, close_iters=1)

        model_first = cls._enforce_exclusive_masks(
            {
                "plowable": plowable,
                "sidewalks": sidewalks,
                "turf": turf,
                "mulch": mulch,
            }
        )
        cov = cls._coverage_by_class(model_first)
        heur = cls._enforce_exclusive_masks(
            {
                "plowable": cls._clean_mask(heuristic_masks["plowable"], kernel_size=5, open_iters=1, close_iters=2),
                "sidewalks": cls._clean_mask(heuristic_masks["sidewalks"], kernel_size=3, open_iters=1, close_iters=1),
                "turf": cls._clean_mask(heuristic_masks["turf"], kernel_size=3, open_iters=1, close_iters=2),
                "mulch": cls._clean_mask(heuristic_masks["mulch"], kernel_size=3, open_iters=1, close_iters=1),
            }
        )

        # Rescue missing classes only; do not anchor everything to heuristics.
        for key in ("sidewalks", "turf", "mulch"):
            if cov[key] < 0.0008 and np.count_nonzero(heur[key]) > 0:
                model_first[key] = heur[key]
        if cov["plowable"] < 0.005 and np.count_nonzero(heur["plowable"]) > 0:
            model_first["plowable"] = heur["plowable"]

        masks = cls._enforce_exclusive_masks(model_first)
        confidences = {
            key: float(
                max(
                    min(1.0, (0.9 * model_confidences.get(key, 0.0)) + (0.1 * heuristic_confidences.get(key, 0.0))),
                    0.25 * model_confidences.get(key, 0.0),
                )
            )
            for key in ("plowable", "sidewalks", "turf", "mulch")
        }
        return masks, confidences

    @classmethod
    def _blend_heuristic_anchor(
        cls,
        *,
        model_masks: dict[str, np.ndarray],
        model_confidences: dict[str, float],
        heuristic_masks: dict[str, np.ndarray],
        heuristic_confidences: dict[str, float],
    ) -> tuple[dict[str, np.ndarray], dict[str, float]]:
        heuristic_coverage = cls._coverage_by_class(heuristic_masks)
        if (
            heuristic_coverage["plowable"]
            + heuristic_coverage["sidewalks"]
            + heuristic_coverage["turf"]
            + heuristic_coverage["mulch"]
            < 0.001
        ):
            masks = cls._enforce_exclusive_masks(
                {
                    "plowable": cls._clean_mask(model_masks["plowable"], kernel_size=3, open_iters=0, close_iters=1),
                    "sidewalks": cls._clean_mask(model_masks["sidewalks"], kernel_size=3, open_iters=0, close_iters=1),
                    "turf": cls._clean_mask(model_masks["turf"], kernel_size=3, open_iters=0, close_iters=1),
                    "mulch": cls._clean_mask(model_masks["mulch"], kernel_size=3, open_iters=0, close_iters=1),
                }
            )
            confidences = {
                key: float(
                    max(
                        model_confidences.get(key, 0.0),
                        heuristic_confidences.get(key, 0.0),
                    )
                )
                for key in ("plowable", "sidewalks", "turf", "mulch")
            }
            return masks, confidences

        turf_anchor = heuristic_masks["turf"]
        sidewalks_anchor = heuristic_masks["sidewalks"]
        mulch_anchor = heuristic_masks["mulch"]
        plowable_anchor = heuristic_masks["plowable"]

        turf_support = cls._dilate_mask(turf_anchor, kernel_size=11)
        sidewalks_support = cls._dilate_mask(sidewalks_anchor | plowable_anchor, kernel_size=9)
        mulch_support = cls._dilate_mask(mulch_anchor | turf_anchor, kernel_size=7)
        paved_support = cls._dilate_mask(plowable_anchor | sidewalks_anchor, kernel_size=11)

        turf = turf_anchor | (model_masks["turf"] & turf_support)
        sidewalks = sidewalks_anchor | (model_masks["sidewalks"] & sidewalks_support)
        mulch = mulch_anchor | (model_masks["mulch"] & mulch_support)
        plowable = plowable_anchor | (model_masks["plowable"] & paved_support)

        plowable = cls._fill_small_holes(
            cls._clean_mask(plowable, kernel_size=5, open_iters=1, close_iters=2),
            max_hole_area_px=max(120, int(plowable.size * 0.003)),
        )
        masks = cls._enforce_exclusive_masks(
            {
                "plowable": plowable,
                "sidewalks": cls._clean_mask(sidewalks, kernel_size=3, open_iters=1, close_iters=1),
                "turf": cls._clean_mask(turf, kernel_size=3, open_iters=1, close_iters=2),
                "mulch": cls._clean_mask(mulch, kernel_size=3, open_iters=1, close_iters=1),
            }
        )
        confidences = {
            key: float(
                max(
                    min(1.0, (0.7 * model_confidences.get(key, 0.0)) + (0.3 * heuristic_confidences.get(key, 0.0))),
                    heuristic_confidences.get(key, 0.0),
                )
            )
            for key in ("plowable", "sidewalks", "turf", "mulch")
        }
        return masks, confidences
