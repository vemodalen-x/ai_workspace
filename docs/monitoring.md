# 原生会话监控

日常开发通过原生 Codex CLI、Claude Code CLI，或 VS Code、PyCharm/JetBrains 等 IDE 插件完成。Workspace 的 **Monitor** 页只做统一监控入口：集中展示项目、原生会话和工作台任务的状态、进度与异常。用户不需要通过 Workspace 发起任务，监控也不会启动、恢复、终止或接管任何 Agent 进程。

## 发现

服务进程内维护一个可重建的内存索引（`packages/orchestration/session-index.ts`），启动时扫描一次，之后每 15 秒增量刷新；页面每 10 秒读取结果，**Refresh** 会立即扫描。

| 来源             | 位置                                                                       | 说明                                                      |
| ---------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Codex 会话       | `$CODEX_HOME/sessions`、`$CODEX_HOME/archived_sessions`（默认 `~/.codex`） | 递归 4 层，读取 `*.jsonl`                                 |
| Codex 线程标题   | `$CODEX_HOME/state_N.sqlite` 最新一份                                      | 只读打开，只查询 `threads.id/title`；不可读时回退派生标题 |
| Claude Code 会话 | `$CLAUDE_CONFIG_DIR/projects/*/*.jsonl`（默认 `~/.claude`）                | 主会话与 sidechain 分开，sidechain 不影响主会话状态       |

CLI 和 IDE 插件写入同一份原生记录，因此无需安装插件或 hook。客户端类型来自记录本身：

- Codex `session_meta.originator` 优先（例如 JetBrains 插件的 `*_intellij`），其次 `source`：`vscode`、`exec`、`cli`；`source.subagent.thread_spawn` 标记为子 Agent，并记录父会话 ID。
- Claude Code 使用记录中的 `entrypoint`：`cli`、`sdk-*`、`*vscode*`、`*jetbrains*`。

## 只读与边界

- 只对工具目录执行 `readdir`/`lstat`/只读 `open`，SQLite 以 `readOnly` 打开；不写入、不加锁、不修改 mtime。测试会比对扫描前后的文件内容和 mtime。
- 跳过符号链接，对应来源标为 `partial`；每次刷新最多读取约 96 MiB、10,000 个文件，超出部分记为 `pending`，下一次刷新继续。
- 不写数据库。重启服务后重新扫描即可恢复索引。
- 标题、最近请求和对话摘录会做已知凭证模式脱敏并截断；注入的环境上下文不会当作用户请求。

## 增量同步

每个文件以 `dev:ino:size:mtime` 判断是否变化，未变化的文件不会被打开。对于变化的文件：

1. 首次读取头部元数据窗口和尾部窗口。24 小时内修改过的文件读取尾部 4 MiB，更早的文件读取 256 KiB。
2. 记下已消费到的最后一个完整行的偏移量，以及 inode。之后同一文件只读取追加部分（单次最多 8 MiB），并沿用上一次的轮次状态。写到一半的行要等写完后才会被消费。
3. 文件被替换（inode 变化）、截断，或单次追加超过 8 MiB 时，按第 1 步重新解析。

这样，长时间运行的轮次即使开始标记已经离开尾部窗口，状态仍然保持为「进行中」。

## 状态派生

| 字段              | 规则                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 轮次 `phase`      | Codex：`task_started` → working，`task_complete` → waiting，`turn_aborted` → aborted，`error` → error。Claude：`tool_use`/`max_tokens` → working，`end_turn` → waiting，API 错误或 `refusal` → error，用户中断 → aborted |
| 活跃度 `liveness` | 2 分钟内写入为 active，24 小时内为 recent，否则 dormant                                                                                                                                                                  |
| 卡住 `stalled`    | 轮次进行中，超过 15 分钟没有写入，且最后写入在 24 小时内                                                                                                                                                                 |
| 恢复命令          | `cd '<cwd>' && codex resume <id>` 或 `claude --resume <id>`，只用于复制，Workspace 不执行                                                                                                                                |

## 与项目关联

按以下顺序判断，不猜测：

1. **managed**：会话目录是 Workspace 管理的 worktree，或 Provider session ID 与工作台会话一致。
2. **exact**：会话目录的真实路径等于某个未移除项目的 `repoPath` 真实路径。
3. 否则为 **unassigned**。位于项目子目录时只给出「建议项目」，不自动归属；用户可以把该目录登记为项目。

## 告警

- 会话：错误（error）、卡住（warning，附空闲分钟数）、中断（info）、活跃但未关联项目（info）。
- 工作台：Briefing 中的 recover / fix / approve / stale 项，以及 7 天内失败的命令实验。
- 来源：目录部分可读或不可读。目录不存在（例如没有 `archived_sessions`）不告警。

项目健康度按 blocked > attention > active > idle 计算。概览返回最近 200 个会话，以及所有带告警的会话。

## API

均需要本地 Bearer token。

- `GET /api/monitor/overview?refresh=true|false`：返回 `MonitorOverview`（`packages/shared/monitoring.ts`）。默认使用不超过 15 秒的索引；`refresh=true` 立即扫描。
- `GET /api/monitor/sessions/:id/output`：`id` 是索引给出的 64 位十六进制 ID。读取前会重新核对文件中的原生会话 ID，文件被替换时返回错误。返回内容与项目历史相同，为脱敏后的有界摘录。

## 尚未支持

- 远端机器上的会话：只扫描运行 Workspace 的本机目录。
- 进程级存活检测：活跃度依据文件写入时间，不检查 PID；会话进程已退出但最后一轮未结束时，24 小时内仍会显示为卡住。
- 审批等待：Codex/Claude 的工具审批请求目前没有稳定的落盘标记，无法区分「等待审批」与「等待输入」。
- 从监控页发送消息、恢复或终止原生会话；手动把未关联会话指派给项目；告警通知（桌面、邮件等）和历史趋势。
- Cursor、Windsurf 等其他工具自有的记录格式。
