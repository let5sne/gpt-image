# 兑换码 + Credits 商业化需求分析

## 1. 背景

当前 Image Studio 已具备图片生成、Access Token 鉴权、本地存储、画廊、OpenAI-compatible provider 和 Replicate provider 接入能力。下一步目标是建立最小可运营的商业闭环：

- 用户通过兑换码充值 credits。
- 用户每次生成图片消耗 credits。
- 管理员可批量生成、发放、追踪兑换码。
- 系统能对生成成本、收入和毛利做基础核算。

本阶段不直接接入支付网关。第一版通过人工收款后发放兑换码完成商业验证。

## 2. Replicate 成本基准

参考当前 Replicate `openai/gpt-image-2` 页面价格：

- `low`: `$0.012` / output image
- `medium`: `$0.047` / output image
- `auto`: `$0.128` / output image
- `high`: `$0.128` / output image

注意：

- 这里是每张输出图片成本，不是每次请求成本。
- 用户一次请求如果生成多张，应按张数乘以单张价格。
- Replicate 价格可能变化，应把成本配置化，不要写死在业务代码中。
- 失败、取消、超时是否产生真实费用，以 Replicate 实际账单为准；我们系统需要具备退款或人工调整能力。

## 3. Credits 定价原则

建议定义：

- `1 credit = 0.01 USD` 的内部面值。
- 面向用户售卖时按人民币套餐定价，留出汇率、通道费、失败重试、促销和利润空间。
- 生成扣费按 credits 消耗，不直接向用户展示美元成本。

推荐第一版扣费规则：

- `low`: 3 credits / 张
- `medium`: 8 credits / 张
- `auto`: 20 credits / 张
- `high`: 20 credits / 张

对应毛利估算：

- `low`: 成本 1.2 credits，扣 3 credits，毛利约 60%。
- `medium`: 成本 4.7 credits，扣 8 credits，毛利约 41%。
- `auto/high`: 成本 12.8 credits，扣 20 credits，毛利约 36%。

如果采用人民币售卖，建议首批套餐：

- 体验包：`¥9.9 = 100 credits`
- 标准包：`¥29 = 320 credits`
- 专业包：`¥99 = 1200 credits`

这些套餐实际含促销折扣，后续可按真实转化率和成本调整。

## 4. 核心用户故事

### 4.1 用户兑换

作为用户，我可以输入兑换码，系统给我的浏览器身份或账号增加 credits，并显示余额。

验收标准：

- 兑换码正确且未使用时，余额增加。
- 同一个兑换码不能重复兑换。
- 过期、撤销、已兑换的码返回明确错误。
- 兑换成功后返回最新余额和本次增加额度。

### 4.2 用户生成图片

作为用户，我生成图片前能看到预计消耗 credits，生成时系统自动扣减。

验收标准：

- 余额不足时不能创建生成任务。
- 生成任务创建时先冻结 credits。
- 生成成功后冻结额度转为正式扣费。
- 生成失败、取消或系统超时后释放冻结额度。
- 如果供应商已产生费用但系统未得到图片，支持人工补偿或部分扣费。

### 4.3 用户查看余额与流水

作为用户，我可以看到当前 credits 余额和最近流水。

验收标准：

- 显示可用余额、冻结余额、总余额。
- 显示最近兑换、冻结、扣费、退款记录。
- 用户只能看到自己的记录。

### 4.4 管理员生成兑换码

作为管理员，我可以批量生成兑换码，用于人工售卖或活动发放。

验收标准：

- 可配置批次数量、每码 credits、过期时间、备注。
- 生成后只能查看一次明文兑换码。
- 数据库只保存兑换码 hash。
- 可导出 CSV 用于发放。

### 4.5 管理员追踪和对账

作为管理员，我可以查看兑换码使用情况、用户余额、生成成本和毛利。

验收标准：

- 按批次查看已兑换数量、未兑换数量、撤销数量。
- 按用户查看余额和流水。
- 按日期统计 credits 收入、credits 消耗、生成张数、供应商成本估算。

## 5. 身份设计

第一版建议使用轻量身份：

- 用户首次兑换时，如果没有用户 token，则后端生成 `user_token` 返回给前端。
- 前端把 `user_token` 存入 localStorage。
- 后续请求通过 `x-user-token` 传递。
- 服务器只保存 token hash。

后续升级：

