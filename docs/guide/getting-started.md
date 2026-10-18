# Getting started

FlowLabs trains machine learning models without code. You bring a table (or a folder of images),
clean it, train several models side by side, see which one predicts best on rows it never saw, and
export it as Python that runs anywhere. Everything happens on your own computer.

## Install

The quickest way is one command. On **Linux or macOS**, in a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/AdityaTakuli/FlowLabs/main/install.sh | sh
```

On **Windows**, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/AdityaTakuli/FlowLabs/main/install.ps1 | iex
```

It downloads the right file for your computer from the latest release, checks it, and installs it.
On Ubuntu and Debian it asks for your password, to install with `apt`.

To install by hand instead:

| System | Download | Install |
| --- | --- | --- |
| Ubuntu, Debian | `FlowLabs-*-linux-amd64.deb` | Double-click it, or run `sudo apt install ./FlowLabs-*-linux-amd64.deb` |
| Other Linux | `FlowLabs-*-linux-x86_64.tar.gz` | Extract it, then run `sh FlowLabs/install.sh` |
| macOS, Apple silicon | `FlowLabs-*-macos-arm64.dmg` | Open it and drag FlowLabs to Applications |
| macOS, Intel | `FlowLabs-*-macos-x86_64.dmg` | Open it and drag FlowLabs to Applications |
| Windows 10 and 11 | `FlowLabs-*-windows-x64-setup.exe` | Run the installer |
| Python 3.11 or newer | `flowlabs-*.whl` | See [Engines](guide:engines#connect-the-browser-to-an-engine) for the `pip install` command |

Downloads are on the [releases page](https://github.com/AdityaTakuli/FlowLabs/releases/latest).

> **First launch, when you downloaded by hand.** The apps are not code-signed yet. On macOS,
> right-click FlowLabs, choose **Open**, then **Open** again. On Windows, SmartScreen shows a warning:
> click **More info**, then **Run anyway**. You only do this once.

There is also a version that runs inside your web browser with nothing to install. It suits trying
FlowLabs out and small to medium tables. See [Engines and GPUs](guide:engines).

## Your first model in five minutes

1. **Open a sample.** On the home page, click **Customer churn** under Samples. It is 2,000
   telecom customers, and the question is: will they leave?
2. **Create the project.** FlowLabs guesses what to predict (`churned`) and whether it is a
   category or a number. Click **Create project**.
3. **Look at the data.** The Data page shows every column, its gaps and its distribution, and
   suggests fixes. The ones marked *in pipeline* are already applied.
4. **Train.** Click **Train** in the top bar. FlowLabs trains four models: a baseline guess,
   logistic regression, a random forest and gradient boosting. It tests each one on 400 rows it
   kept aside.
5. **Read the results.** The best model is at the top, with its score in the ring. Below are charts
   that show where it is right and where it is wrong.

From there you can [try the model](guide:predict-export) on new rows, or export it as a folder of
Python that runs without FlowLabs.

## The steps of a project

Each project has seven steps, listed down the left side:

| Step | What you do there |
| --- | --- |
| **Data** | Choose what to predict, read the profile, apply suggested fixes. |
| **Analyze** | See every row, sort and search them, query them with SQL or Ask AI. |
| **Pipeline** | Clean the data, choose how to split it, prepare it, and choose the models. |
| **Results** | Train, compare the models, and understand the best one. |
| **Charts** | Every chart of the project in one place, by category. |
| **Predict** | Type in a row (or upload a file) and get predictions. |
| **Export** | Download the model as Python you can run anywhere. |

The dot next to each step turns black when the step is done and red when something needs fixing.
Under the step you are on, the left side also lists that page's sections. The one you are reading
lights up as you scroll; click one to jump to it.

## Where your work is kept

The desktop app keeps everything in a **FlowLabs** folder in your home folder: datasets, projects,
trained models and exports. Updating or reinstalling FlowLabs keeps them. The browser version keeps
them in your browser's storage.

FlowLabs sends nothing about you or your data anywhere. It goes online only:

- to check for updates (desktop app);
- to load Python the first time (browser version);
- when you use [Ask AI](guide:sql#ask-ai), which you set up yourself and which never sends rows of
  data.

## Next

- [Bring your own data](guide:data)
- [Build a pipeline](guide:pipeline)
- [Analyze your data with SQL and Ask AI](guide:sql)
