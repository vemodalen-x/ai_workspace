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
- 跳过符号链接，对应来源标为 `partial`。每次刷新最多读取约 96 MiB、10,000 个文件。有变化的文件按修改时间从新到旧处理，超出预算的记为 `pending`（保留上一次结果），下一次刷新继续；这只是延后，不会产生来源告警。
- 不写数据库。重启服务后重新扫描即可恢复索引。
- 标题、最近请求和对话摘录会做已知凭证模式脱敏并截断；注入的环境上下文不会当作用户请求。

## 增量同步

每个文件以 `dev:ino:size:mtime` 判断是否变化，未变化的文件不会被打开。对于变化的文件：

1. 首次读取头部元数据窗口和尾部窗口。24 小时内修改过的文件读取尾部 4 MiB，更早的文件读取 256 KiB。
2. 记下已消费到的最后一个完整行的偏移量，以及 inode。之后同一文件只读取追加部分（单次最多 8 MiB），并沿用上一次的轮次状态。写到一半的行要等写完后才会被消费。
3. 文件被替换（inode 变化）、截断，或单次追加超过 8 MiB 时，按第 1 步重新解析。

这样，长时间运行的轮次即使开始标记已经离开尾部窗口，状态仍然保持为「进行中」。

## 进程关联（Linux）

Codex 在会话加载期间一直打开对应的 rollout 文件。每次扫描前，监控读取当前用户进程的 `/proc/<pid>/comm`；对名称以 `codex` 或 `claude` 开头的进程，再读取 `/proc/<pid>/fd` 的链接目标。这一步只读，不发送信号，也不附加到进程，本机约 30 ms。

- **attached**：有 Codex 进程打开了该会话文件。CLI、IDE 插件和 SDK 启动的 `codex` 进程都适用。
- **detached**：能观测进程，但没有进程打开该文件。
- 未设置：Claude Code 不保持会话文件打开，以及 macOS、Windows 等没有 `/proc` 的系统，都回退到按写入时间判断。页面会显示「当前系统无法观测进程状态」。

其他程序（编辑器、`tail -f`）打开会话文件不计入。

## 状态派生

| 字段                    | 规则                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 轮次 `phase`            | Codex：`task_started` → working，`task_complete` → waiting，`turn_aborted` → aborted，`error` → error。Claude：`tool_use`/`max_tokens` → working，`end_turn` → waiting，API 错误或 `refusal` → error，用户中断 → aborted |
| 活跃度 `liveness`       | 2 分钟内写入为 active，24 小时内为 recent，否则 dormant                                                                                                                                                                  |
| 卡住 `stalled`          | 轮次进行中，超过 15 分钟没有写入，最后写入在 24 小时内，不是 detached，也不在等待回答（进程仍在时可能在等待长命令或审批）                                                                                                |
| 中途退出 `endedMidTurn` | 轮次进行中、detached，最后写入在 2 分钟到 24 小时之间。2 分钟内的写入可能来自探测之后才启动的进程，因此不判定                                                                                                            |
| 进行中统计              | 轮次进行中，且 2 分钟内有写入或仍为 attached；长时间执行的命令不会因为暂时没有输出而被漏计                                                                                                                               |
| 模型 `model`            | Codex：最近一条 `turn_context.model`，尾部窗口中没有时取头部窗口中的值。Claude：最近一条主会话 assistant 记录的 `message.model`，跳过 `<synthetic>` API 错误记录                                                         |
| 已用上下文 `context`    | Codex：最近一次 `token_count` 的 `last_token_usage.total_tokens` 与 `model_context_window`。Claude：最近一条主会话 assistant 记录 `usage` 中输入、缓存写入、缓存读取和输出 token 之和；Claude Code 不记录上下文窗口大小  |
| 正在执行 `activity`     | 当前轮次中最近一个还没有结果的工具调用及其开始时间。Codex 按 `call_id` 配对 `function_call`/`custom_tool_call` 与对应 output；Claude 按 `tool_use.id` 配对主会话的 `tool_result`。轮次结束或中断时清空                   |
| 计划 `plan`             | 最近一次 Codex `update_plan` 或 Claude `TodoWrite` 的步骤总数、已完成数和进行中的步骤（脱敏、截断）。轮次结束后保留最后状态                                                                                              |
| 等待回答 `needsAnswer`  | Claude 轮次进行中，正在执行的工具是 `AskUserQuestion` 或 `ExitPlanMode`（这两个工具在用户于原客户端回答前不会返回结果），最后写入在 24 小时内                                                                            |
| 恢复命令                | `cd '<cwd>' && codex resume <id>` 或 `claude --resume <id>`，只用于复制，Workspace 不执行                                                                                                                                |

