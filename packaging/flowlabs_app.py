"""Entry point of the packaged FlowLabs app (PyInstaller freezes this file).

``FlowLabs --worker --root DIR`` re-runs the app as its own built-in kernel, so the app works with
no Python installed; choosing another Python in the Engine menu runs the kernel there instead.
``FlowLabs --pip install ...`` runs the pip inside the app, which installs database drivers.
"""

from __future__ import annotations

import multiprocessing
import sys

from flowlabs.cli import app_main

if __name__ == "__main__":
    multiprocessing.freeze_support()  # joblib/loky start helper processes
    if len(sys.argv) > 1 and sys.argv[1] == "--pip":
        # the pip inside the app installs database drivers into ~/.flowlabs/plugins (see plugins.py)
        from pip._internal.cli.main import main as pip_main

        sys.exit(pip_main(sys.argv[2:]))
    sys.exit(app_main())
