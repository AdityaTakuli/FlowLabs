# PyInstaller spec for the FlowLab desktop app (Linux, macOS, Windows).
#
#   python scripts/build_app.py            # bundles the canvas, then runs this spec
#   pyinstaller packaging/flowlab.spec     # if the canvas is already bundled
#
# The bundle carries FlowLab's own runtime (server, analysers, canvas). It never runs the user's
# code: kernels start from a Python environment the user picks (flowlab_lab.interpreters).

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).resolve().parent
ICON = ROOT / "packaging" / "icons" / ("flowlab.icns" if sys.platform == "darwin" else "flowlab.ico")

datas = [
    *collect_data_files("flowlab_api", includes=["web/**", "examples/**"]),
    *collect_data_files("flowlab_agent", includes=["snippets/**/*.toml"]),
    *collect_data_files("flowlab_nodes"),
    *collect_data_files("tree_sitter_language_pack"),
]

hiddenimports = [
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "ipykernel",
    "ipykernel_launcher",
    *collect_submodules("flowlab_api"),
    *collect_submodules("flowlab_lab"),
    *collect_submodules("flowlab_agent"),
    *collect_submodules("flowlab_engine"),
    *collect_submodules("flowlab_nodes"),
    *collect_submodules("flowspec"),
    *collect_submodules("encodings.idna"),
]

analysis = Analysis(
    [str(ROOT / "packaging" / "flowlab_app.py")],
    pathex=[str(ROOT / p) for p in (
        "packages/flowspec/src", "packages/nodes/src", "packages/engine/src",
        "packages/agent/src", "packages/lab/src", "apps/api/src",
    )],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    excludes=["torch", "torchvision", "tensorflow", "matplotlib.tests", "pytest", "mypy", "ruff"],
    noarchive=False,
)
pyz = PYZ(analysis.pure)

executable = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="FlowLab" if sys.platform != "linux" else "flowlab",
    console=sys.platform == "win32" and False,  # windowed app; logs go to the console it is started from
    disable_windowed_traceback=False,
    icon=str(ICON) if ICON.is_file() else None,
)

collection = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="FlowLab",
)

if sys.platform == "darwin":
    app = BUNDLE(
        collection,
        name="FlowLab.app",
        icon=str(ICON) if ICON.is_file() else None,
        bundle_identifier="dev.flowlab.app",
        info_plist={
            "CFBundleName": "FlowLab",
            "CFBundleDisplayName": "FlowLab",
            "CFBundleShortVersionString": "0.1.0",
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "11.0",
        },
    )
