# HealthKit 七天汇总与独立授权（生产迁移已应用）

新增 `health_steps_access` 与 `health_daily_steps`：typed日区间、步数/不可读状态；原始健康样本不上传。固定上海时间七天窗口，整个捕获批次重算覆盖，允许步数减少/删除变为null。每用户只保存最近一次七天捕获；读取/上传时清除超过八天的旧捕获，不是定时清理承诺。

`health-sync` 复用现有用户JWT验证与owner限制；service-only invoker `health_steps_gateway` 只授予service_role执行。表开启RLS，无anon/authenticated直读直写授权。App客户端没有服务端密钥。

- 默认local；cloud仅App云端；ai另行开放`read_health_steps`；paused停止上传及AI读取但保留App查看。
- consentVersion乐观锁与用户行锁串行化所有授权/上传，撤销后旧版本上传失败。local原子清空云端数据；重新授权也不会接受旧generation。
- 稳定sampleId、内容摘要与采集时间支持幂等，拒绝同ID不同内容，旧批次不覆盖新批次；同一批次中的所有日区间先校验再写。
- App与CLI均走同一读取函数，返回相同snapshot/dataVersion。AI工具每次重新检查mode，不缓存授权/健康结果；拒绝时snapshot=null。
- 旧device_status/快捷指令步数保持独立。微信、旧Mini设备快照不自动获得HealthKit数据，不能绕过新的AI授权。

## 部署顺序与验证

2026-10-17 已通过迁移接口应用 `20261017123650_health_steps_consent.sql`，远端SQL摘要与原候选20261017120246完全一致；文件名对齐实际迁移记录。两表RLS开启、anon/authenticated无表权限，gateway为service-only SECURITY INVOKER。随后合并/部署health-sync与hamster-mcp（main既有自动工作流只部署函数，不应用迁移）。最终部署版本与真实手机验收分别记录在正式交付回执。

迁移无既有表破坏性改动；回退时可停用新端点/移除新工具注册并保留健康授权表，不能回滚授权版本导致旧请求复活。真实数据清理由用户健康页显式撤销完成。

本地PGlite执行完整SQL，验证默认关闭、同版本读取、真实零/空值、乱序/幂等/更正/删除、撤销/重授权旧批次拒绝、账号隔离和客户端角色拒绝；HTTP测试验证JWT/owner/CORS/MCP-only action封锁。完整195测试、check及两个Deno入口通过。线上迁移/权限advisors、App与CLI真实读取和新iPhone包分别验收。
