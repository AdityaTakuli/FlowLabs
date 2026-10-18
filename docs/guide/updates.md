# Updates

The desktop app keeps itself up to date.

## How it works

When FlowLabs starts, it checks for a new release, at most every few hours. When one is out, an
**Update to x.y** button appears in the top bar. Click it to read what is new, then **Install and
restart**:

| System | What happens |
| --- | --- |
| Ubuntu, Debian | FlowLabs downloads the new `.deb` and installs it. Ubuntu asks for your password in a system dialog. Then FlowLabs starts again. |
| macOS | FlowLabs downloads the new version, replaces itself and opens again. |
| Windows | FlowLabs downloads the new installer, which updates it silently and starts it again. |

Every download comes from FlowLabs's GitHub releases over HTTPS. It is checked against the
release's SHA-256 checksum before anything is installed. Your datasets, projects and models are not
touched.

## Turn checking off, or check now

The update dialog has **Check for updates automatically**. Turn it off, and FlowLabs never checks on
its own. To check by hand, open the engine menu (the chip in the top bar) and click **Updates**.

## When FlowLabs cannot update itself

- **Linux from the `.tar.gz`**, and FlowLabs run from a folder it cannot write to: the dialog opens
  the release page. Download the new version and install it as before.
- **The Python package:** install the new release's package the same way you installed it (see
  [Engines](guide:engines#connect-the-browser-to-an-engine)).
- **The browser version** is always the latest.

Versions before 0.4.0 have no updater. Install 0.4.0 by hand once.
