; Mad Reader — Inno Setup script.
; Build with:  .\build.ps1   (or: ISCC.exe /DAppVersion=1.0.0 installer\MadReader.iss)
;
; Per-user install, no admin rights. File associations are written by the app
; itself (MadReader.exe --register) so the installer and the in-app installer
; share exactly the same registration logic.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppName "Mad Reader"
#define AppExe "MadReader.exe"

[Setup]
AppId={{18F2AC2E-1A42-4AF6-9460-4FAE3D0C0E14}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Mad Reader
AppComments=A fast Markdown reader with first-class Hebrew (RTL) support
DefaultDirName={autopf}\MadReader
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=MadReader-{#AppVersion}-setup
SetupIconFile=..\assets\app.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
LicenseFile=..\LICENSE
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=yes
RestartApplications=no
ChangesAssociations=yes
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "he"; MessagesFile: "compiler:Languages\Hebrew.isl"

[CustomMessages]
en.DefaultApp=Open Windows Settings to make Mad Reader the default app for .md files
he.DefaultApp=פתח את הגדרות Windows כדי להגדיר את Mad Reader כאפליקציית ברירת המחדל לקובצי ‎.md
en.Launch=Launch Mad Reader
he.Launch=הפעל את Mad Reader
en.DesktopIcon=Create a desktop shortcut
he.DesktopIcon=צור קיצור דרך בשולחן העבודה

[Tasks]
Name: "desktopicon"; Description: "{cm:DesktopIcon}"; Flags: unchecked

[Files]
Source: "..\dist\MadReader.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.he.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; Comment: "Markdown reader"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Parameters: "--register --quiet"; Flags: runhidden waituntilterminated
Filename: "{app}\{#AppExe}"; Parameters: "--default-apps"; Description: "{cm:DefaultApp}"; Flags: postinstall nowait skipifsilent
Filename: "{app}\{#AppExe}"; Description: "{cm:Launch}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\{#AppExe}"; Parameters: "--unregister"; Flags: runhidden waituntilterminated; RunOnceId: "Unregister"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\MadReader"
Type: filesandordirs; Name: "{userappdata}\MadReader"