## 与项目关联

按以下顺序判断，不猜测：

1. **managed**：会话目录是 Workspace 管理的 worktree，或 Provider session ID 与工作台会话一致。
2. **exact**：会话目录的真实路径等于某个未移除项目的 `repoPath` 真实路径。
3. 否则为 **unassigned**。位于项目子目录时只给出「建议项目」，不自动归属。未关联会话的详情页提供 **将目录登记为项目**：打开预填好路径和名称的导入表单，确认后只在 Workspace 数据库新增项目记录，不修改目录和会话；下一次读取概览时该目录下的会话变为 exact。

## 告警

- 会话：错误（error）、等待你的回答（warning）、进程在轮次中途退出（warning）、卡住（warning，附空闲分钟数）、中断（info）、活跃或仍在执行但未关联项目（info）。
- 工作台：Briefing 中的 recover / fix / approve / stale 项，以及 7 天内失败的命令实验。
- 来源：目录部分可读或不可读。目录不存在（例如没有 `archived_sessions`）不告警。

侧栏 **Monitor** 显示 warning 和 error 告警的数量，在其他页面时每 30 秒更新一次，与监控页共用同一份概览缓存。

### 桌面通知

监控页的 **Notifications** 按钮默认关闭。开启时请求浏览器通知权限，选择保存在本机浏览器中。开启后：

- 每次概览更新时，对新出现的 warning / error 告警（按告警 ID 去重）弹出浏览器通知，单次最多 3 条。页面加载时已存在的告警不通知。
- 正在查看监控页时不通知；切到其他页面或标签页进入后台后才通知。开启通知时，后台标签页也会每 30 秒刷新一次概览。
- 通知由浏览器在本机显示，不经过任何外部服务。关闭 Workspace 页面后不再通知。

项目健康度按 blocked > attention > active > idle 计算。概览返回最近 200 个会话，以及所有带告警或 attached 的会话。

## API

均需要本地 Bearer token。

- `GET /api/monitor/overview?refresh=true|false`：返回 `MonitorOverview`（`packages/shared/monitoring.ts`）。默认使用不超过 15 秒的索引；`refresh=true` 立即扫描。
- `GET /api/monitor/sessions/:id/output`：`id` 是索引给出的 64 位十六进制 ID。读取前会重新核对文件中的原生会话 ID，文件被替换时返回错误。返回内容与项目历史相同，为脱敏后的有界摘录。

## 尚未支持

- 远端机器上的会话：只扫描运行 Workspace 的本机目录。
- Claude Code 以及 macOS、Windows 上的进程关联：仍按写入时间判断，会话进程已退出但最后一轮未结束时，24 小时内显示为卡住。
- 工具审批等待：Codex/Claude 的命令审批请求没有落盘标记，等待审批的工具调用与正在执行的调用无法区分，都显示为「正在执行」。对本机 Codex 记录的统计中，`event_msg` 共 14 种类型，没有审批请求事件。
- Codex 向用户提问：`request_user_input_async` 的 output 在约 0.3 秒内写入（本机 33 次调用，最长 0.26 秒），回答通过其他通道返回，因此无法据此判定「等待你的回答」；只有 Claude 的 `AskUserQuestion`/`ExitPlanMode` 支持。
- 计划进度只来自读取窗口内的记录：计划更新早于尾部窗口时（长会话首次扫描），直到下一次计划更新才会显示。本机最近使用 `update_plan` 的 Codex 会话已是 77 天前，当前版本 Claude Code 记录中也没有 `TodoWrite`，所以多数会话只显示正在执行的工具。
- Claude Code 会话的上下文占用百分比：记录中没有上下文窗口大小，只显示 token 数。
- 从监控页发送消息、恢复或终止原生会话；把单个会话指派给与其目录不同的项目（只能登记会话所在目录）；邮件、IM 等外部告警通知（只支持浏览器桌面通知，且需要页面保持打开）和历史趋势。
- Cursor、Windsurf 等其他工具自有的记录格式。
