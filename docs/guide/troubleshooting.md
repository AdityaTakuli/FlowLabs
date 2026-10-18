# Troubleshooting

## The engine did not start

The screen shows the reason. Usually the Python chosen in the engine menu is missing a package, or
no longer exists.

- Click **Use the built-in engine**. FlowLabs starts its own Python, which always works.
- Then open the engine menu to install what that Python lacks, or choose another.

## The app opens in my browser, not in its own window (Linux)

The window needs the system's WebKitGTK. The `.deb` installs it. With the `.tar.gz`, install it
yourself:

```bash
sudo apt install libwebkit2gtk-4.1-0 gir1.2-webkit2-4.1
```

If the window cannot start, FlowLabs opens your browser instead, so you can keep working.

## macOS says FlowLabs is from an unidentified developer

The app is not code-signed yet. Right-click FlowLabs in Applications, choose **Open**, then **Open**
again. You only need to do this once.

## Windows SmartScreen blocks the installer

Click **More info**, then **Run anyway**.

## The first start is slow

The first start after installing loads about 670 MB of files from disk. That can take 20 seconds or
more. Later starts take a few seconds.

## Training failed

- **A code step failed.** The message names the line. Fix it in the step, and use **Preview** to try
  it.
- **A model needs a package.** XGBoost, LightGBM and neural networks on the GPU need packages the
  built-in Python may not have. See [Python environments](guide:engines#python-environments).
- **Too few rows.** Very small tables, or a large test share, can leave a class with no training
  rows. Lower the test share, or turn off stratify.
- **Out of memory.** Use a sample (Clean → **Use a sample**), drop wide text columns, or train
  fewer models at once.

## My GPU is not used

The built-in Python trains on the CPU. Choose a Python that has PyTorch with CUDA (NVIDIA) or Metal
(Apple silicon) in the engine menu. The engine chip says **GPU** when one is found.

## A database will not connect

**Test** in the connection dialog shows the database's own message:

- **Connection refused:** check the host and port, and that the server accepts connections from
  this computer.
- **Password authentication failed:** check the user and password.
- **Needs a driver:** for databases other than PostgreSQL, MySQL, SQLite and DuckDB, install the
  driver in the engine's Python. Microsoft SQL Server, for example, needs `pyodbc`.

The browser version cannot reach database servers. Use the desktop app.

## Where are my files?

In the **FlowLabs** folder in your home folder (`~/FlowLabs`):

| Folder | Holds |
| --- | --- |
| `datasets` | Imported datasets |
| `projects` | Projects |
| `runs` | Trained models |
| `exports` | Exports |

Connections to databases are in `connections.json` there. The browser version keeps everything in
the browser's storage, and clearing site data removes it.

## Start fresh

Close FlowLabs and rename the `~/FlowLabs` folder. FlowLabs creates a new, empty one the next time
it starts. To go back, rename it again.

## Uninstall

| System | How |
| --- | --- |
| Ubuntu, Debian | `sudo apt remove flowlabs` |
| macOS | Move FlowLabs from Applications to the Bin. |
| Windows | Settings → Apps → FlowLabs → Uninstall. |

Your `~/FlowLabs` folder stays. Delete it yourself if you no longer need it.

## Keyboard shortcuts

| Keys | Where | Does |
| --- | --- | --- |
| <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (<kbd>⌘</kbd>+<kbd>Enter</kbd>) | SQL editor | Run the query |
| <kbd>Tab</kbd> | Code editors | Indent |
| <kbd>Ctrl</kbd>+<kbd>Space</kbd> | Code editors | Show completions |
| <kbd>Esc</kbd> | Dialogs | Close |

## Still stuck?

Open an issue on [GitHub](https://github.com/AdityaTakuli/FlowLabs/issues) with what you did, what
you expected, and the message you saw.
