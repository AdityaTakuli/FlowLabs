"""Entry point of the packaged FlowLabs app (PyInstaller freezes this file).

``FlowLabs --worker --root DIR`` re-runs the app as its own built-in kernel, so the app works with
no Python installed; choosing another Python in the Engine menu runs the kernel there instead.
"""

from __future__ import annotations

import multiprocessing
import sys

from flowlabs.cli import app_main

if __name__ == "__main__":
    multiprocessing.freeze_support()  # joblib/loky start helper processes
    sys.exit(app_main())
