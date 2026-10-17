"""Image classification with PyTorch: a CNN you design, or a pretrained network you adapt.

Datasets are folders of class folders. Images are resized to a square, optionally augmented while
training (mirror, flip, rotate, colour jitter, random crop), normalized, and fed to the network.
Augmentation never touches validation or test images.
"""

from __future__ import annotations

import base64
import io
import math
import random
import time
from pathlib import Path
from typing import Any

import numpy as np

from . import catalogue as cat
from . import datasets, evaluation
from . import project as projects
from .util import Cancelled, UserError, new_id, now, round_floats
from .workspace import Workspace

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)
CACHE_LIMIT_BYTES = 700_000_000
HEADS = {"resnet18": "fc", "resnet50": "fc", "mobilenet_v3_small": "classifier", "efficientnet_b0": "classifier"}


def channels(prep: dict[str, Any], pretrained: bool) -> int:
    return 3 if pretrained or not prep.get("grayscale") else 1


def load_image(path: Path | bytes, size: int, grayscale: bool) -> Any:
    from PIL import Image

    source = io.BytesIO(path) if isinstance(path, bytes) else path
    with Image.open(source) as opened:
        return opened.convert("L" if grayscale else "RGB").resize((size, size), Image.Resampling.BILINEAR)


def augment(image: Any, prep: dict[str, Any], rng: random.Random) -> Any:
    from PIL import Image, ImageEnhance

    size = image.size[0]
    crop = float(prep.get("crop_scale", 1.0))
    if crop < 1.0:
        area = rng.uniform(crop, 1.0)
        ratio = math.exp(rng.uniform(math.log(3 / 4), math.log(4 / 3)))
        w = min(size, int(round(size * math.sqrt(area * ratio))))
        h = min(size, int(round(size * math.sqrt(area / ratio))))
        x, y = rng.randint(0, size - w), rng.randint(0, size - h)
        image = image.crop((x, y, x + w, y + h)).resize((size, size), Image.Resampling.BILINEAR)
    if prep.get("hflip") and rng.random() < 0.5:
        image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if prep.get("vflip") and rng.random() < 0.5:
        image = image.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    rotation = int(prep.get("rotation", 0))
    if rotation:
        image = image.rotate(rng.uniform(-rotation, rotation), resample=Image.Resampling.BILINEAR)
    jitter = float(prep.get("color_jitter", 0.0))
    if jitter > 0:
        for enhancer in (ImageEnhance.Brightness, ImageEnhance.Contrast):
            image = enhancer(image).enhance(rng.uniform(1 - jitter, 1 + jitter))
        if image.mode == "RGB":
            image = ImageEnhance.Color(image).enhance(rng.uniform(1 - jitter, 1 + jitter))
    return image


def to_array(image: Any, prep: dict[str, Any], n_channels: int) -> np.ndarray:
    array = np.asarray(image, dtype=np.float32) / 255.0
    if array.ndim == 2:
        array = array[:, :, None]
    if array.shape[2] != n_channels:
        array = np.repeat(array[:, :, :1], n_channels, axis=2) if n_channels == 3 else array.mean(axis=2, keepdims=True)
    if prep.get("normalize", "imagenet") == "imagenet":
        if n_channels == 3:
            array = (array - np.asarray(IMAGENET_MEAN, np.float32)) / np.asarray(IMAGENET_STD, np.float32)
        else:
            array = (array - 0.449) / 0.226
    return np.ascontiguousarray(array.transpose(2, 0, 1))


