# M2 数据库迁移脚手架

目标：在不影响现网 API 行为的前提下，为文件存储 -> 数据库迁移提供最小可执行路径。

## 已提供资产

1. 关系型 schema：db/schema.sql
2. 初始 migration：db/migrations/001_init.sql
3. 种子导出脚本：scripts/export-migration-seed.js
4. 导出命令：npm run db:seed-export

## 迁移分阶段

### Phase 1（当前）

- 不改线上 API。
- 继续以文件存储为主。
- 先通过导出脚本拿到统一 seed 数据：db/seed/bootstrap.json。

### Phase 2（双写）— 已实现 + 已验证

实现方式为**快照式双写**(非逐操作增量):每次 `writeCreditsState` 落盘后,
经 `creditsDualWriteQueue` 串行触发一次 `dualWriteCreditsSnapshot` —— 在单个
事务里清空 5 张 credits 表并按当前文件状态全量重插。admin 审计为追加写
(`dualWriteAdminAudit`)。覆盖的写操作因此自动包含:redeem、reserve/settle/
release、admin grant、batch create/revoke(它们都最终走 `writeCreditsState`)。

- 以 feature flag 控制:`DB_DUAL_WRITE=true` + `DATABASE_URL`(见 `.env.example`)。
- `pg` 为可选依赖;缺失或 DB 不可达时只记日志,**不阻塞文件主写**(已有测试覆盖)。
- **UUID 守卫**:ledger 的 `job_id` 可能是非 UUID 的 Replicate prediction id,
  经 `asUuidOrNull` 降级为 `null`,避免单条坏值导致整个快照事务回滚。
- **对账闸门**:`npm run db:reconcile` 比对文件 vs DB 的账户余额汇总、ledger
  行数、批次数、已兑换/已撤销数;全项一致(exit 0)才可进入 Phase 3。

启用顺序:先在 staging 起 Postgres → `psql -f db/schema.sql` → 开双写 →
跑 `db:reconcile` 全绿 → 再在生产开 `DB_DUAL_WRITE=true`(随时可关)。

### Phase 3（读切换）

- **Phase 3a — 已实现 + 已激活 + 已验证**:admin overview 的 credits 聚合
  (users/wallets/ledger/batches/codes 计数与余额汇总)改从 DB 读。
  - flag `DB_READ_CREDITS_OVERVIEW=true`(独立于双写,默认关,随时可关回退)。
  - `buildAdminOverview()` 同步零改动;新增 `applyDbCreditsOverview()` 用
    reconcile 同款 SQL 覆盖数值并标 `credits.source='db'`;任何失败保留文件值、
    标 `source='file'|'file-fallback'`、打日志,绝不抛错(文件即回滚兜底)。
  - 生产已验证 `source=db` 且 9 项数值与文件逐项一致。
- **Phase 3b — 暂缓(按设计)**:redemption-batches/redemption-codes 列表端点
  返回整行,DB 读须**逐字段复刻**文件序列化(timestamptz 格式、code_stats
  GROUP BY、`code_preview` 脱敏)。这类**静默序列化漂移**正是 error-only
  fallback 抓不到的;且端点仅 admin、非热路径,价值低。收益<风险,暂不切。
- 其余 admin 端点(metrics/audit-logs/email-users/api-customers*)读取**未镜像**
  的数据(运行时计数、文件日志、email-auth、api_customers/api_keys),不可切。

### Phase 4（收口)— 需决策,未实施

> ⚠️ 架构级、难回退、涉及金额(credit ledger)。即使在"直接切换"授权下也应先确认方案。

- 关闭文件主写、DB 成为权威源。**真实成本**:14 处 `withLock`+`writeState` 的
  read-modify-write 写路径须改为 DB 事务等价物(含 reserve/settle/release/redeem/
  grant/batch),并保证幂等与并发正确性。
- 前置:DB 写须从"best-effort 双写(`.catch` 吞错)"升级为"写失败即报错",
  否则 DB 落后于文件时读 DB 会取到陈旧数据。
- 保留导出回滚工具;只保留必要本地缓存文件。

## 发布就绪状态(pre-launch)

当前已是**可发布**形态:文件为权威主存储(经实战验证)、DB 为已验证影子、
admin overview 读 DB。双写失败不阻塞文件主路径,读切换失败回退文件值。
Phase 3b / Phase 4 均为**发布后可选的收口**,非发布阻塞项。


## 表映射建议

- users <- credits.users
- wallets <- credits.accounts
- credit_ledger <- credits.credit_ledger
- redemption_batches <- credits.redemption_batches
- redemption_codes <- credits.redemption_codes
- generation_jobs <- storage/jobs.json
- admin_audit_logs <- storage/admin-audit.log

## 上线核对点

1. 主键/唯一约束完整（code_hash、user_token_hash）。
2. ledger 保证幂等写入策略（reservation_id + type 约束可选）。
3. 导入后对账：
- 账户余额汇总一致
- 批次统计一致
- 已兑换/已撤销数量一致

## 执行示例

```bash
# 1) 导出当前文件状态为迁移种子
npm run db:seed-export

# 2) 在目标数据库执行 schema（示例）
# psql "$DATABASE_URL" -f db/schema.sql

# 3) 基于 db/seed/bootstrap.json 编写一次性导入脚本
```
