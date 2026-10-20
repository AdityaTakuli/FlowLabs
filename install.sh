#!/bin/sh
# Install the FlowLabs desktop app on Linux or macOS, with one command:
#
#   curl -fsSL https://raw.githubusercontent.com/AdityaTakuli/FlowLabs/main/install.sh | sh
#
# It finds the latest release, downloads the file for this computer, checks it against the
# release's SHA-256 checksum, and installs it:
#   Ubuntu, Debian and other apt systems   the .deb, with apt (asks for your password)
#   other Linux                            the .tar.gz, for your user only (no password)
#   macOS                                  FlowLabs.app into /Applications (or ~/Applications)
#
# Options (environment variables):
#   FLOWLABS_VERSION=0.5.4   install that version instead of the latest
#   FLOWLABS_DRY_RUN=1       download and check, but do not install
set -eu

REPO="AdityaTakuli/FlowLabs"

say() { printf '%s\n' "$*"; }
fail() { printf 'FlowLabs installer: %s\n' "$*" >&2; exit 1; }

fetch_once() { # url file [quiet]
    if command -v curl >/dev/null 2>&1; then
        if [ -n "${3:-}" ]; then
            curl -fsSL --connect-timeout 20 -o "$2" "$1"
        else
            curl -fL --progress-bar --connect-timeout 20 -o "$2" "$1"
        fi
    elif command -v wget >/dev/null 2>&1; then
        if [ -n "${3:-}" ]; then
            wget -q --timeout=30 -O "$2" "$1"
        else
            wget -q --show-progress --timeout=30 -O "$2" "$1"
        fi
    else
        fail "needs curl or wget to download FlowLabs."
    fi
}

# Downloads are retried: GitHub's file servers sometimes drop a connection mid-way.
download() { # url file [quiet]
    attempt=1
    until fetch_once "$1" "$2" "${3:-}"; do
        rm -f "$2"
        [ "$attempt" -lt 5 ] || return 1
        say "The connection dropped. Trying again ($attempt of 4)..." >&2
        sleep $((attempt * 2))
        attempt=$((attempt + 1))
    done
}

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

# One asset's field from latest.json (name, size, sha256 and url are on their own lines, in order).
asset_field() { # manifest name field
    awk -v name="$2" -v field="$3" '
        index($0, "\"name\": \"" name "\"") { found = 1 }
        found && index($0, "\"" field "\":") {
            sub(/^[^:]*: */, ""); gsub(/[",]/, ""); print; exit
        }' "$1"
}

main() {
    system=$(uname -s)
    machine=$(uname -m)
    case "$system" in
        Linux)
            [ "$machine" = "x86_64" ] || [ "$machine" = "amd64" ] ||
                fail "there is no FlowLabs app for Linux on $machine yet. Use the browser version, or the Python package: https://github.com/$REPO#for-developers"
            if command -v apt-get >/dev/null 2>&1; then pattern="-linux-amd64.deb"; else pattern="-linux-x86_64.tar.gz"; fi
            ;;
        Darwin)
            case "$machine" in
                arm64) pattern="-macos-arm64.dmg" ;;
                x86_64) pattern="-macos-x86_64.dmg" ;;
                *) fail "unknown Mac processor: $machine" ;;
            esac
            ;;
        *) fail "this installer is for Linux and macOS. On Windows, run in PowerShell: irm https://raw.githubusercontent.com/$REPO/main/install.ps1 | iex" ;;
    esac

    if [ -n "${FLOWLABS_VERSION:-}" ]; then
        manifest_url="https://github.com/$REPO/releases/download/v${FLOWLABS_VERSION#v}/latest.json"
    else
        manifest_url="https://github.com/$REPO/releases/latest/download/latest.json"
    fi

    work=$(mktemp -d 2>/dev/null || mktemp -d -t flowlabs)
    trap 'rm -rf "$work"' EXIT INT TERM

    say "Finding the latest FlowLabs release..."
    download "$manifest_url" "$work/latest.json" quiet ||
        fail "could not read the release list from GitHub. Check your internet connection and run the command again. (If a release was published minutes ago, it is still being built.)"
    version=$(awk -F'"' '/"version":/ { print $4; exit }' "$work/latest.json")
    name="FlowLabs-$version$pattern"
    url=$(asset_field "$work/latest.json" "$name" url)
    expected=$(asset_field "$work/latest.json" "$name" sha256)
    size=$(asset_field "$work/latest.json" "$name" size)
    [ -n "$url" ] && [ -n "$expected" ] || fail "FlowLabs $version has no $name. It may still be building: try again in a few minutes."

    say "Downloading FlowLabs $version for this computer ($(( ${size:-0} / 1048576 )) MB)..."
    download "$url" "$work/$name" || fail "the download kept failing. Check your internet connection and run the command again."
    [ "$(sha256_of "$work/$name")" = "$expected" ] || fail "the download does not match the release's checksum. Nothing was installed."
    say "Download checked."

    if [ -n "${FLOWLABS_DRY_RUN:-}" ]; then
        say "FLOWLABS_DRY_RUN is set: $name is downloaded and checked, and not installed."
        return 0
    fi

    case "$name" in
        *.deb)
            say "Installing with apt (it may ask for your password)..."
            if [ "$(id -u)" -eq 0 ]; then apt-get install -y "$work/$name"; else sudo apt-get install -y "$work/$name"; fi
            say ""
            say "FlowLabs $version is installed. Open it from your applications menu, or run: flowlabs-app"
            ;;
        *.tar.gz)
            say "Installing for your user..."
            tar -xzf "$work/$name" -C "$work"
            sh "$work/FlowLabs/install.sh"
            say ""
            say "FlowLabs $version is installed. For its own window (instead of a browser tab), install your"
            say "distribution's WebKitGTK 4.1 package: webkit2gtk4.1 on Fedora, webkit2gtk-4.1 on Arch."
            case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) say "To run flowlabs-app from a terminal, add ~/.local/bin to your PATH." ;; esac
            ;;
        *.dmg)
            target="/Applications"
            [ -w "$target" ] || { target="$HOME/Applications"; mkdir -p "$target"; }
            say "Installing FlowLabs.app into $target..."
            mount="$work/mount"
            mkdir -p "$mount"
            hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mount" "$work/$name"
            rm -rf "$target/FlowLabs.app"
            ditto "$mount/FlowLabs.app" "$target/FlowLabs.app"
            hdiutil detach -quiet "$mount"
            say ""
            say "FlowLabs $version is installed in $target. Open it from Launchpad, or run: open -a FlowLabs"
            ;;
    esac
    say "Your projects are kept in ~/FlowLabs. From now on FlowLabs updates itself."
}

main "$@"
