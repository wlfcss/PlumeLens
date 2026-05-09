"""Write Finder DMG window layout without talking to Finder.

The release build creates the DMG with hdiutil/ditto so large Electron
frameworks and code signatures survive intact. This helper only writes
.DS_Store metadata: window bounds, icon view settings, background image alias,
and icon positions.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from ds_store import DSStore
from mac_alias import Alias


def _window_bounds(width: int, height: int) -> str:
    left = 200
    top = 120
    # dmgbuild/electron-builder WindowBounds uses {{x, y}, {width, height}}.
    # The second tuple is not a bottom-right coordinate.
    return f"{{{{{left}, {top}}}, {{{width}, {height}}}}}"


def write_layout(args: argparse.Namespace) -> None:
    mount = Path(args.mount).resolve()
    background = mount / args.background
    ds_store = mount / ".DS_Store"

    if not background.exists():
        raise FileNotFoundError(f"background image missing: {background}")

    if ds_store.exists():
        ds_store.unlink()

    background_alias = Alias.for_file(str(background)).to_bytes()
    bwsp = {
        "ShowStatusBar": False,
        "WindowBounds": _window_bounds(args.window_width, args.window_height),
        "ContainerShowSidebar": False,
        "PreviewPaneVisibility": False,
        "SidebarWidth": 0,
        "ShowTabView": False,
        "ShowToolbar": False,
        "ShowPathbar": False,
        "ShowSidebar": False,
    }
    icvp = {
        "viewOptionsVersion": 1,
        "backgroundType": 2,
        "backgroundColorRed": 1.0,
        "backgroundColorGreen": 1.0,
        "backgroundColorBlue": 1.0,
        "backgroundImageAlias": background_alias,
        "gridOffsetX": 0.0,
        "gridOffsetY": 0.0,
        "gridSpacing": 100.0,
        "arrangeBy": "none",
        "showIconPreview": False,
        "showItemInfo": False,
        "labelOnBottom": True,
        "textSize": float(args.text_size),
        "iconSize": float(args.icon_size),
        "scrollPositionX": 0.0,
        "scrollPositionY": 0.0,
    }

    with DSStore.open(str(ds_store), "w+") as store:
        store["."]["vSrn"] = ("long", 1)
        store["."]["bwsp"] = bwsp
        store["."]["icvp"] = icvp
        store["."]["icvl"] = (b"type", b"icnv")
        store[args.app_name]["Iloc"] = (args.app_x, args.app_y)
        store["Applications"]["Iloc"] = (args.applications_x, args.applications_y)


def verify_layout(args: argparse.Namespace) -> None:
    mount = Path(args.mount).resolve()
    ds_store = mount / ".DS_Store"
    if not ds_store.exists():
        raise FileNotFoundError(f".DS_Store missing: {ds_store}")

    with DSStore.open(str(ds_store), "r") as store:
        icvp = store["."]["icvp"]
        bwsp = store["."]["bwsp"]
        app_pos = store[args.app_name]["Iloc"]
        applications_pos = store["Applications"]["Iloc"]

    if icvp.get("backgroundType") != 2 or not icvp.get("backgroundImageAlias"):
        raise ValueError("DMG background image alias is not configured")
    if int(icvp.get("iconSize", 0)) != args.icon_size:
        raise ValueError(f"unexpected icon size: {icvp.get('iconSize')}")
    if bwsp.get("WindowBounds") != _window_bounds(args.window_width, args.window_height):
        raise ValueError(f"unexpected window bounds: {bwsp.get('WindowBounds')}")
    if app_pos != (args.app_x, args.app_y):
        raise ValueError(f"unexpected app icon position: {app_pos}")
    if applications_pos != (args.applications_x, args.applications_y):
        raise ValueError(f"unexpected Applications icon position: {applications_pos}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("mount")
    parser.add_argument("--background", required=True)
    parser.add_argument("--app-name", default="PlumeLens.app")
    parser.add_argument("--app-x", type=int, required=True)
    parser.add_argument("--app-y", type=int, required=True)
    parser.add_argument("--applications-x", type=int, required=True)
    parser.add_argument("--applications-y", type=int, required=True)
    parser.add_argument("--window-width", type=int, required=True)
    parser.add_argument("--window-height", type=int, required=True)
    parser.add_argument("--icon-size", type=int, default=128)
    parser.add_argument("--text-size", type=int, default=13)
    parser.add_argument("--verify-only", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.verify_only:
        verify_layout(args)
    else:
        write_layout(args)
        verify_layout(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
