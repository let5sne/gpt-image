-- Image Studio relational schema (M2 scaffold)
-- Target: PostgreSQL 14+

create table if not exists users (
  id uuid primary key,
  -- nullable: API-customer-backed users authenticate via API keys, not a token hash
  user_token_hash text unique,
  -- back-pointer to the API customer this user backs (null for token/redeem users)
  api_customer_id uuid,
  status text not null default 'active',
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists wallets (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  available_credits integer not null default 0,
  reserved_credits integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (user_id)
);

create table if not exists credit_ledger (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  credits_delta integer not null,
  available_after integer not null,
  reserved_after integer not null,
  reservation_id uuid,
  redemption_code_id uuid,
  -- file-side ledger job_id: usually a reservation UUID, but may be a non-UUID
  -- Replicate prediction id — store verbatim as text for lossless round-trip.
  job_id text,
  note text,
  created_at timestamptz not null
);
create index if not exists idx_credit_ledger_user_created on credit_ledger(user_id, created_at desc);
create index if not exists idx_credit_ledger_reservation on credit_ledger(reservation_id);

create table if not exists redemption_batches (
  id uuid primary key,
  name text not null,
  credits_per_code integer not null,
  code_count integer not null,
  expires_at timestamptz,
  created_at timestamptz not null
);

create table if not exists redemption_codes (
  id uuid primary key,
  batch_id uuid not null references redemption_batches(id) on delete cascade,
  code_hash text not null unique,
  code_hint text,
  credits integer not null,
  status text not null,
  redeemed_by_user_id uuid references users(id),
  redeemed_at timestamptz,
  revoked_at timestamptz,
  revoked_note text,
  expires_at timestamptz,
  created_at timestamptz not null
);
create index if not exists idx_redemption_codes_batch on redemption_codes(batch_id);
create index if not exists idx_redemption_codes_status on redemption_codes(status);

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

create table if not exists generation_jobs (
  id uuid primary key,
  prediction_id text,
  status text not null,
  prompt text,
  size text,
  request_id text,
  created_at timestamptz,
  updated_at timestamptz,
  payload jsonb not null default '{}'::jsonb
);
create index if not exists idx_generation_jobs_status on generation_jobs(status);

create table if not exists admin_audit_logs (
  id bigserial primary key,
  ts timestamptz not null,
  action text not null,
  request_id text,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists idx_admin_audit_logs_ts on admin_audit_logs(ts desc);
create index if not exists idx_admin_audit_logs_action on admin_audit_logs(action);
