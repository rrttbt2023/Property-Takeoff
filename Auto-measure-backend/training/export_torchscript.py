import argparse
from pathlib import Path

import torch

from model import build_model


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--encoder-name", type=str, default="resnet50")
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--width", type=int, default=1024)
    return parser.parse_args()


def main():
    args = parse_args()
    ckpt = torch.load(args.checkpoint, map_location="cpu")
    # Use random init at construction time; checkpoint load provides trained weights.
    model = build_model(num_classes=5, encoder_name=args.encoder_name, encoder_weights=None)
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()

    example = torch.randn(1, 3, args.height, args.width)
    scripted = torch.jit.trace(model, example)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    scripted.save(str(args.out))
    print(f"Saved TorchScript model to {args.out}")


if __name__ == "__main__":
    main()
