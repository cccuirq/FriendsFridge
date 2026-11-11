"""Run real HTTP inference on a local photo; never substitutes model output."""
import argparse
import json
from pathlib import Path
import time
import httpx

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8001/recognize")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    image_type = "image/png" if args.image.suffix.lower() == ".png" else "image/jpeg"
    started = time.perf_counter()
    response = httpx.post(args.url, content=args.image.read_bytes(), headers={"Content-Type": image_type}, timeout=90)
    response.raise_for_status()
    result = response.json()
    assert result["data"]["source"] == "model"
    result["elapsed_seconds"] = round(time.perf_counter() - started, 3)
    serialized = json.dumps(result, indent=2)
    print(serialized)
    if args.output:
        args.output.write_text(serialized, encoding="utf-8")


if __name__ == "__main__":
    main()
