"""Prepare official YOLO-World weights with the shared offline ingredient vocabulary."""
import argparse
import urllib.request

from app import CACHE, CLASSES, DEVICE, Detector


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", choices=["s", "m", "l"], default="l")
    args = parser.parse_args()
    import truststore
    truststore.inject_into_ssl()
    source = CACHE / f"yolov8{args.size}-worldv2.pt"
    if not source.is_file():
        url = f"https://github.com/ultralytics/assets/releases/download/v8.3.0/{source.name}"
        print(f"Downloading official {source.name}...", flush=True)
        temporary = source.with_suffix(".download")
        urllib.request.urlretrieve(url, temporary)
        temporary.replace(source)

    import clip
    import torch
    from ultralytics import YOLOWorld
    torch.set_num_threads(min(8, torch.get_num_threads()))
    original_load = clip.load

    def local_load(name, *args, **kwargs):
        kwargs.setdefault("download_root", str(CACHE / "clip"))
        return original_load(name, *args, **kwargs)

    clip.load = local_load
    print(f"Encoding {len(CLASSES)} ingredient prompts...", flush=True)
    model = YOLOWorld(str(source))
    model.set_classes(CLASSES)
    # Keep embedded text features; normal startup does not need the CLIP encoder.
    model.model.clip_model = None
    prepared = CACHE / f"ingredients-worldv2-{args.size}.pt"
    temporary = prepared.with_name(f"preparing-{prepared.name}")
    model.save(str(temporary))
    verified = Detector()
    verified.load(temporary)
    temporary.replace(prepared)
    print(f"Verified {len(CLASSES)} classes on {DEVICE}. Prepared weights: {prepared}")


if __name__ == "__main__":
    main()