def build_network(spec: dict[str, Any], n_channels: int, size: int, n_classes: int) -> Any:
    """A torch module from a model entry (``cnn`` layers or a ``pretrained`` architecture)."""
    import torch
    from torch import nn

    params = spec.get("params") or {}
    if spec["algo"] == "pretrained":
        try:
            from torchvision import models
        except ImportError as error:
            raise UserError("pretrained networks need torchvision in this engine") from error
        arch = params.get("arch", "resnet18")
        if arch not in HEADS:
            raise UserError(f"unknown network {arch}")
        try:
            net = getattr(models, arch)(weights="DEFAULT" if params.get("pretrained", True) else None)
        except Exception as error:  # noqa: BLE001 - usually no internet for the first download
            raise UserError(
                f"could not download the {arch} weights ({error}). Connect to the internet once, or turn off "
                "“Use ImageNet weights”."
            ) from error
        if params.get("freeze", True):
            for parameter in net.parameters():
                parameter.requires_grad = False
        if HEADS[arch] == "fc":
            net.fc = nn.Linear(net.fc.in_features, n_classes)
        else:
            last = net.classifier[-1]
            net.classifier[-1] = nn.Linear(last.in_features, n_classes)
        return net
    acts = {"relu": nn.ReLU, "leaky_relu": nn.LeakyReLU, "gelu": nn.GELU, "tanh": nn.Tanh, "sigmoid": nn.Sigmoid,
            "elu": nn.ELU}  # fmt: skip
    modules: list[Any] = []
    width, flat = n_channels, False

    def shape() -> tuple[int, ...]:
        with torch.no_grad():
            out = nn.Sequential(*modules)(torch.zeros(1, n_channels, size, size)) if modules else torch.zeros(
                1, n_channels, size, size)  # fmt: skip
        return tuple(out.shape)

    for layer in params.get("layers") or cat.IMAGE_LAYERS["default"]:
        kind = layer.get("type")
        activation = acts.get(layer.get("activation", "relu"))
        if kind == "conv" and not flat:
            filters, kernel = int(layer.get("filters", 32)), int(layer.get("kernel", 3))
            modules.append(nn.Conv2d(width, filters, kernel, stride=int(layer.get("stride", 1)), padding=kernel // 2))
            if activation:
                modules.append(activation())
            width = filters
        elif kind in ("maxpool", "avgpool") and not flat:
            pool = int(layer.get("size", 2))
            if shape()[-1] // pool < 1:
                raise UserError(
                    f"the image is too small for this many pooling layers; raise the image size above {size}"
                )
            modules.append((nn.MaxPool2d if kind == "maxpool" else nn.AvgPool2d)(pool))
        elif kind == "batchnorm":
            modules.append(nn.BatchNorm1d(width) if flat else nn.BatchNorm2d(width))
        elif kind == "dropout":
            modules.append(nn.Dropout(float(layer.get("rate", 0.25))))
        elif kind == "dense":
            if not flat:
                modules.append(nn.Flatten())
                width, flat = int(np.prod(shape()[1:])), True
            units = int(layer.get("units", 128))
            modules.append(nn.Linear(width, units))
            if activation:
                modules.append(activation())
            width = units
    if not flat:
        modules += [nn.AdaptiveAvgPool2d(1), nn.Flatten()]
    modules.append(nn.Linear(width, n_classes))
    return nn.Sequential(*modules)


def download(url: str, target: Path, report: Any = None, timeout: float = 60.0, attempts: int = 8) -> None:
    """Download ``url`` to ``target``, resuming after drops; checks the hash torchvision puts in names.

    A slow or flaky connection resumes where it stopped instead of starting over (HTTP Range).
    """
    import hashlib
    import os
    import re
    import urllib.error
    import urllib.request

    partial = target.with_name(target.name + ".flowlabs-partial")
    expected = re.search(r"-([0-9a-f]{8,})\.", target.name)
    last_error: Exception | None = None
    for attempt in range(attempts):
        have = partial.stat().st_size if partial.is_file() else 0
        request = urllib.request.Request(url, headers={"Range": f"bytes={have}-"} if have else {})
        try:
            try:
                response = urllib.request.urlopen(request, timeout=timeout)  # noqa: S310 - a known model URL
            except urllib.error.HTTPError as error:
                if error.code != 416:  # 416: nothing left to fetch, the partial file is complete
                    raise
            else:
                with response:
                    resumed = response.status == 206
                    length = int(response.headers.get("Content-Length") or 0)
                    total = have + length if resumed else length
                    done = have if resumed else 0
                    with partial.open("ab" if resumed else "wb") as handle:
                        while chunk := response.read(1 << 16):  # small reads keep progress on a drop
                            handle.write(chunk)
                            done += len(chunk)
                            if report:
                                report(done, total)
                    if total and done < total:
                        raise ConnectionError(f"the connection dropped at {done} of {total} bytes")
            if expected:
                digest = hashlib.sha256(partial.read_bytes()).hexdigest()
                if not digest.startswith(expected.group(1)):
                    partial.unlink(missing_ok=True)
                    raise ValueError("the downloaded file is damaged")
            os.replace(partial, target)
            return
        except Cancelled:
            raise
        except Exception as error:  # noqa: BLE001 - retried, then reported
            last_error = error
            if attempt < attempts - 1:
                time.sleep(min(10.0, 0.5 * 2**attempt))
    raise UserError(f"the download failed ({last_error})")


def ensure_weights(arch: str, report: Any = None, timeout: float = 60.0) -> None:
    """Download pretrained weights once, with progress (torch's own download can stall silently)."""
    import torch
    from torchvision import models

    try:
        url = models.get_model_weights(arch).DEFAULT.url
    except (AttributeError, ValueError, KeyError):
        return
    folder = Path(torch.hub.get_dir()) / "checkpoints"
    target = folder / Path(url).name
    if target.is_file():
        return
    folder.mkdir(parents=True, exist_ok=True)
    try:
        download(url, target, report, timeout)
    except UserError as error:
        raise UserError(
            f"could not download the {arch} weights: {error}. Check the internet connection, or turn off "
            "“Use ImageNet weights”."
        ) from error


class _Images:
    """Images for one split, resized once (kept in memory when they fit)."""

    def __init__(self, files: list[Path], labels: list[int], prep: dict[str, Any], n_channels: int, train: bool,
                 seed: int) -> None:  # fmt: skip
        self.files, self.labels, self.prep, self.n_channels, self.train = files, labels, prep, n_channels, train
        self.size = int(prep.get("size", 64))
        self.grayscale = n_channels == 1
        self.rng = random.Random(seed)
        bytes_needed = len(files) * self.size * self.size * (1 if self.grayscale else 3)
        self.cache = (
            [load_image(f, self.size, self.grayscale) for f in files] if bytes_needed < CACHE_LIMIT_BYTES else None
        )

    def __len__(self) -> int:
        return len(self.files)

    def item(self, index: int) -> np.ndarray:
        image = (
            self.cache[index] if self.cache is not None else load_image(self.files[index], self.size, self.grayscale)
        )
        if self.train:
            image = augment(image, self.prep, self.rng)
        return to_array(image, self.prep, self.n_channels)

    def batches(self, batch_size: int, shuffle: bool) -> Any:
        order = list(range(len(self)))
        if shuffle:
            self.rng.shuffle(order)
        for start in range(0, len(order), batch_size):
            index = order[start : start + batch_size]
            yield np.stack([self.item(i) for i in index]), np.asarray([self.labels[i] for i in index], dtype=np.int64)


def _stratified(labels: list[int], share: float, seed: int) -> tuple[list[int], list[int]]:
    rng = random.Random(seed)
    keep, held = [], []
    by_class: dict[int, list[int]] = {}
    for index, label in enumerate(labels):
        by_class.setdefault(label, []).append(index)
    for members in by_class.values():
        rng.shuffle(members)
        n = max(1, int(round(len(members) * share))) if len(members) > 1 else 0
        held += members[:n]
        keep += members[n:]
    return keep, held


def thumb(array_path: Path, size: int = 64) -> str:
    return datasets.thumbnail(array_path, size)


def run(ws: Workspace, project: dict[str, Any], job: Any, packages: dict[str, Any]) -> dict[str, Any]:
    try:
        import torch
        import torch.nn.functional as F
    except ImportError as error:
        raise UserError("image models need PyTorch in this engine") from error
    from .training import Job

    assert isinstance(job, Job)
    started, clock = now(), time.monotonic()
    run_id = new_id("r")
    run_dir = ws.runs / project["id"] / run_id
    (run_dir / "models").mkdir(parents=True, exist_ok=True)
    prep = {**cat.defaults(cat.IMAGE_PREP), **(project.get("image") or {})}
    root = datasets.image_root(ws, project["dataset_id"])
    groups = datasets.image_classes(root)
    classes = list(groups)
    files = [f for c in classes for f in groups[c]]
    labels = [i for i, c in enumerate(classes) for _ in groups[c]]
    split = project.get("split") or {}
    seed = int(split.get("seed", 42))
    train_index, test_index = _stratified(labels, float(split.get("test_size", 0.2)), seed)
    fit_index, val_index = _stratified([labels[i] for i in train_index], 0.15, seed + 1)
    fit_index = [train_index[i] for i in fit_index]
    val_index = [train_index[i] for i in val_index]
    models = [m for m in project["models"] if m.get("enabled", True)]
    job.emit("started", run_id=run_id, models=[{"id": m["id"], "label": m.get("label") or m["algo"]} for m in models])
    results: list[dict[str, Any]] = []
    for position, entry in enumerate(models):
        job.check()
        params = {**cat.defaults(next(m for m in cat.IMAGE_ALGOS if m["id"] == entry["algo"])["params"]),
                  **(entry.get("params") or {})}  # fmt: skip
        label = entry.get("label") or entry["algo"]
        record: dict[str, Any] = {"id": entry["id"], "algo": entry["algo"], "label": label, "family": "Deep learning",
                                  "status": "running", "params": params}  # fmt: skip
        job.emit("model", model_id=entry["id"], status="running", index=position, total=len(models), label=label)
        try:
            pretrained = entry["algo"] == "pretrained"
            n_channels = channels(prep, pretrained)
            size = int(prep["size"])
            job.emit("stage", stage="load", message=f"Loading {len(files)} images at {size}×{size}")
            sets = {
                "fit": _Images([files[i] for i in fit_index], [labels[i] for i in fit_index], prep, n_channels, True, seed),
                "val": _Images([files[i] for i in val_index], [labels[i] for i in val_index], prep, n_channels, False, seed),
                "test": _Images([files[i] for i in test_index], [labels[i] for i in test_index], prep, n_channels, False, seed),
            }  # fmt: skip
            torch.manual_seed(seed)
            from flowlabs_runtime import pick_device

            if pretrained and params.get("pretrained", True):

                def downloaded(done: int, total: int, _id: str = entry["id"]) -> None:
                    job.check()
                    size = f" of {total / 1e6:.0f} MB" if total else ""
                    job.emit("stage", stage="download", message=f"Downloading {params.get('arch')} weights (once): "
                             f"{done / 1e6:.0f}{size}")  # fmt: skip
                    if total:
                        job.emit("progress", model_id=_id, fraction=round(0.1 * done / total, 4))

                ensure_weights(str(params.get("arch", "resnet18")), downloaded)
            device = torch.device(pick_device(params.get("device", "auto")))
            net = build_network({"algo": entry["algo"], "params": params}, n_channels, size, len(classes)).to(device)
            trainable = [p for p in net.parameters() if p.requires_grad]
            lr, decay = float(params.get("learning_rate", 0.001)), float(params.get("weight_decay", 0.0))
            optimizer = {"sgd": lambda: torch.optim.SGD(trainable, lr=lr, momentum=0.9, weight_decay=decay),
                         "adamw": lambda: torch.optim.AdamW(trainable, lr=lr, weight_decay=decay)}.get(
                str(params.get("optimizer", "adam")), lambda: torch.optim.Adam(trainable, lr=lr, weight_decay=decay))()  # fmt: skip
            epochs, batch = int(params.get("epochs", 15)), int(params.get("batch_size", 32))
            patience = int(params.get("patience", 5))
            history: list[dict[str, float]] = []
            best, best_state, waited = math.inf, None, 0
            fit_clock = time.monotonic()
            steps_per_epoch = max(1, math.ceil(len(sets["fit"]) / batch))
            for epoch in range(1, epochs + 1):
                net.train()
                total, count = 0.0, 0
                for step, (xb, yb) in enumerate(sets["fit"].batches(batch, shuffle=True), 1):
                    job.check()
                    x, y = torch.as_tensor(xb, device=device), torch.as_tensor(yb, device=device)
                    if len(y) < 2 and any(
                        isinstance(m, torch.nn.BatchNorm1d | torch.nn.BatchNorm2d) for m in net.modules()
                    ):
                        continue
                    optimizer.zero_grad()
                    loss = F.cross_entropy(net(x), y)
                    loss.backward()
                    optimizer.step()
                    total += float(loss.detach()) * len(y)
                    count += len(y)
                    if step % max(1, steps_per_epoch // 10) == 0:
                        job.emit("progress", model_id=entry["id"], epoch=epoch, epochs=epochs,
                                 fraction=round(((epoch - 1) + step / steps_per_epoch) / epochs, 4))  # fmt: skip
                values = {"loss": total / max(1, count)}
                if len(sets["val"]):
                    probs, truth = _predict(net, sets["val"], batch, device)
                    values["val_loss"] = float(F.nll_loss(torch.log(torch.as_tensor(probs).clamp_min(1e-12)),
                                                          torch.as_tensor(truth)))  # fmt: skip
                    values["val_accuracy"] = float((probs.argmax(axis=1) == truth).mean())
                history.append({"epoch": float(epoch), **values})
                job.emit("epoch", model_id=entry["id"], epoch=epoch, epochs=epochs, metrics=round_floats(values))
                monitor = values.get("val_loss", values["loss"])
                if not math.isfinite(monitor):
                    raise UserError("training diverged (loss is not a number): lower the learning rate")
                if monitor < best - 1e-6:
                    best, waited = monitor, 0
                    best_state = {k: t.detach().cpu().clone() for k, t in net.state_dict().items()}
                else:
                    waited += 1
                    if patience and len(sets["val"]) and waited >= patience:
                        job.log(f"{label}: stopped early after epoch {epoch}")
                        break
            if best_state is not None:
                net.load_state_dict(best_state)
            record["fit_seconds"] = round(time.monotonic() - fit_clock, 2)
            record["history"] = round_floats(history)
            record["device"] = str(device)
            record["backend"] = "torch"
            record["parameters"] = int(sum(p.numel() for p in net.parameters()))
            predict_clock = time.monotonic()
            probs, truth = _predict(net, sets["test"], batch, device)
            record["predict_ms_per_row"] = round(1000 * (time.monotonic() - predict_clock) / max(1, len(truth)), 3)
            pred = probs.argmax(axis=1)
            record["metrics"] = round_floats(evaluation.classification_metrics(truth, pred, probs, len(classes)))
            record["details"] = evaluation.classification_details(truth, pred, probs, classes)
            wrong = [i for i in range(len(truth)) if pred[i] != truth[i]][:12]
            record["details"]["mistakes"] = [
                {"image": thumb(sets["test"].files[i]), "true": classes[int(truth[i])], "predicted": classes[int(pred[i])],
                 "confidence": round(float(probs[i, pred[i]]), 3)} for i in wrong
            ]  # fmt: skip
            artifact = run_dir / "models" / f"{entry['id']}.pt"
            torch.save({"format": "flowlabs-image-1", "model": {"algo": entry["algo"], "params": params},
                        "state_dict": {k: v.cpu() for k, v in net.state_dict().items()}, "classes": classes,
                        "image": prep, "channels": n_channels, "size": size, "label": label,
                        "metrics": record["metrics"]}, artifact)  # fmt: skip
            record["artifact"] = ws.relative(artifact)
            record["size_kb"] = round(artifact.stat().st_size / 1024, 1)
            record["status"] = "done"
        except Cancelled:
            record["status"] = "cancelled"
            results.append(record)
            raise
        except UserError as error:
            record.update(status="failed", error=str(error))
        except Exception as error:  # noqa: BLE001 - one failing model must not stop the others
            message = str(error)
            if "out of memory" in message.lower():
                message = "The GPU ran out of memory. Lower the batch size or image size."
            record.update(status="failed", error=message[:500])
        results.append(record)
        job.emit("model", model_id=entry["id"], status=record["status"], index=position, total=len(models),
                 label=label, metrics=record.get("metrics"), error=record.get("error"))  # fmt: skip
    done = [r for r in results if r["status"] == "done"]
    metric = projects.primary_metric(project)
    best_record = max(done, key=lambda r: evaluation.score(metric, r["metrics"]), default=None)
    warnings_found = []
    if best_record:
        accuracy = best_record["metrics"].get("accuracy", 0)
        if accuracy < 1.5 / len(classes):
            warnings_found.append(
                "Accuracy is close to guessing. Train longer, use a pretrained network, or add images."
            )
        history = best_record.get("history") or []
        if (
            history
            and history[-1].get("val_accuracy") is not None
            and history[-1]["val_accuracy"] < 0.7 * max(h.get("val_accuracy", 0) for h in history)
        ):
            warnings_found.append("Validation accuracy fell late in training; the best epoch was kept.")
    result = {
        "id": run_id, "project_id": project["id"], "status": "completed" if done else "failed", "started": started,
        "finished": now(), "seconds": round(time.monotonic() - clock, 2), "task": "classification", "target": "label",
        "metric": metric, "metric_label": evaluation.METRIC_LABELS.get(metric, metric), "classes": classes,
        "best_model_id": best_record["id"] if best_record else None, "kind": "image",
        "data": {"rows": len(files), "labelled": len(files), "train_rows": len(fit_index), "val_rows": len(val_index),
                 "test_rows": len(test_index), "image_size": int(prep["size"]), "classes": len(classes)},
        "models": results, "warnings": warnings_found, "project": project,
    }  # fmt: skip
    ws.write_json(run_dir / "results.json", result)
    stored = projects.get(ws, project["id"])
    stored["last_run"] = run_id
    projects.save(ws, stored)
    job.emit("done", run_id=run_id, best_model_id=result["best_model_id"])
    return result


def _predict(net: Any, images: _Images, batch: int, device: Any) -> tuple[np.ndarray, np.ndarray]:
    import torch

    net.eval()
    probs, truth = [], []
    with torch.no_grad():
        for xb, yb in images.batches(batch, shuffle=False):
            out = net(torch.as_tensor(xb, device=device))
            probs.append(torch.softmax(out, dim=1).cpu().numpy())
            truth.append(yb)
    if not probs:
        return np.zeros((0, 1)), np.zeros(0, dtype=np.int64)
    return np.concatenate(probs), np.concatenate(truth)


def load_checkpoint(path: Path) -> tuple[Any, dict[str, Any]]:
    import torch

    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    spec = dict(checkpoint["model"])
    if spec["algo"] == "pretrained":  # weights come from the checkpoint; no download needed
        spec["params"] = {**spec["params"], "pretrained": False}
    net = build_network(spec, checkpoint["channels"], checkpoint["size"], len(checkpoint["classes"]))
    net.load_state_dict(checkpoint["state_dict"])
    return net.eval(), checkpoint


def predict_image(path: Path, image: bytes) -> dict[str, Any]:
    import torch

    net, checkpoint = load_checkpoint(path)
    loaded = load_image(image, checkpoint["size"], checkpoint["channels"] == 1)
    array = to_array(loaded, checkpoint["image"], checkpoint["channels"])
    with torch.no_grad():
        probs = torch.softmax(net(torch.as_tensor(array[None])), dim=1)[0].numpy()
    order = np.argsort(-probs)
    buffer = io.BytesIO()
    loaded.convert("RGB").resize((128, 128)).save(buffer, format="PNG")
    return {
        "prediction": checkpoint["classes"][int(order[0])],
        "probabilities": [
            {"label": checkpoint["classes"][int(i)], "value": round(float(probs[i]), 4)} for i in order[:10]
        ],
        "image": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii"),
    }