- 支持邮箱登录、微信登录或 magic link。
- 允许把匿名 token 余额迁移到正式账号。

风险：

- localStorage 丢失会导致匿名余额不可找回。
- 第一版需要在页面明确提示用户保存或绑定账号。

## 6. 数据模型

建议新增 SQLite 或 Postgres。不要继续用 `metadata.json` 承载交易账本。

### 6.1 users

- `id`
- `user_token_hash`
- `status`: `active` / `blocked`
- `created_at`
- `updated_at`

### 6.2 credit_accounts

- `id`
- `user_id`
- `available_credits`
- `reserved_credits`
- `created_at`
- `updated_at`

### 6.3 credit_ledger

- `id`
- `user_id`
- `type`: `redeem` / `reserve` / `settle` / `release` / `refund` / `admin_adjust`
- `credits_delta`
- `available_after`
- `reserved_after`
- `job_id`
- `redemption_code_id`
- `note`
- `created_at`

说明：

- 所有余额变化必须写 ledger。
- `available_credits` 和 `reserved_credits` 是快照，ledger 是审计依据。

### 6.4 redemption_batches

- `id`
- `name`
- `credits_per_code`
- `code_count`
- `expires_at`
- `created_by`
- `created_at`

### 6.5 redemption_codes

- `id`
- `batch_id`
- `code_hash`
- `credits`
- `status`: `active` / `redeemed` / `revoked` / `expired`
- `redeemed_by_user_id`
- `redeemed_at`
- `expires_at`
- `created_at`

### 6.6 generation_jobs

- `id`
- `user_id`
- `provider`: `replicate` / `openai`
- `provider_job_id`
- `model`
- `quality`
- `size`
- `aspect_ratio`
- `n`
- `prompt_hash`
- `estimated_credits`
- `reserved_credits`
- `charged_credits`
- `status`: `created` / `running` / `succeeded` / `failed` / `canceled` / `timed_out`
- `error`
- `created_at`
- `completed_at`

### 6.7 pricing_rules

- `id`
- `provider`
- `model`
- `quality`
- `credits_per_image`
- `cost_usd_per_image`
- `enabled`
- `created_at`
- `updated_at`

第一版也可以用环境变量或 JSON 配置，但数据库表更利于后台调价和审计。

## 7. API 设计

### 7.1 用户接口

#### POST `/api/redeem`

请求：

```json
{
  "code": "ABCD-EFGH-IJKL",
  "user_token": "optional-existing-user-token"
}
```

响应：

```json
{
  "success": true,
  "data": {
    "user_token": "new-or-existing-token",
    "credits_added": 100,
    "available_credits": 100,
    "reserved_credits": 0
  },
  "request_id": "uuid"
}
```

#### GET `/api/wallet`

请求头：

- `x-user-token: <token>`

响应：

```json
{
  "success": true,
  "data": {
    "available_credits": 100,
    "reserved_credits": 0,
    "recent_ledger": []
  },
  "request_id": "uuid"
}
```

#### POST `/api/generate`

新增行为：

- 读取 `x-user-token`。
- 计算本次预计消耗。
- 余额不足时返回 `402 insufficient_credits`。
- 创建 job 前冻结 credits。
- job 完成后结算或释放。

#### GET `/api/jobs/:id`

新增字段：

```json
{
  "status": "succeeded",
  "estimated_credits": 20,
  "charged_credits": 20,
  "available_credits": 80,
  "reserved_credits": 0
}
```

### 7.2 管理接口

第一版可先通过 CLI 脚本生成兑换码，管理 API 后置。

推荐后续 API：

- `POST /api/admin/redemption-batches`
- `GET /api/admin/redemption-batches`
- `GET /api/admin/redemption-codes`
- `POST /api/admin/redemption-codes/:id/revoke`
- `GET /api/admin/users/:id/ledger`
- `POST /api/admin/users/:id/adjust-credits`

管理接口必须使用 Cloudflare Access 或独立管理员 token，不复用用户 token。

## 8. 扣费状态机

### 8.1 创建任务

1. 校验用户 token。
2. 校验 prompt、size、quality。
3. 计算 `estimated_credits = credits_per_image * n`。
4. 如果 `available_credits < estimated_credits`，返回 402。
5. 写 `credit_ledger.reserve`：
   - available 减少
   - reserved 增加
6. 创建 `generation_jobs`。
7. 调用 provider 创建任务。

### 8.2 成功

