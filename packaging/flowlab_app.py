"""Entry point for the packaged FlowLab app (PyInstaller freezes this file)."""

from __future__ import annotations

import multiprocessing
import sys

from flowlab_api.desktop import main

if __name__ == "__main__":
    multiprocessing.freeze_support()  # joblib/loky start helper processes
    sys.exit(main())
