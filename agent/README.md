# Node Agent（运行审计）

只读的事件记录器：把每个任务实际命中的节点链路、识别/动作结果、失败原因写进日志。
**不改任务行为、不点击、不注入节点**。

## 它解决什么

“任务 status=3000，但什么都没领到” —— 以前只能靠肉眼看 GUI 状态。
现在可以直接翻 `logs/daily_YYYYMMDD.txt`，看这一次到底走了哪些节点：

```
[19:58:27–19:58:28] ✅ TWGDaily  成功 19.3s（节点 24 / 识别 21 / 动作 18）
  链路: TWGGateHome → TWGClickEntry → PClaimPoints → PLogPointReward → ...
```

如果链路里出现的是 `SLogSoldOut` 而不是领取节点，假成功一眼就能看出来。

## 用法

CLI 脚本默认自动挂载（`tools/run_task_override.js`、`tools/run_daily.js`）：

```bash
node tools/run_task_override.js TWGDaily '{}'
node tools/run_daily.js TWGDaily StudioStart PassStart
```

关闭审计：

```bash
OURNOTES_AGENT=0 node tools/run_daily.js TWGDaily
```

看某天的汇总：

```bash
node tools/agent_report.js            # 今天
node tools/agent_report.js 20261120   # 指定日期
```

自检（不需要模拟器）：

```bash
node tools/test_agent_offline.js
```

## 输出

| 文件 | 内容 |
|---|---|
| `logs/daily_YYYYMMDD.txt` | 人看的流水，一个任务一段（成功/失败、用时、链路、失败节点） |
| `logs/agent/runs_YYYYMMDD.jsonl` | 机器看的明细（每个节点的识别摘要、动作、耗时、失败列表） |

`logs/` 已在 `.gitignore` 中，不会进仓库或发行包。

## 接入方式（实现细节）

`agent/main.js` 由 MaaFramework 的 `AgentClient` 拉起，socket id 作为最后一个参数传入；
它注册两个 sink：

- `Tasker` sink：任务开始/成功/失败/取消
- `Context` sink：`PipelineNode.*`、`Recognition.*`、`Action.*`、`NextList.*`

`tools/agent_runtime.js` 负责创建 Client、注册 sink、连接 agent，并在任务结束后收尾。
连不上 agent 时自动降级（任务照常跑，只是不写审计），不会阻塞任务。

## 已知边界

- 只在 CLI 脚本里挂载；GUI（MFAAvalonia）目前没有启用（需要 `interface.json` 的 `agent` 配置，
  而且发行包没有自带 Node，贸然开启会让没装 Node 的用户启动失败）。
- 识别失败时，框架的 `Recognition.Failed` 事件里**不带 OCR 实际读到的文本**，
  流水只能给出算法名和重试次数；要看现场文字仍得靠 `debug/vision/` 截图。
- `PipelineNode.*` 通知里的 `name` 是**任务入口名**，真正的节点名在 `node_details.name` —— 写日志时必须取后者。
