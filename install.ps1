# Install the FlowLabs desktop app on Windows, with one command in PowerShell:
#
#   irm https://raw.githubusercontent.com/AdityaTakuli/FlowLabs/main/install.ps1 | iex
#
# It finds the latest release, downloads the Windows installer, checks it against the release's
# SHA-256 checksum, installs FlowLabs for your user (no administrator rights needed) and opens it.
#
# Options (environment variables, set before running):
#   $env:FLOWLABS_VERSION = "0.5.3"   install that version instead of the latest
#   $env:FLOWLABS_DRY_RUN = "1"       download and check, but do not install

# Downloads are retried: GitHub's file servers sometimes drop a connection mid-way.
function Invoke-FlowLabsDownload($Uri, $OutFile) {
    for ($attempt = 1; ; $attempt++) {
        try {
            if ($OutFile) { return Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing }
            return Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 60
        } catch {
            if ($OutFile) { Remove-Item $OutFile -ErrorAction SilentlyContinue }
            if ($attempt -ge 5) { throw }
            Write-Host "The connection dropped. Trying again ($attempt of 4)..."
            Start-Sleep -Seconds ($attempt * 2)
        }
    }
}

function Install-FlowLabs {
    $ErrorActionPreference = "Stop"
    $ProgressPreference = "SilentlyContinue"   # much faster downloads in Windows PowerShell 5.1
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = "AdityaTakuli/FlowLabs"
    if (-not [Environment]::Is64BitOperatingSystem) { throw "FlowLabs needs 64-bit Windows." }
    if ($env:FLOWLABS_VERSION) {
        $manifestUrl = "https://github.com/$repo/releases/download/v$($env:FLOWLABS_VERSION.TrimStart('v'))/latest.json"
    } else {
        $manifestUrl = "https://github.com/$repo/releases/latest/download/latest.json"
    }

    Write-Host "Finding the latest FlowLabs release..."
    try {
        # GitHub serves release files as application/octet-stream, so decode and parse it ourselves
        $response = Invoke-FlowLabsDownload $manifestUrl
        $text = if ($response.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($response.Content) } else { [string]$response.Content }
        $manifest = $text | ConvertFrom-Json
    } catch {
        throw "Could not read the release list from GitHub. Check your internet connection and run the command again. (If a release was published minutes ago, it is still being built.)"
    }
    $asset = $manifest.assets | Where-Object { $_.name -like "*-windows-x64-setup.exe" } | Select-Object -First 1
    if (-not $asset) { throw "FlowLabs $($manifest.version) has no Windows installer yet. It may still be building: try again in a few minutes." }

    $file = Join-Path $env:TEMP $asset.name
    Write-Host "Downloading FlowLabs $($manifest.version) ($([math]::Round($asset.size / 1MB)) MB)..."
    try { Invoke-FlowLabsDownload $asset.url $file | Out-Null }
    catch { throw "The download kept failing. Check your internet connection and run the command again." }
    $hash = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
    if ($hash -ne $asset.sha256) {
        Remove-Item $file -ErrorAction SilentlyContinue
        throw "The download does not match the release's checksum. Nothing was installed."
    }
    Write-Host "Download checked."

    if ($env:FLOWLABS_DRY_RUN) {
        Write-Host "FLOWLABS_DRY_RUN is set: $file is downloaded and checked, and not installed."
        return
    }

    Write-Host "Installing (FlowLabs closes first if it is open)..."
    $setup = Start-Process -FilePath $file -ArgumentList "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS" -Wait -PassThru
    Remove-Item $file -ErrorAction SilentlyContinue
    if ($setup.ExitCode -ne 0) { throw "The installer stopped with code $($setup.ExitCode)." }
    Write-Host ""
    Write-Host "FlowLabs $($manifest.version) is installed and opening. It is in the Start menu and on your desktop."
    Write-Host "Your projects are kept in $env:USERPROFILE\FlowLabs. From now on FlowLabs updates itself."
}

Install-FlowLabs
