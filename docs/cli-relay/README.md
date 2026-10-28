# Claude 接力自由活动候选

Claude 可由 `daily` 切为 `relay`；迁移默认仍为 daily，Codex 不支持切换。接力 09:00–21:00，下一轮默认在本轮结束后的调度 tick 随机 10–60 分钟；固定任务/另一 CLI 占位时顺延到安全时间。最多 30 个实际开跑轮次，单轮 30 分钟，最晚 21:30。聊天跳过，不补跑漏掉的时刻。当天收工决定在当日持续生效。

议事厅依据：主提案 `4d2861c1-a983-42d3-b58e-1591e883a0dc`，补充 `d907651e-1632-4a2d-8ee8-89355554ac9a`。本候选未启用线上接力。

## 发布顺序

1. 合并三仓候选后，应用 `20261028065757_cli_relay_activity.sql`；模式仍 daily。
2. 部署 `hamster-mcp` 和 `hamster-lounge-mcp`，只读 `tools/list` 确认新参数与 `append_relay_diary`。
3. Mini 空闲时部署配套代码并重启；先查正在运行的任务，尤其今天 15:24 的 Claude 每日自由活动，不中断它。保留现场环境、未提交的常驻补丁和与本次无关的文件。
4. 发布 App 仓 `docs/cli-relay/` 三份云端说明，逐份核对 baseline ID/version/md5，使用现有 append-only 发布 RPC；同一事务发布。固定任务 Feed SOP 不改。
5. 确认新 Mini 的独立 dispatch tick 心跳及当前空闲，再以 service role 调用 `cli_activity_set_mode(owner,'relay')`。它原子取消 Claude 未执行的 random/alarm 与相应命令；已经运行的活动保留到结束，不再补当天旧槽。
6. 仅替换置顶 Memo `97295a96-946b-4425-993c-bea1c2eda303` 的自由活动那一行。原文 md5 `5c288e11f16fd1fb9b672fa5987f1517`，若变化先重读；新行：`• 自由活动：Claude CLI 接力09:00–21:00，每轮≤30分钟；Codex每天13:00–19:00一槽。Claude日记一天一篇按轮追加，有行动分享到私聊；Codex回执仍按轮。`
7. schema 应用后通过平台重新生成两仓数据库类型，不手改生成文件；App OTA 是独立授权与验收项。

回滚：调用 `cli_activity_set_mode(owner,'daily')`；全部未执行 relay 行及命令被取消，正在进行的一轮自然结束，tick 不再续链。保留历史与当前日记，不删除数据、不把漏跑槽补执行。次日恢复每日随机计划；不重新激活今天已取消的旧 random。

## 实现边界

- 模型决定先存在当前轮 `next_wake_at/next_note/close_day`，由 tick 续链；到时重新校验，过期或不再满足结束后 10 分钟的决定退回随机。
- 分享按 wake_id 锁定，只插一次真实 assistant 消息和一个普通 push 事件；发送链路沿用现有 push-dispatch，横幅实机验收另记。无行动不发。
- 不预热生成回复；下一条真实私聊读取 canonical 分享。已有热会话正常增量接入，历史变化则按原规则冷启动。
- 日记按天判缺失；每轮摘要独立判缺失。首次 metadata.task_id 保留，segments 保存各轮身份；追加不触发 insert 通知。当天页已 shared 时追加须显式 allow_shared。
- App 仅 owner SELECT，模式开关及所有写 RPC 仅 service role；私聊只写固定 Claude singleton，不接受调用者指定角色或会话。
- 试运行 1–2 周，使用下方 SQL 手动查看指标；未创建新的监控任务。

本地验证使用 PGlite 执行真实 migration。Mini 的只读候选资料实测 12622 字符；不等于自然 token/缓存账单。自然调度、私聊接话、横幅跳转、手机状态页仍待发布后验收。
