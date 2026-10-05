; Inno Setup script for GamePanel-Setup.exe. Built by windows\build.ps1, which
; passes AppVersion, SourceDir (the staged files) and OutputDir.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{8E0C4C52-6F3B-4C55-9B7E-2A9C1C0B6A11}
AppName=GamePanel
AppVersion={#AppVersion}
AppVerName=GamePanel {#AppVersion}
AppPublisher=GamePanel
AppPublisherURL=https://github.com/jebster33/gamepanel
DefaultDirName={autopf}\GamePanel
DisableProgramGroupPage=yes
DisableDirPage=auto
OutputDir={#OutputDir}
OutputBaseFilename=GamePanel-Setup-{#AppVersion}
SetupIconFile={#SourceDir}\windows\gamepanel.ico
UninstallDisplayIcon={app}\windows\gamepanel.ico
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
CloseApplications=no

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[INI]
Filename: "{app}\GamePanel.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:8080"

[Icons]
Name: "{autoprograms}\GamePanel"; Filename: "{app}\GamePanel.url"; IconFilename: "{app}\windows\gamepanel.ico"

[Run]
Filename: "{app}\GamePanel-Service.exe"; Parameters: "install"; Flags: runhidden waituntilterminated; StatusMsg: "Registering the GamePanel service..."; Check: not ServiceExists
Filename: "{app}\GamePanel-Service.exe"; Parameters: "refresh"; Flags: runhidden waituntilterminated; Check: ServiceExists
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""GamePanel"""; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""GamePanel"" dir=in action=allow protocol=TCP localport=8080"; Flags: runhidden waituntilterminated; StatusMsg: "Allowing the panel through Windows Firewall..."
Filename: "{app}\GamePanel-Service.exe"; Parameters: "start"; Flags: runhidden waituntilterminated; StatusMsg: "Starting GamePanel..."
Filename: "http://localhost:8080"; Description: "Open GamePanel in your browser"; Flags: shellexec postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\GamePanel-Service.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\GamePanel-Service.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""GamePanel"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveFirewall"

[UninstallDelete]
Type: files; Name: "{app}\GamePanel.url"

[Messages]
FinishedLabel=GamePanel is running as a Windows service and starts with Windows.%n%nOpen http://localhost:8080 and create your administrator account. Servers, backups and settings are kept in C:\ProgramData\GamePanel.

[Code]
function ServiceExists: Boolean;
begin
  Result := RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\GamePanel');
end;

{ An update replaces node.exe, so the running panel has to stop first. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Result := '';
  if ServiceExists then
  begin
    Exec(ExpandConstant('{sys}\sc.exe'), 'stop GamePanel', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(4000);
  end;
end;
