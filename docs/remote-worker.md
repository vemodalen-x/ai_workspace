# SSH Remote Worker

v0.1 supports an **attached SSH worker** on Linux. It executes the actual adapter in its own worktree and streams normalized events, system metrics and final diff. This is not a persistent distributed queue, and it does not reconnect to a running process after SSH loss.

## 1. Prepare the remote host

Create a dedicated non-root Unix user with access only to intended repositories and worktree storage. Install Node 24+, Git 2.38+, and the project source:

```bash
cd /srv/ai-agent-workspace
npm ci
npm run build
# Authenticate locally on this host; do not copy raw OAuth tokens from the controller
npx --no-install codex login
npx --no-install claude auth login
```

An interactive native provider login may require SSH port forwarding or the Provider's official device-login flow. Follow the CLI's instructions, not a handcrafted credential transfer. Mock needs no authentication.

Clone/sync the same Git repository on the host. The worker verifies the repository HEAD equals the controller's recorded base SHA. Synchronization is deliberately explicit; the application does not push uncommitted code or credentials.

## 2. Configure trusted paths without shell interpolation

The worker's configured entry path must be absolute and use only alphanumerics, slash, dot, underscore and hyphen. To supply environment settings reliably for non-interactive SSH, create this **operator-owned** bootstrap at `/srv/ai-agent-workspace/worker-bootstrap.mjs`:

```javascript
process.env.WORKER_REPO_ROOT = '/srv/projects';
process.env.WORKER_DATA_DIR = '/srv/agent-data';
await import('./dist/worker/src/index.js');
```

Do not place the bootstrap or the worker installation inside an Agent-writable worktree. Use restrictive permissions; allow only the dedicated account to write its state directory. The `WORKER_REPO_ROOT` check confines repository selection; it is not an OS sandbox for all provider actions. For untrusted code, provision a container/VM and an OS policy independently.

## 3. Configure the local SSH client

Add a named host to `~/.ssh/config` (Windows: `%USERPROFILE%\.ssh\config`):

```sshconfig
Host gpu-workstation
    HostName your-owned-host.example
    User agentworker
    IdentityFile ~/.ssh/agentworker_ed25519
    IdentitiesOnly yes
    ForwardAgent no
```

Verify and add the host key using your normal trusted process. The application always passes `BatchMode=yes`, `StrictHostKeyChecking=yes`, a 7s connect timeout and keepalive settings. It does not ask for or store SSH passwords/private key contents, and never disables host-key verification.

In Compute nodes → Add SSH node:

- Name: GPU workstation
- SSH alias: gpu-workstation
- Worker path: `/srv/ai-agent-workspace/worker-bootstrap.mjs`
- CPU/RAM scheduling capacities: operator-selected soft reservation capacity

Use Compute nodes → Refresh, or wait for the automatic probe. A successful response marks the node online. Assign a task to this node and supply its Remote repository path, for example `/srv/projects/cv-agent`. Launch explicitly. Each native provider must be authenticated on that worker.

## Protocol and failure model

One JSONL request on stdin (`metrics`, `probe` or `run`). The controller keeps stdin open throughout execution. Worker stdout is JSONL only; provider logs are nested events, not mixed with control frames. EOF or SIGTERM aborts execution. Worker has its own bounded timeout as a backup to controller cancellation.

Responses: `probe`, `workspace`, `event`, `metrics`, `complete`, `error`. Control requests use UUID session/run identifiers and a validated commit SHA. Repository paths are canonicalized and must be under the configured root.

Worker keeps `runs/<runId>.json` claims and `sessions/<sessionId>.lock`. Duplicate completed Run IDs replay the saved result without executing the agent. In-flight/failed duplicate IDs are refused. Concurrent work on the same Session is refused. A crash can leave lock/claim files; no automatic lock stealing based only on PID occurs.

SSH loss, cancellation while remote execution is active, or any uncertain completion is marked **orphaned** at the controller. Reservations remain quarantined. Inspect the worker and its child processes, worktree status and run record before confirming Reconcile execution. If a worker crashed, inspect and remove its session lock only after all old processes have stopped. A new attempt uses a new Run ID. Remote logs emitted before transport loss are retained on the controller; there is no guaranteed replay of unreceived events.

The worker's `complete` result includes a real snapshot diff and commit. v0.1 cannot import a remote commit into the controller's source repository or approve a remote merge from the UI. Use an operator-controlled Git transfer/review workflow, or run local integration after fetching the reviewed branch. Remote validation argv and remote cleanup UI are also deferred.

## What was tested

Automated tests launch the actual worker as a separate local Node process, exercise its JSONL contract, worktree writes, final diff and duplicate suppression, and reject out-of-root repositories. Offline SSH nodes are tested at scheduler admission. **No real remote SSH host was supplied, so SSH authentication, network partitions, GPU hardware and remote provider inference were not verified live.**

## v0.4 monitoring

Deploy the same build on controller and workers. The lightweight `metrics` request does not inspect provider credentials or require `WORKER_REPO_ROOT`. Idle nodes are polled automatically. A controller-managed Run sets `controllerMonitors` to avoid a second in-band hardware sampler. See [fleet setup and acceptance](experiment-fleet.md).
