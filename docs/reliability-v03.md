# v0.3 — 可追溯执行与证据有效性

2026-11-04。此版本实现上一轮架构审查的第一阶段，仍使用单个本地服务与 SQLite；不代表全部模块化重构已完成。

## 明确的职责边界

- `shared/evidence.ts`：纯函数计算命令证据、精确合并记录和输入有效性。
- `shared/context.ts`：构造实际发送给 Agent 的交接上下文。
- `shared/assistant.ts`：关注事项排序，不授权执行。
- `orchestration/manifest.ts`：在资源预留前捕获任务定义及依赖结果。
- `orchestration/lifecycle.ts`：允许的 Run 状态转换。
- `orchestration/verification.ts`：在独立工作区验证冻结的候选提交。
- `web/ResultEvidence.tsx`：证据与输入清单的独立展示组件。

原 shared/assistant 导出保留兼容转发。Orchestrator 与前端主入口尚未完全拆分；Provider registry、执行驱动、分页面查询与深链接属于后续工作。

## Run manifest

每次真正开始执行时捕获任务版本、项目工作约定版本、完整 taskSpec、项目上下文、依赖 Run ID 和 resultCommit、已知 Provider 版本与本地运行环境。远程环境与版本未探测时为 null，不复制本地数据假装远端事实。

准备工作区后记录实际输入 HEAD；调用 Adapter 前记录完整执行 prompt 的 SHA-256。任务输入一旦进入执行，不再从可变的 Workspace.headCommit 推断依赖版本。字段仅在调用 Agent 前分阶段补全，开始推理后不重算。旧记录可读，无 manifest 的历史结果显示 unknown。

任务任何配置改变都会保守递增 revision，完全相同的保存不递增。项目 context 改变递增 contextRevision；仅重命名项目不会使结果失效。这里尚未区分“优先级改变”和“语义目标改变”，可能产生保守的额外重跑。

## 证据有效性

历史 Run.state 保留原值，另行计算 current / stale / unknown：

- 任务定义或项目约定版本变化：stale。
- 依赖最近执行不是原 Run、提交不匹配、未成功结束：stale。
- 上游依赖已 stale/unknown：向下游传播 stale。
- 缺少 manifest：unknown，不伪造回填。

例如 A1 → B1 → C1 已完成，A2 启动/完成后，B1/C1 仍保留 completed 历史，但会显示过期原因。过期结果在 UI 进入 stale 关注项，预览及批准合并时都重新检查；下游排队任务在依赖证据恢复前不启动。不会自动消耗真实 Provider 额度来重跑。

依赖使用精确 resultCommit；不会跟随 Session 的可变 headCommit。integration Session 如果已合入的提交与新依赖不一致，会拒绝续跑并要求新 Session。新 UI 提供 Re-run in new session，仍进入原有明确执行确认流程。

Legacy unknown 结果仍可人工审查并沿用原合并路径，但不能作为新版下游调度的已确认依赖；先重跑依赖建立 manifest。

## 候选提交验证

Agent 返回后先快照出候选提交。验证命令在 `verify-<runId>` 独立 worktree 执行，报告记录 argv、commit、结果、验证目录与是否保留。

- 退出成功且 HEAD / 受跟踪内容未改变：记录 passed=true、exitCode=0。
- 改写受跟踪源码或提交：验证失败，不能用此结果证明候选提交。
- 新建未跟踪报告不会改变已测试的候选源码，但目录被保留，报告给出路径。
- 仅清理完全干净的验证工作区，保留分支；不强制清理用户或验证产生的文件。
- 失败保留开发 worktree 和候选快照。没有自动删除失败证据。

验证报告只对对应 Run 的候选 commit 有效。命令通过仍不代表全部验收条件通过。验证 worktree 不继承原 worktree 中未跟踪的 node_modules、venv 或数据；需要用户显式提供安装/验证脚本或可用的外部环境。验证子进程仍为已授权的本地进程，不是新安全沙箱，不提供硬资源隔离。

验证阶段目前仅支持本地；SSH Worker 仍只执行原附着式协议。远程持久队列、远程完整环境指纹、远程验证与集成未实现。

## 原子状态与事件

项目/任务的主要修改、Run 入队/开始/结束、启动时的失联隔离，将对应状态和事件写入同一个 SQLite 同步事务。Store 在 COMMIT 后才通知订阅者；ROLLBACK 会同时移除事件和业务写入。嵌套事务、异步事务回调被拒绝。

订阅者抛错不会撤销已经提交的状态；客户端通过持久游标重放恢复。重入事件写入经过发送队列，保留 seq 顺序。事件表就是持久回放依据，无新增消息中间件。尚无独立 outbox relay/投递确认机制，因此不能称为跨进程 exactly-once。

Run 转换表拒绝 queued → completed、终态重写等非法转换。重试创建新的 Run。RunOrphaned 后只允许人工对账转 failed；不能直接自动恢复成功。

仍需后续解决：Git 合并与 SQLite 记录间的崩溃窗口、所有节点/排队状态的完整领域事件、独立合并操作日志和对账；当前不宣称 Git 与数据库原子提交。

## 验收与后续顺序

新增测试涵盖事务回滚、事件写入失败、幂等重试、订阅者异常与重入顺序、依赖传递失效、过期审批拒绝、固定依赖提交、任务与上下文版本、prompt hash、验证改写源码、干净验证目录清理、状态机终态保护。

后续优先级：合并操作日志与恢复 → Provider/执行驱动解耦 → 分页与按需内容查询 → Focus/Work/Review 和浏览器交互验收。
