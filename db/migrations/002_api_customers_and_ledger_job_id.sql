-- 002_api_customers_and_ledger_job_id.sql
-- Phase 4 Stage B:补齐 DB 镜像缺口,使 7 个文件集合全部可镜像 / 可无损反向读。
--   1) api_customers / api_keys 两张此前无表的集合(客户 API/v1 子系统)。
--   2) credit_ledger.job_id —— 文件态 ledger 用 job_id(可能是 Replicate 预测 id,
--      非 UUID),此前被挤进 reservation_id 且经 UUID 守卫降级为 NULL,有损。
--   3) users.api_customer_id —— 反查 user→customer,此前未持久化。
-- 全部 idempotent:可在已有库上重复执行。

alter table credit_ledger add column if not exists job_id text;

alter table users add column if not exists api_customer_id uuid;

create table if not exists api_customers (
  id uuid primary key,
  name text not null,
  contact text,
  status text not null default 'active',
  note text,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index if not exists idx_api_customers_user on api_customers(user_id);

create table if not exists api_keys (
  id uuid primary key,
  customer_id uuid not null references api_customers(id) on delete cascade,
  key_hash text not null unique,
  key_prefix text,
  status text not null default 'active',
  expires_at timestamptz,
  note text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null
);
create index if not exists idx_api_keys_customer on api_keys(customer_id);
create index if not exists idx_api_keys_status on api_keys(status);
