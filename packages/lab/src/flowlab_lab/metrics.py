"""Training metrics from a running cell: parsed from its output, or logged explicitly.

Training loops print progress in a handful of shapes, and FlowLab charts them live without any
change to the user's code:

* ``epoch 3 loss=0.412 acc=0.87``, ``step 120 | loss: 0.3 | lr: 1e-3``
* Keras: ``Epoch 3/10`` followed by ``... - loss: 0.41 - accuracy: 0.87 - val_loss: 0.45``
* Hugging Face style dicts: ``{'loss': 0.41, 'learning_rate': 5e-05, 'epoch': 1.0}``

Explicit logging (``flowlab_log(step=3, loss=0.41)`` inside the kernel) sends a display message with
``METRIC_MIME`` and never depends on parsing. tqdm bars (carriage-return updates) report progress.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

METRIC_MIME = "application/vnd.flowlab.metric+json"
MAX_POINTS = 5000

STEP_KEYS = ("epoch", "step", "iter", "iteration", "batch", "round", "trial", "fold", "global_step")
METRIC_WORDS = (
    "loss", "acc", "accuracy", "f1", "auc", "roc_auc", "rmse", "mse", "mae", "r2", "precision", "recall",
    "lr", "learning_rate", "perplexity", "ppl", "bleu", "iou", "dice", "top1", "top5", "score", "error",
    "logloss", "mape", "grad_norm", "kl", "reward",
)  # fmt: skip
_NUMBER = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
PAIR = re.compile(rf"(?<![\w.])([A-Za-z][\w./@-]{{0,40}}?)\s*(?:=|:|\s)\s*'?({_NUMBER})(?![\w.])")
QUOTED_PAIR = re.compile(rf"['\"]([A-Za-z][\w./@ -]{{0,40}})['\"]\s*:\s*({_NUMBER})")
OF_TOTAL = re.compile(
    r"\b(epoch|step|iter|iteration|batch|round|fold)\s*\[?\s*(\d+)\s*(?:/|of)\s*(\d+)", re.I
)
BRACKET_TOTAL = re.compile(r"^\s*\[\s*(\d+)\s*/\s*(\d+)\s*\]")
PERCENT = re.compile(r"(\d{1,3})%\|")
TQDM_COUNT = re.compile(r"\|\s*(\d+)/(\d+)\s*\[")


@dataclass
class MetricPoint:
    step: float
    values: dict[str, float]
    source: str = "output"  # "output" (parsed) or "log" (flowlab_log)

    def as_dict(self) -> dict[str, Any]:
        return {"step": self.step, "values": self.values, "source": self.source}


def _is_metric(name: str) -> bool:
    lowered = name.lower().strip("_-./ ")
    tail = re.split(r"[/.@ ]", lowered)[-1]
    return any(
        tail == word
        or tail.startswith(f"{word}_")
        or tail.endswith(f"_{word}")
        or (tail.startswith(("val_", "train_", "test_", "eval_")) and word in tail)
        for word in METRIC_WORDS
    )


def _number(text: str) -> float | None:
    try:
        value = float(text)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


@dataclass
class MetricParser:
    """Feed it a cell's output as it streams; it returns the metric points found so far."""

    points: list[MetricPoint] = field(default_factory=list)
    progress: float | None = None  # 0..1 from the latest tqdm-style bar
    _buffer: str = ""
    _epoch: float | None = None
    _auto_step: int = 0

    def feed(self, text: str) -> tuple[list[MetricPoint], float | None]:
        """Returns (new points, new progress or None)."""
        found: list[MetricPoint] = []
        progress: float | None = None
        self._buffer += text
        *complete, self._buffer = re.split(r"[\r\n]", self._buffer)
        segments = complete + ([self._buffer] if "%|" in self._buffer else [])
        for segment in segments:
            bar = self._progress(segment)
            if bar is not None:
                progress = self.progress = bar
            point = self.parse_line(segment)
            if point is not None:
                found.append(point)
        if "%|" in self._buffer:  # a bar already reported: keep only what follows it
            end = self._buffer.rfind("]", self._buffer.find("%|"))
            if end != -1:
                self._buffer = self._buffer[end + 1 :]
        for point in found:
            if len(self.points) < MAX_POINTS:
                self.points.append(point)
        return found, progress

    def flush(self) -> list[MetricPoint]:
        tail, self._buffer = self._buffer, ""
        point = self.parse_line(tail)
        if point is not None and len(self.points) < MAX_POINTS:
            self.points.append(point)
            return [point]
        return []

    def log(self, values: dict[str, Any]) -> MetricPoint | None:
        numbers = {
            str(k): v for k, v in values.items() if isinstance(v, int | float) and not isinstance(v, bool)
        }
        clean = {k: float(v) for k, v in numbers.items() if math.isfinite(float(v))}
        step = next((clean.pop(k) for k in STEP_KEYS if k in clean), None)
        if not clean:
            return None
        self._auto_step += 1
        point = MetricPoint(step if step is not None else float(self._auto_step), clean, "log")
        if len(self.points) < MAX_POINTS:
            self.points.append(point)
        return point

    @staticmethod
    def _progress(segment: str) -> float | None:
        match = TQDM_COUNT.search(segment)
        if match and int(match.group(2)) > 0:
            return min(1.0, int(match.group(1)) / int(match.group(2)))
        match = PERCENT.search(segment)
        return min(1.0, int(match.group(1)) / 100) if match else None

    def parse_line(self, line: str) -> MetricPoint | None:
        if not line.strip() or "%|" in line:  # tqdm bars carry rates, not metrics
            return None
        of_total = OF_TOTAL.search(line)
        bracket = BRACKET_TOTAL.search(line)
        pairs = QUOTED_PAIR.findall(line) or PAIR.findall(line)
        values: dict[str, float] = {}
        step: float | None = None
        for raw_name, raw_value in pairs:
            name = raw_name.strip()
            number = _number(raw_value)
            if number is None:
                continue
            if name.lower() in STEP_KEYS:
                if name.lower() == "epoch":
                    self._epoch = number
                step = number if step is None else step
            elif _is_metric(name):
                values[name] = number
        if of_total is not None:
            step = float(of_total.group(2))
            if of_total.group(1).lower() == "epoch":
                self._epoch = step
        if bracket is not None and step is None:
            step = float(bracket.group(1))
        if not values:
            return None
        if step is None:
            step = self._epoch if self._epoch is not None else float(self._auto_step + 1)
        self._auto_step = int(step) if step >= self._auto_step else self._auto_step + 1
        return MetricPoint(step, values)
