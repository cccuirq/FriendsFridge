"""Conservative, local CLIP review of real YOLO proposals (no image-specific rules)."""
from pathlib import Path

REGION_CLASSES = ["bowl", "paper bag"]
BACKGROUND = "__background__"


def decide_review(original, ranked, categories):
    """Cosine similarities are evidence for a suggestion, not probabilities."""
    best, score = ranked[0]
    margin = score - ranked[1][1]
    if best == BACKGROUND:
        return None
    if original in REGION_CLASSES:
        return best if score >= 0.30 and margin >= 0.02 else None
    original_score = dict(ranked)[original]
    # Similar fruit/vegetable names are too ambiguous to automatically substitute.
    if (categories[best] != categories[original] and score >= 0.28
            and margin >= 0.02 and score - original_score >= 0.06):
        return best
    return None


def contains_food(container, detections):
    """Do not count a bowl of eggs/fruit again as one extra ingredient."""
    x1, y1, x2, y2 = container["box"]
    for detection in detections:
        if detection["name"] in REGION_CLASSES:
            continue
        a, b, c, d = detection["box"]
        area = max(0, c - a) * max(0, d - b)
        overlap = max(0, min(x2, c) - max(x1, a)) * max(0, min(y2, d) - max(y1, b))
        if area and overlap / area >= 0.8:
            return True
    return False


class IngredientVerifier:
    def load(self, cache, ingredients, device):
        import clip
        import torch

        weights = Path(cache) / "clip" / "ViT-B-32.pt"
        if not weights.is_file():
            raise FileNotFoundError("Local CLIP weights missing. Run setup_model.py.")
        self.device = device
        self.model, self.preprocess = clip.load(str(weights), device=device)
        self.model.eval()
        self.categories = {row["name"]: row["category"] for row in ingredients}
        prompts, self.names = [], []
        for row in ingredients:
            for prompt in [row["prompt"], *row.get("verification_prompts", [])]:
                prompts.append(f"a photo of {prompt}")
                self.names.append(row["name"])
        for prompt in ["an empty bowl", "an empty bag", "a non-food object"]:
            prompts.append(f"a photo of {prompt}")
            self.names.append(BACKGROUND)
        self.unique_names = list(dict.fromkeys(self.names))
        self.indices = [[i for i, name in enumerate(self.names) if name == unique] for unique in self.unique_names]
        with torch.inference_mode():
            features = self.model.encode_text(clip.tokenize(prompts).to(device))
            self.features = features / features.norm(dim=-1, keepdim=True)

    def review(self, image, detections):
        import torch

        candidates = [row for row in detections if row["name"] not in REGION_CLASSES or not contains_food(row, detections)]
        if not candidates:
            return []
        crops = [self.preprocess(image.crop(tuple(row["box"]))) for row in candidates]
        with torch.inference_mode():
            features = torch.cat([self.model.encode_image(batch.to(self.device)) for batch in torch.stack(crops).split(8)])
            features /= features.norm(dim=-1, keepdim=True)
            scores = features @ self.features.T
            # Aliases are collapsed before finding the runner-up distinct ingredient.
            grouped = torch.stack([scores[:, indices].max(dim=1).values for indices in self.indices], dim=1).cpu().tolist()
        reviewed = []
        for row, scores in zip(candidates, grouped):
            ranked = sorted(zip(self.unique_names, scores), key=lambda pair: pair[1], reverse=True)
            suggestion = decide_review(row["name"], ranked, self.categories)
            if suggestion:
                reviewed.append({**row, "name": suggestion, "confidence": None,
                                 "detector_name": row["name"], "detector_confidence": row["confidence"],
                                 "review_required": True, "method": "yolo-world+clip",
                                 "verification_similarity": round(ranked[0][1], 4),
                                 "verification_margin": round(ranked[0][1] - ranked[1][1], 4)})
            elif row["name"] not in REGION_CLASSES:
                reviewed.append({**row, "method": "yolo-world"})
        return reviewed
