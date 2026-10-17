# PyInstaller spec for the FlowLabs desktop app (Linux, macOS, Windows).
#
#   python scripts/build_app.py            # builds the web app, then runs this spec
#
# The bundle carries FlowLabs, the web app, and a CPU runtime for classic ML (pandas, scikit-learn).
# PyTorch is not bundled: for GPUs and deep learning, pick a Python environment with torch in the
# Engine menu and the kernel runs there.

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parent
ICON = ROOT / "packaging" / "icons" / ("flowlabs.icns" if sys.platform == "darwin" else "flowlabs.ico")

datas = [
    # the kernel copies these sources into ~/.flowlabs/kernel-src for other Python environments
    *collect_data_files("flowlabs", include_py_files=True),
    (str(ROOT / "src" / "flowlabs_runtime.py"), "."),
]

hiddenimports = [
    "uvicorn.lifespan.on",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "flowlabs_runtime",
    *collect_submodules("flowlabs"),
    *collect_submodules("sklearn"),
    *collect_submodules("scipy.special"),
    "PIL.Image",
    "openpyxl",
    "pyarrow",
]

analysis = Analysis(
    [str(ROOT / "packaging" / "flowlabs_app.py")],
    pathex=[str(ROOT / "src")],
    datas=datas,
    hiddenimports=hiddenimports,
    # deep learning runs in a Python environment the user picks; the rest are optional extras that
    # pandas or scipy would otherwise drag in from a developer machine
    excludes=[
        "torch", "torchvision", "tensorflow", "jax", "matplotlib", "IPython", "ipykernel", "jupyterlab",
        "jupyter_server", "notebook", "nbformat", "bokeh", "babel", "polars", "dask", "sympy", "plotly",
        "numba", "llvmlite", "sqlalchemy", "pytest", "mypy", "ruff", "tkinter", "PyQt5", "PyQt6", "PySide6",
    ],
    # Linux window (GTK): the page draws its own UI, so GTK's default icons and theme are enough;
    # without this PyInstaller copies every icon theme on the build machine (over 200 MB)
    hooksconfig={"gi": {"icons": ["Adwaita"], "themes": ["Adwaita"], "languages": ["en_US"]}},
    noarchive=False,
)
if sys.platform.startswith("linux"):
    # Use the computer's own GTK and WebKit for the app window. Copies from the build machine clash
    # with the system's WebKit (it loads into this process and needs the system's GLib and C++
    # runtime), and the window would fall back to the browser. Python's own libraries and the
    # libraries that come inside Python wheels stay bundled.
    import os
    import re

    SYSTEM_DIRS = ("/lib/", "/lib64/", "/usr/lib/", "/usr/lib64/", "/usr/local/lib/")
    PYTHON_NEEDS = re.compile(r"^lib(python3|ssl|crypto|ffi|z\.|bz2|lzma|expat|sqlite3|uuid|readline|tinfo|ncurses|mpdec)")

    def from_the_system(entry):
        dest, source, kind = entry
        return (kind == "BINARY" and str(source).startswith(SYSTEM_DIRS) and "/" not in dest
                and not PYTHON_NEEDS.match(os.path.basename(dest)))  # fmt: skip

    dropped = [entry[0] for entry in analysis.binaries if from_the_system(entry)]
    analysis.binaries = [entry for entry in analysis.binaries if not from_the_system(entry)]
    print(f"FlowLabs: using the system's copy of {len(dropped)} libraries: {', '.join(sorted(dropped))}")

pyz = PYZ(analysis.pure)

executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="FlowLabs" if sys.platform != "linux" else "flowlabs",
    console=False,
    disable_windowed_traceback=False,
    icon=str(ICON) if ICON.is_file() else None,
)

collection = COLLECT(executable, analysis.binaries, analysis.datas, strip=False, upx=False, name="FlowLabs")

if sys.platform == "darwin":
    app = BUNDLE(
        collection,
        name="FlowLabs.app",
        icon=str(ICON) if ICON.is_file() else None,
        bundle_identifier="io.github.adityatakuli.flowlabs",
        info_plist={
            "CFBundleName": "FlowLabs",
            "CFBundleDisplayName": "FlowLabs",
            "CFBundleShortVersionString": "0.2.0",
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "11.0",
        },
    )