1. provider 返回图片。
2. 保存图片到本地或对象存储。
3. 写 `credit_ledger.settle`：
   - reserved 减少
   - charged 确认
4. job 状态变成 `succeeded`。

### 8.3 失败

1. provider 返回失败、取消或系统超时。
2. 写 `credit_ledger.release`：
   - reserved 减少
   - available 增加
3. job 状态变成 `failed` / `timed_out`。

### 8.4 异常人工处理

如果供应商实际收费但用户没拿到图片：

- 默认第一版仍先退款给用户，保证体验。
- 管理员可在后台标记该 job 为 `provider_charged_without_output`。
- 成本统计里单独归类为损耗。

## 9. 前端需求

### 9.1 兑换区

新增：

- 兑换码输入框。
- “兑换”按钮。
- 兑换成功提示。
- 当前余额展示。

### 9.2 生成区

新增：

- 模型质量选择：`low` / `medium` / `auto` / `high`。
- 本次预计消耗 credits。
- 余额不足时按钮禁用或提示去兑换。

### 9.3 任务状态

Replicate 异步任务继续使用现有轮询体验：

- `starting`
- `processing`
- `succeeded`
- `failed`
- `timed_out`

同时展示已冻结 credits，避免用户以为重复点击不会扣费。

## 10. 安全与风控

必须实现：

- 兑换码明文只展示一次。
- 数据库保存 `code_hash`，使用 SHA-256 + server-side pepper。
- 用户 token 保存 hash，不存明文。
- 兑换接口限流：按 IP 和 token 限制。
- 兑换码错误次数过多时短暂封禁。
- 兑换操作必须事务化，避免并发重复兑换。
- 生成任务必须限制用户并发数，例如每用户最多 1-2 个 running job。
- 管理接口走 Cloudflare Access。

建议实现：

- 批次级撤销。
- 用户黑名单。
- prompt hash 记录，不直接在财务表里存完整 prompt。
- 重要操作写审计日志。

## 11. 配置建议

新增环境变量：

```env
CREDITS_ENABLED=true
CREDIT_CODE_PEPPER=replace-with-random-secret
DEFAULT_FREE_CREDITS=0
MAX_RUNNING_JOBS_PER_USER=1

CREDIT_COST_REPLICATE_GPT_IMAGE_2_LOW=3
CREDIT_COST_REPLICATE_GPT_IMAGE_2_MEDIUM=8
CREDIT_COST_REPLICATE_GPT_IMAGE_2_AUTO=20
CREDIT_COST_REPLICATE_GPT_IMAGE_2_HIGH=20
```

如果第一版还没有账号体系：

```env
ANONYMOUS_WALLET_ENABLED=true
```

## 12. 实施阶段

### Phase 1：最小可售卖闭环

- SQLite/Postgres 初始化。
- users / credit_accounts / credit_ledger。
- redemption_batches / redemption_codes。
- CLI 生成兑换码。
- `/api/redeem`。
- `/api/wallet`。
- `/api/generate` 扣费接入。
- `/api/jobs/:id` 返回扣费状态。
- 前端余额、兑换码、预计消耗展示。

验收：

- 管理员能生成一批兑换码。
- 用户能兑换 credits。
- 用户能用 credits 生成图片。
- 成功扣费，失败退款。
- 余额不足不能生成。

### Phase 2：后台管理

- 管理页面或 admin API。
- 查看批次、码状态、用户流水。
- 人工调整 credits。
- 成本和毛利日报。

### Phase 3：自动支付

- 接支付渠道。
- 支付成功自动发 credits。
- 发票、退款、订单对账。

## 13. 未决问题

- 第一版数据库选 SQLite 还是 Postgres？
- 匿名钱包是否允许长期保存，还是强制绑定邮箱？
- 用户是否可选择 `low/medium/auto/high`，还是只开放 `auto`？
- 对失败但供应商已收费的请求，是否永远退款给用户？
- 兑换码是否需要渠道字段，用于统计推广来源？

## 14. 推荐第一版决策

- 数据库：SQLite 起步，后续迁移 Postgres。
- 身份：匿名 `x-user-token` 起步，兑换成功后自动生成。
- 质量：先开放 `low`、`medium`、`auto`，隐藏 `high`。
- 扣费：创建任务冻结，成功结算，失败全额释放。
- 售卖：人工收款发兑换码。
- 管理：先做 CLI 生成兑换码，不做管理页面。

