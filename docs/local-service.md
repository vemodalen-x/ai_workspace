# Linux 本机常驻服务

工作台由用户级 systemd 管理，监听 `http://127.0.0.1:4310`。使用生产构建；不使用 Vite 开发服务器、不在启动时自动更新代码。用户数据与不可变发布目录分离，更新不会重置项目、运行历史或工作树。

## 服务与恢复

- `ai-agent-workspace.service`：启动控制端及内置网页；`Restart=always`，异常退出后 5 秒重试，`KillMode=control-group` 避免遗留子进程。手动 `systemctl --user stop` 会保持停止。
- `ai-agent-workspace-health.timer`：每 30 秒检查页面、JavaScript 资源、认证 API 和数据库快照。失败时触发 `ai-agent-workspace-recover.service`，仅重启仍处于运行状态的服务；不会撤销操作者的手动停止。
- 服务停止最多等待 45 秒，再由 systemd 清理进程组。健康检查恢复最坏时间包含检查间隔、8 秒请求超时和停止等待时间，不表示零停机。
- `loginctl enable-linger "$USER"` 让用户级 systemd 开机启动并在退出登录后继续运行。该命令是否需要管理员权限取决于本机策略。
- Node.js 需要 24+，unit 使用已验证的绝对可执行文件路径，不依赖登录 shell 的 PATH。

`deploy/systemd/` 保存 unit 模板。安装时替换 `@RELEASE@`（包含 `current` 与 `releases/` 的发布根目录）、`@CONFIG@`（含 `service.env` 的配置目录）、`@DATA@` 和 `@NODE@`。所有路径必须为绝对路径。路径含空格时需正确处理 systemd 引号；本机安装使用无空格路径。

`service.env` 至少设置：

```ini
API_PORT=4310
WORKSPACE_DATA_DIR=/absolute/path/to/.workspace
PATH=/absolute/node/bin:/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin
```

网页仍仅绑定 loopback。不为局域网或公网开放接口。原生 CLI 认证继续使用服务所属用户的账户，不复制认证文件。SSH 节点继续使用其已保存、校验过的绝对 `nodePath`。

## 数据库锁

systemd 使用 `flock` 对 `service.guard` 加进程生命周期锁，再运行 `scripts/service-start.mjs`。服务器使用本机 socket / named pipe 保证单实例，`server.lock` 保存 PID 和认证 key；启动器同时兼容早期版本的 PID / startedAt 锁格式。

启动器只归档确认已死亡 PID 的旧锁，不删除数据库，也不自动处理不明内容、符号链接或活进程的锁。`.service-owner.json` 记录启动时的 Linux boot ID，系统重启后可以识别旧启动的锁，避免无关进程重用 PID 导致阻塞。旧锁保存在 `server.lock.recovered-*` 供审计。服务应始终通过 unit 启动，不能绕开 `flock` 并发运行启动器。

崩溃恢复不等于恢复执行成功：不确定的运行和资源仍按工作台现有恢复策略隔离，需检查后手动核对，不自动续跑真实模型。

## 运维

```sh
systemctl --user status ai-agent-workspace.service
systemctl --user list-timers ai-agent-workspace-health.timer
journalctl --user -u ai-agent-workspace.service -n 100 --no-pager
systemctl --user restart ai-agent-workspace.service
systemctl --user stop ai-agent-workspace.service
loginctl show-user "$USER" -p Linger
```

更新前验证新发布、确认没有正在执行的任务，停止健康计时器和控制端后备份 SQLite 数据库与 unit；再切换 `current` 并启动服务与计时器。保留旧发布目录，回滚时停止服务、将 `current` 指回旧目录再启动。不要对运行中的数据库直接复制单一 `.db` 文件来声称一致备份；使用 SQLite backup，或干净停止后复制。不要从备份自动覆盖升级后已经产生的新数据。

本次本机注册与验证结果见部署目录中的 `DEPLOYMENT.md`；重启整机和断电恢复不能仅凭 enabled / linger 状态宣称已经实际测试。
