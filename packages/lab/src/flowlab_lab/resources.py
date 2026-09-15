"""Environment and resource capture (PRD II 4.4, 4.5)."""

from __future__ import annotations

import os
import platform
import shutil
import sys
import threading
from pathlib import Path
from typing import Any

import psutil

MB = 1024 * 1024


def gpu_present() -> bool:
    return shutil.which("nvidia-smi") is not None or Path("/proc/driver/nvidia").exists()


def system_resources(path: Path) -> dict[str, Any]:
    memory = psutil.virtual_memory()
    disk = shutil.disk_usage(path)
    return {
        "cpu_percent": psutil.cpu_percent(interval=None),
        "cpu_count": os.cpu_count(),
        "ram_total_mb": round(memory.total / MB, 1),
        "ram_available_mb": round(memory.available / MB, 1),
        "ram_percent": memory.percent,
        "disk_free_mb": round(disk.free / MB, 1),
        "disk_total_mb": round(disk.total / MB, 1),
    }


def host_environment() -> dict[str, Any]:
    memory = psutil.virtual_memory()
    return {
        "host_python": platform.python_version(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu_count": os.cpu_count(),
        "ram_total_mb": round(memory.total / MB, 1),
        "gpu": gpu_present(),
        "agent_executable": sys.executable,
    }


def process_memory_mb(pid: int | None) -> float | None:
    if pid is None:
        return None
    try:
        process = psutil.Process(pid)
        total = process.memory_info().rss
        for child in process.children(recursive=True):
            try:
                total += child.memory_info().rss
            except psutil.Error:
                continue
        return round(float(total) / MB, 1)
    except psutil.Error:
        return None


class MemorySampler:
    """Samples a process's RSS in the background to find the peak during one execution."""

    def __init__(self, pid: int | None, interval_s: float = 0.05) -> None:
        self.pid = pid
        self.interval_s = interval_s
        self.start_mb = process_memory_mb(pid)
        self.peak_mb = self.start_mb
        self.last_mb = self.start_mb
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.wait(self.interval_s):
            reading = process_memory_mb(self.pid)
            if reading is None:
                continue
            self.last_mb = reading
            self.peak_mb = reading if self.peak_mb is None else max(self.peak_mb, reading)

    def __enter__(self) -> MemorySampler:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=1)
        final = process_memory_mb(self.pid)
        if final is not None:
            self.last_mb = final
            self.peak_mb = final if self.peak_mb is None else max(self.peak_mb, final)

    @property
    def peak_delta_mb(self) -> float | None:
        if self.start_mb is None or self.peak_mb is None:
            return None
        return round(self.peak_mb - self.start_mb, 1)
