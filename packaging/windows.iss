[Setup]
AppId=ai-agent-workspace
AppName=AI Agent Workspace
AppVersion={#ProductVersion}
AppPublisher=vemodalen-x
AppPublisherURL=https://github.com/vemodalen-x/ai_workspace
DefaultDirName={localappdata}\Programs\AI Agent Workspace
DefaultGroupName=AI Agent Workspace
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
OutputDir={#OutputPath}
OutputBaseFilename=ai-agent-workspace-windows-x64-setup
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=AI Agent Workspace

[Files]
Source: "{#StagePath}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\AI Agent Workspace"; Filename: "{app}\ai-agent-workspace.cmd"; WorkingDir: "{app}"
Name: "{group}\Stop AI Agent Workspace"; Filename: "{app}\ai-agent-workspace.cmd"; Parameters: "stop"; WorkingDir: "{app}"
Name: "{group}\Sign in to Codex"; Filename: "{app}\ai-agent-workspace.cmd"; Parameters: "login codex"; WorkingDir: "{app}"

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\dist\launcher\src\index.js"" start"; Description: "Open AI Agent Workspace"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\dist\launcher\src\index.js"" stop"; Flags: runhidden waituntilterminated skipifdoesntexist

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Executable, Launcher: String;
  Code: Integer;
begin
  Result := '';
  Executable := ExpandConstant('{app}\runtime\node.exe');
  Launcher := ExpandConstant('{app}\dist\launcher\src\index.js');
  if FileExists(Executable) and FileExists(Launcher) then
    if not Exec(Executable, '"' + Launcher + '" stop', '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
      Result := 'Stop the running workspace before updating this installation.';
end;
