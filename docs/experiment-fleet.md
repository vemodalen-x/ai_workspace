# v0.4 实验与 GPU 监控

## 以一次分割实验为例

Windows 笔记本可作为控制端，两台 Linux GPU 主机分别配置 SSH 别名。每台主机安装同版 Worker；监控本身不需要 Codex、Claude 登录，也不会启动训练。先在每台主机用 `nvidia-smi -L` 确认硬件和 UUID，再在 **Compute nodes → Add SSH node** 添加服务器。SSH 用户、密钥与 known_hosts 仍由系统 OpenSSH 管理；不要把私钥复制到应用配置。

1. 在 Compute fleet 找到两台服务器的最新接收时间、逐卡显存和现有预算。`Unavailable` 不等于零；`offline` / `stale` 的旧读数不能作为调度依据。
2. 为两个消融任务勾选 **Track as an AI experiment**，使用相同的实验组、数据集清单版本和 seed。只改变一个参数，例如 `precision`。如果要比较速度，尽量选同型号 GPU，并记录批量大小和软件环境。
3. 为每个任务指定节点，复制所需物理卡的 `GPU-…` UUID，填写软显存预算。在远程节点运行时填好远程仓库路径；代码工作流仍需独立启动确认。任务配置只是实验意图，训练程序负责应用参数与 seed。
4. 展开 **Compare experiment runs**，对照输入提交、seed、数据版本和设备。展开 **Experiment & hardware observations** 查看该次运行期间的有效样本数、平均 GPU 利用率、观测到的显存/温度峰值。没有对应样本或字段时显示缺失，不补零。不同数据版本、不同代码或不同硬件应当作为混杂因素审查。
5. 某卡显存高但利用率低时，展开 **GPU compute processes** 对照 PID 和显存，再检查训练端的 step time、数据加载、同步或外部作业。这些读数可以提出瓶颈假设，不能单独证明瓶颈所在。

## 采集和保留策略

- 每个指标带单位。显存底层字段 `usedMb/totalMb` 实际单位是 MiB，界面使用 GiB。功耗为瞬时/驱动报告的 W，不推算能耗、成本或单实验电费。
- `nvidia-smi` 分别查询物理设备与计算进程。设备查询保留部分字段为 N/A 的卡；进程查询失败不影响设备统计。未安装驱动、GPU 不可见或平台不支持某指标时显示不可用。
- GPU 标识是 `(nodeId, GPU UUID)`。每台物理机只注册一次；相同 SSH 别名会被拒绝，指向同一物理机的不同别名不会被自动识别。兼容用户输入枚举 index，在预留时解析并保存实际 UUID；Agent 和显式授权的本地验证命令使用对应 `CUDA_VISIBLE_DEVICES`。这不是容器或设备访问控制。
- 物理显存 admission 使用 `已观察 used + 现存软预留 + 新请求 <= total`。外部训练程序无法被阻止；为了不把外部 GPU 占用误判为应用自己的预算，策略可能双算已兑现的预留。每 Run 仅预留一张 GPU，**多 GPU 监控不等于 DDP 启动或多卡原子预留**。
- 本地采样约 3 秒一次。远端即使没有 Run 也会采样；成功后至少间隔 15 秒，SSH 检查最多并行 2 个，同节点检查复用在途请求，20 秒超时，失败后 30 / 60 / 120 秒退避。节点较多或连接慢时实际间隔更长。v0.4 控制端负责采集，运行中的 v0.4 Worker 不为每个并发 Run 重复轮询硬件。
- 接收时间由控制端生成；远端设备时钟保留为 `at`。超过 45 秒视为 stale。GPU 或 SSH 执行缺少新鲜样本时不启动；失联不意味着释放运行中的预算。
- SQLite 每节点每 10 秒最多记录一次，总量最多 2160 个样本（连续以 10 秒采样约覆盖最近 6 小时，较稀疏时更长）。历史不保留 PID 列表，不写进全局生命周期事件。UI 按需加载最近 120 个样本；>45 秒的空档不会连线。重启后历史可读，在线状态须重新探测。
- Run 窗口仅用服务端开始/结束时间、节点和冻结 GPU 标识查询留存样本。利用率为有效读数的算术平均，显存峰值是采样点最大值，不等于 CUDA allocator 峰值。没有独占证据时不能归因于单一进程。短实验可能没有样本；长期实验的早期历史可能已过期。

## 在自己的设备上做只读验收

在控制端仓库根目录：

```bash
npm ci
npm run check:fleet
npm run dev
```

`check:fleet` 只查询本地 CPU/RAM/GPU，不调用模型。要一次验收多台机器，先按 [remote-worker.md](remote-worker.md) 部署 v0.4 Worker，创建 `fleet.local.json`（已忽略，不提交）：

```json
[
  {
    "name": "Training A",
    "sshAlias": "train-a",
    "workerPath": "/srv/ai-agent-workspace/worker-bootstrap.mjs",
    "cpu": 8,
    "ramMb": 16384,
    "minGpus": 2
  },
  {
    "name": "Evaluation B",
    "sshAlias": "eval-b",
    "workerPath": "/srv/ai-agent-workspace/worker-bootstrap.mjs",
    "cpu": 4,
    "ramMb": 8192,
    "minGpus": 1
  }
]
```

```bash
npm run check:fleet -- fleet.local.json
```

上述为配置示例，替换为真实 SSH 别名、安装路径与预期卡数。工具不会添加节点、修改主机或运行任务。输出每节点的实测 JSON；超时、样本不合法或少于 `minGpus` 时退出非零。再启动 Web 并注册节点，可验证持续采集：对照 `nvidia-smi`，暂停一台测试主机的连接，检查离线提示、历史空档及恢复后新时间戳。请勿为了测试而断开真实作业所在节点。

## 边界与扩展依据

本版不收集训练 Loss/mIoU、step time、NCCL 链路、MIG 实例或每进程 GPU 利用率；不做 DDP/Slurm 调度、自动驱逐或强制限额。GPU PID 来自计算进程列表，不代表图形进程或所有驱动占用。显存/热量不能用来判断模型质量。数据版本和种子是声明值，尚不自动验证数据内容摘要或库版本一致。

- [NVIDIA System Management Interface](https://docs.nvidia.com/deploy/nvidia-smi/index.html)：UUID/PCI ID 比枚举顺序稳定，不支持字段可能返回 N/A。CLI 输出跨驱动不承诺向后兼容；收敛到稳定 NVML 采集器是长期方向。
- [NVIDIA DCGM Exporter](https://docs.nvidia.com/datacenter/cloud-native/gpu-telemetry/latest/dcgm-exporter.html)：大型集群可引入 DCGM/Prometheus 作为另一种数据源。当前实现不依赖它们，也不对公网暴露监控端点。
- [MLflow Tracking](https://mlflow.org/docs/latest/ml/tracking/)：实验组与 Run 的区分，记录参数、代码、指标和产物。本版借用组织思路，未集成 MLflow。后续应将训练代码上报的 `step, metric, value, datasetVersion` 与硬件采样分表关联，先补齐可解释的实验对比，再扩充调度器。
