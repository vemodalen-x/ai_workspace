# 原工作目录改动审查（2026-11-20）

本次审查并提交 `/home/aimer/Project/WorkPlace/ai_workspace` 中原先未提交的源码，基于 `69edb96`，分支 `fix/review-local-workspace-changes`。此前在另一个工作副本提交的 `fix/workspace-usability-review` 是独立分支；本提交不表示这些分支已合并到 main，也不改变常驻服务的发布版本。

范围：中英文 UI、只读关联本地 Claude 会话、模型与 Codex 推理强度选择及 SSH worker 传递、任务重跑与删除确认、按 Run 提取执行摘要、GPU 按服务器分组、相关 API/测试/文档。IDE 本机配置 `.idea/` 加入忽略规则。

审查修复：原生摘要读取使用打开后的文件句柄核对类型与 inode，拒绝符号链接及路径替换，保留 32 MiB 读取限制；命令提取同时支持 `cmd` 和 `command`。新增回归覆盖符号链接与 `cmd` 提取。当前 Claude 别名通过本机 `claude --help` 核实，未因旧版本经验修改为其他别名。

验证：`npm run check`（类型、lint、单元/集成测试、生产构建）、`npm run test:production`，以及隔离 provider home 下全部 23 项 Playwright 用例。模型选择测试拦截付费执行请求；其通过不代表真实模型推理成功。

未覆盖：真实付费 Provider 推理、远端 Mac 实际执行、系统重启恢复、Safari/Firefox 与屏幕阅读器。原工作目录分支与已部署服务分支尚未整合；后续合并需保留双方功能并重新验证。
