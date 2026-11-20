# Install AI Agent Workspace

The personal edition runs on one computer. You bring a Git repository and can run its commands, keep metrics, or ask a coding agent to make a change in a separate worktree. A browser connects to the local service. The installers include the web UI, server, SQLite runtime, Node.js and Codex CLI.

## Windows x64

1. Install [Git for Windows](https://git-scm.com/downloads/win) 2.38 or newer and make `git` available on PATH.
2. Download and open [the Windows installer](https://github.com/vemodalen-x/ai_workspace/releases/latest/download/ai-agent-workspace-windows-x64-setup.exe). Installation uses your Windows account.
3. Open **AI Agent Workspace** from Start. The browser opens the workspace. You can close the tab and reopen the same workspace later. **Stop AI Agent Workspace** shuts down the local service.

For PowerShell or headless use:

```powershell
$workspace = "$env:LOCALAPPDATA\Programs\AI Agent Workspace\ai-agent-workspace.cmd"
& $workspace start --no-browser
& $workspace status
& $workspace stop
```

## Linux x86-64

On Debian 12+ or Ubuntu 24.04+, download [the Debian package](https://github.com/vemodalen-x/ai_workspace/releases/latest/download/ai-agent-workspace-linux-x64.deb) and run:

```sh
sudo apt install ./ai-agent-workspace-linux-x64.deb
ai-agent-workspace start
```

For a user-owned installation with Git 2.38+ and a compatible glibc runtime, download [the Linux archive](https://github.com/vemodalen-x/ai_workspace/releases/latest/download/ai-agent-workspace-linux-x64.tar.gz) and unpack it:

```sh
mkdir -p "$HOME/.local/opt"
tar -xzf ai-agent-workspace-linux-x64.tar.gz -C "$HOME/.local/opt"
"$HOME/.local/opt/ai-agent-workspace/ai-agent-workspace" start
```

`start --no-browser` prints the loopback URL for a headless session. Subsequent launches reopen the running instance. Use `status` to find its URL and `stop` for a graceful shutdown. SHA-256 digests accompany the installers in the [release](https://github.com/vemodalen-x/ai_workspace/releases/latest).

## Run your first project

1. Choose **Import project**. Enter the path of a local Git repository with at least one commit.
2. For an existing script, open **Experiments → New trial**, select the project, enter its command as a JSON array (for example `["node","scripts/measure.cjs"]`), and name the experiment group. Scripts should be committed. Use the absolute path of your Python virtual environment's interpreter if needed. Each trial uses a fresh worktree, so local untracked dependencies and data must be available separately.
3. Save the trial, choose **Run trial**, inspect its commit and command, and choose **Queue attempt**. A process executes with your user permissions. Open **Command output** for its log, inspect its exit code and use **Export attempt JSON** to save the command, commit, parameters, results and captured log.

Metrics are optional. For a plot, print one line per reading to standard output, such as `WORKSPACE_METRIC {"name":"accuracy","unit":"%","step":1,"value":92.4}`. The script can read the saved configuration from `WORKSPACE_EXPERIMENT` (JSON).

For an AI task, open **Sign in to Codex** in the Windows Start menu or run `ai-agent-workspace login codex` on Linux. For Claude Code, install the native CLI, run `claude auth login` and make the executable available on PATH, or set `CLAUDE_BIN` to its absolute path before starting the workspace. Use **Settings → Check providers**, then **Projects → New task**, choose a provider, save, and confirm the run. Provider usage follows your account. Review its diff, preview the merge and approve it to apply the result to your repository.

For review-only Codex sessions, set `WORKSPACE_CODEX_READ_ONLY=1` before starting the workspace. The adapter then requests the native Codex read-only sandbox for its turns.

## Data, updates and troubleshooting

| Setting                     | Default                                                   |
| --------------------------- | --------------------------------------------------------- |
| Windows data and server log | `%LOCALAPPDATA%\AI Agent Workspace\data`                  |
| Linux data and server log   | `${XDG_DATA_HOME:-$HOME/.local/share}/ai-agent-workspace` |
| Local browser address       | `http://127.0.0.1:4310`                                   |

Set `WORKSPACE_DATA_DIR` to an absolute path for a different workspace. To open a workspace from a source installation, stop its server and set this variable to the existing `.workspace` directory in its original location. Git worktrees and imported repository paths are location-dependent.

Before updating or uninstalling, finish or stop running jobs and use the launcher's `stop` command. Back up the entire data directory and your Git repositories while the server is stopped. Install the new package over the old one or replace the extracted application folder. Your database and worktrees live in the separate data directory. To uninstall, use Windows Installed Apps, `sudo apt remove ai-agent-workspace`, or remove the extracted Linux application folder.

If port 4310 is occupied, set `API_PORT` to an available local port before launching. Read `server.log` in the data directory for startup errors. After an unexpected shutdown inspect any attempt marked **orphaned** and confirm its process has stopped before releasing the reservation.
