import segmentation_models_pytorch as smp


def build_model(
    num_classes: int = 5,
    encoder_name: str = "resnet50",
    encoder_weights: str | None = "imagenet",
):
    kwargs = {
        "encoder_name": encoder_name,
        "encoder_weights": encoder_weights,
        "in_channels": 3,
        "classes": num_classes,
        # Keeps training stable for small batches / tiny datasets.
        "decoder_use_batchnorm": False,
    }
    try:
        return smp.DeepLabV3Plus(**kwargs)
    except Exception as exc:
        if encoder_weights:
            print(
                f"[warn] Failed to load encoder weights '{encoder_weights}' for "
                f"{encoder_name}: {exc}. Falling back to random init."
            )
            kwargs["encoder_weights"] = None
            return smp.DeepLabV3Plus(**kwargs)
        raise
