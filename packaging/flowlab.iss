; Inno Setup script for the FlowLab Windows installer.
; Built by scripts/build_app.py when ISCC is on PATH:
;   iscc /DMyAppVersion=0.1.0 /DMySourceDir=dist\FlowLab /DMyOutputDir=dist packaging\flowlab.iss

#define MyAppName "FlowLab"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
#ifndef MySourceDir
  #define MySourceDir "..\dist\FlowLab"
#endif
#ifndef MyOutputDir
  #define MyOutputDir "..\dist"
#endif

[Setup]
AppId={{7E0F1C3A-6D42-4F0B-9E3C-FLOWLAB00001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=FlowLab
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir={#MyOutputDir}
OutputBaseFilename=FlowLab-{#MyAppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=icons\flowlab.ico
UninstallDisplayIcon={app}\FlowLab.exe

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "{#MySourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\FlowLab.exe"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\FlowLab.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\FlowLab.exe"; Description: "Start FlowLab"; Flags: nowait postinstall skipifsilent
