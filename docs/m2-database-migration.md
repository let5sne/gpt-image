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

### Phase 2（双写）

- 为关键写操作增加双写（文件 + DB）：
  - redeem
  - reserve/settle/release
  - admin grant
  - batch create/revoke
- 以 feature flag 控制：DB_DUAL_WRITE=true。

### Phase 3（读切换）

- 先切 admin 只读查询到 DB（overview/metrics）。
- 再切 wallet 和 redemption 查询到 DB。
- 文件作为短期回滚兜底。

### Phase 4（收口）

- 关闭文件主写。
- 保留导出回滚工具。
- 只保留必要本地缓存文件。

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
