# Image Studio · 极简 AI 图片创作站点

一个跑通核心创作链路的 MVP：用户输入 prompt → 后端代理 AI 接口 → 返回图片。

## 技术栈

- **后端**：Node.js (≥ 18) + Express，仅 1 个核心接口 `/api/generate`
- **前端**：单文件原生 HTML/CSS/JS，零构建
- **配置**：`.env` 管理 API Key

## 多供应商切换（通过 .env）

通过 `IMAGE_PROVIDER` 切换供应商：

- `replicate`：走 Replicate 异步任务
- `openai` / `openai-compatible` / `openrouter` / `siliconflow` / `together` / `minimax` / `doubao` / `volcengine`：走 OpenAI 兼容接口

OpenAI 兼容供应商读取规则：

1. 优先读取供应商前缀变量：`<PROVIDER>_IMAGE_API_BASE|KEY|MODEL|BYPASS_SECRET`
2. 如果前缀变量未配置，则回退到通用：`IMAGE_API_BASE|KEY|MODEL|BYPASS_SECRET`

示例：

```bash
IMAGE_PROVIDER=openrouter
OPENROUTER_IMAGE_API_BASE=https://openrouter.ai/api
OPENROUTER_IMAGE_API_KEY=sk-or-xxx
OPENROUTER_IMAGE_API_MODEL=openai/gpt-image-2
```

## 当前已落地的生产保护

- 接口鉴权：`AUTH_REQUIRED=true` 时，`/api/generate` 需要 `x-app-token` 或 `Authorization: Bearer <token>`。
- 速率限制：默认每分钟每客户端最多 12 次生图请求。
- 日额度限制：默认每客户端每天最多 40 次请求。
- 输入与成本保护：限制 prompt 长度、图片尺寸白名单、像素上限、单次图片数量上限。
- 统一错误响应：API 返回统一结构，便于前端和日志排查。
- 请求观测：每个请求带 `x-request-id`，服务端日志记录关键状态。
- 图片存储可切换：默认本地 `/storage`，生产可配置 S3-compatible 对象存储。
- 运营只读概览：配置 `ADMIN_TOKEN` 后可查看 gallery、jobs、credits 的脱敏统计。
- CI 基线：已新增 GitHub Actions，在 push/PR 时运行 `npm test`。

## 目录

```
image/
├── server.js           # Express 后端（仅代理生图接口）
├── public/
│   └── index.html      # 创作页面
├── package.json
├── .env                # 真实密钥（已 gitignore）
├── .env.example        # 配置模板
└── README.md
```

## M2 数据库迁移脚手架

当前仓库已提供数据库迁移脚手架（不影响现有文件存储主流程）：

- `db/schema.sql`：关系型表结构（PostgreSQL）
- `db/migrations/001_init.sql`：初始化 migration
- `scripts/export-migration-seed.js`：从 `storage/*` 导出统一 seed

导出迁移 seed：

```bash
npm run db:seed-export
```

导出结果会写入：`db/seed/bootstrap.json`。

完整迁移分阶段说明见：`docs/m2-database-migration.md`。

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 确认 .env 已配置（已经预填了测试 Key）
#    IMAGE_API_BASE / IMAGE_API_KEY / IMAGE_API_MODEL / PORT

# 3. 启动
npm start
# 或开发模式（保存自动重启，需 Node ≥ 18.11）
npm run dev

# 4. 运行测试
npm test
```

打开 http://localhost:3000 即可使用。

## 部署到 Vercel

### 1. 安装并登录 Vercel CLI

```bash
npm i -g vercel
vercel login
```

### 2. 首次部署

在项目根目录执行：

```bash
vercel
```

按提示选择：

- Set up and deploy: `Y`
- Link to existing project: `N`（首次通常选 N）

### 3. 配置环境变量

在 Vercel Project Settings -> Environment Variables 中添加：

- `IMAGE_API_BASE`
- `IMAGE_API_KEY`
- `IMAGE_API_MODEL`（可选）
- `AUTH_REQUIRED`（生产建议 `true`）
- `APP_ACCESS_TOKEN`（当 `AUTH_REQUIRED=true` 时必填）

配置后重新部署：

```bash
vercel --prod
```

### 4. 说明

- 项目已包含 `vercel.json`，会把 `server.js` 作为 Node Serverless Function 运行。
- Vercel 模式下为无状态代理：`/api/generate` 直接返回上游图片 URL，不做本地落盘。
- 因为无状态，`/api/gallery` 在 Vercel 上返回空数组；本地开发模式才会写入 `storage/metadata.json`。
- 若要线上保留画廊，建议接入 OSS/S3 + 数据库（或 Vercel Blob + KV）。

## 运营只读概览

配置独立后台 token：

```bash
ADMIN_TOKEN=replace-with-a-different-strong-random-admin-token
ADMIN_AUDIT_LOG_FILE=./storage/admin-audit.log
```

访问：

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3000/api/admin/overview
```

浏览器页面：`http://localhost:3000/admin.html`

如果本地还没有配置 `ADMIN_TOKEN`，后台页面会直接提示需要在 `.env` 中设置 `ADMIN_TOKEN` 并重启服务，避免只看到泛化的 503 错误。

该接口返回配置状态、gallery 数量与最近记录、jobs 状态分布、credits 余额与兑换码统计。返回内容会避开 `code_hash`、`user_token_hash` 等敏感字段，只作为内测期查账和排障入口。

运行指标（用于告警对接）：

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3000/api/admin/metrics
```

该接口返回进程 uptime、请求总量、错误总量、按状态码统计、按路径统计和错误码统计。
管理员写操作（补偿、发码、撤销）会追加写入 `ADMIN_AUDIT_LOG_FILE`（JSONL），用于审计追踪。

最近审计记录：

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" "http://localhost:3000/api/admin/audit-logs?limit=20"
```

按动作筛选：

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" "http://localhost:3000/api/admin/audit-logs?limit=20&action=admin_credits_grant_by_email"
```

该接口返回最近的管理员审计记录，包含：

- `action`
- `request_id`
- `ts`
- `detail`

浏览器后台 [public/admin.html](public/admin.html) 也会同步展示“最近审计记录”面板，并支持：

- 按动作筛选审计记录
- 独立刷新审计面板
- 快速核对最近一次补偿、批量发码或撤销动作

### 管理员邮箱用户查询

浏览器页面：`http://localhost:3000/admin.html`

后台已支持按邮箱检索用户，并展示：

- 邮箱用户基础状态
- 最近登录时间
- 邮箱验证时间
- 是否已关联钱包
- 钱包余额（可用 / 冻结）

接口查询示例：

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" "http://localhost:3000/api/admin/email-users?limit=50&q=alpha"
```

适用场景：

- 运营确认某邮箱是否已经登录过
- 排查某邮箱是否已经绑定钱包
- 补偿前先确认当前余额

## 邮箱用户系统（验证码登录）

启用邮箱登录（无密码）：

```bash
EMAIL_AUTH_ENABLED=true
EMAIL_AUTH_FILE=./storage/email-auth.json
EMAIL_AUTH_PEPPER=replace-with-a-strong-random-pepper
```

发送验证码：

```bash
curl -X POST http://localhost:3000/api/auth/email/send-code \
  -H "content-type: application/json" \
  -d '{"email":"user@example.com"}'
```

验证码校验并登录（成功后会设置 HttpOnly Cookie，同时返回 `auth_token` 便于 API 调试）：

```bash
curl -X POST http://localhost:3000/api/auth/email/verify-code \
  -H "content-type: application/json" \
  -d '{"email":"user@example.com","code":"123456"}'
```

查询当前登录用户：

```bash
curl -H "x-auth-token: <auth_token>" http://localhost:3000/api/auth/me
```

登出：

```bash
curl -X POST -H "x-auth-token: <auth_token>" http://localhost:3000/api/auth/logout
```

### 手动补偿 credits

配置单次补偿上限：

```bash
ADMIN_GRANT_MAX_CREDITS=10000
```

给已有钱包补偿 credits：

```bash
curl -X POST http://localhost:3000/api/admin/credits/grant \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"user_token":"usr_xxx","credits":25,"note":"support adjustment"}'
```

该接口只接受已存在的 `user_token`，不会自动创建钱包；每次补偿都会写入 `credit_ledger`，类型为 `admin_grant`。

### 按邮箱补偿 credits

如果运营手里没有 `user_token`，可以直接按邮箱补偿：

```bash
curl -X POST http://localhost:3000/api/admin/credits/grant-by-email \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"email":"user@example.com","credits":25,"note":"support adjustment by email"}'
```

行为说明：

- 如果该邮箱用户已经关联钱包：直接补偿到现有钱包
- 如果该邮箱用户存在但还没有钱包：系统会自动创建钱包用户并补偿
- 如果该邮箱从未登录过：返回 `email_user_not_found`

返回值会包含：

- `wallet.available_credits`
- `wallet.reserved_credits`
- `wallet_user_created`：是否刚创建钱包用户
- `created_user_token`：仅在自动创建钱包时返回，便于后续排查

该接口同样会写入 `credit_ledger` 与 `ADMIN_AUDIT_LOG_FILE`。

### 最小运营流程

推荐按下面顺序操作：

1. 打开 `http://localhost:3000/admin.html`，输入 `ADMIN_TOKEN`。
2. 先在“邮箱用户”里搜索目标邮箱，确认是否已登录、是否已有关联钱包、当前余额是多少。
3. 如果已经有关联钱包：直接使用“按邮箱补偿”。
4. 如果邮箱用户已存在但未关联钱包：仍可直接使用“按邮箱补偿”，系统会自动创建钱包。
5. 补偿完成后，再次查询邮箱，确认余额是否符合预期。
6. 如需做审计追踪，查看 `ADMIN_AUDIT_LOG_FILE` 中对应的 `admin_credits_grant_by_email` 或 `admin_credits_grant` 记录。

### 兑换码批次管理

配置管理上限：

```bash
ADMIN_BATCH_MAX_CODES=5000
ADMIN_BATCH_MAX_CREDITS_PER_CODE=100000
```

创建兑换码批次（接口会返回明文兑换码，仅返回一次）：

```bash
curl -X POST http://localhost:3000/api/admin/redemption-batches \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"name":"launch","count":20,"credits_per_code":100,"prefix":"IMG"}'
```

查询批次与码列表（码列表只返回 `code_preview`，不返回 `code_hash`）：

```bash
curl -H "x-admin-token: $ADMIN_TOKEN" "http://localhost:3000/api/admin/redemption-batches?limit=50"
curl -H "x-admin-token: $ADMIN_TOKEN" "http://localhost:3000/api/admin/redemption-codes?batch_id=<batch_id>&limit=100"
```

撤销未兑换的兑换码：

```bash
curl -X POST http://localhost:3000/api/admin/redemption-codes/<code_id>/revoke \
  -H "content-type: application/json" \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -d '{"note":"manual revoke"}'
```

## API

统一响应格式：

```json
{
  "success": true,
  "data": {},
  "request_id": "uuid"
}
```

错误响应格式：

```json
{
  "success": false,
  "error": {
    "code": "invalid_prompt",
    "message": "prompt is required",
    "details": null
  },
  "request_id": "uuid"
}
```

### POST `/api/generate`

请求体：
```json
{ "prompt": "...", "size": "1024x1024", "n": 1 }
```

请求头（开启鉴权时必填其一）：

- `x-app-token: <APP_ACCESS_TOKEN>`
- `Authorization: Bearer <APP_ACCESS_TOKEN>`

响应：
```json
{
  "success": true,
  "data": {
    "images": [{ "url": "https://...", "b64_json": null }],
    "took_ms": 12345,
    "model": "gpt-image-2",
    "prompt": "..."
  },
  "request_id": "uuid"
}
```

### GET `/api/health`

健康检查。

## Credits 与兑换码

第一版支持人工售卖兑换码：

- 开启：`CREDITS_ENABLED=true`
- 兑换码账本：默认 `storage/credits.json`
- 用户兑换后会得到匿名 `user_token`，前端保存在浏览器本地。
- 生成图片时按质量扣 credits：`low=3`、`medium=8`、`auto/high=20`。
- 生成前冻结 credits，成功后结算，失败或超时释放。

生成兑换码：

```bash
CREDIT_CODE_PEPPER=replace-with-real-secret \
npm run codes:create -- --count 20 --credits 100 --name launch-batch --prefix IMG
```

命令会输出明文兑换码 CSV；明文只展示一次，服务端文件只保存 hash。

## 图片存储

默认配置使用本地文件：

```bash
IMAGE_STORAGE_PROVIDER=local
```

上线时建议切到 S3-compatible 对象存储，例如 Cloudflare R2、AWS S3、OSS 的 S3 API：

```bash
IMAGE_STORAGE_PROVIDER=s3
IMAGE_STORAGE_PUBLIC_BASE_URL=https://cdn.example.com/images
IMAGE_STORAGE_UPLOAD_TIMEOUT_MS=30000
S3_ENDPOINT=https://account-id.r2.cloudflarestorage.com
S3_BUCKET=gpt-image
S3_REGION=auto
S3_ACCESS_KEY_ID=xxx
S3_SECRET_ACCESS_KEY=xxx
S3_FORCE_PATH_STYLE=true
```

`IMAGE_STORAGE_PUBLIC_BASE_URL` 必须是最终可公开访问图片的 CDN 或桶公开域名。`IMAGE_STORAGE_PREFIX` 可选，用于把对象写入桶内子目录。

## 后续扩展点（已留好接入位）

本 MVP **刻意不做**用户、订单、支付，但代码结构留好了扩展位：

| 需求 | 接入位置 | 建议做法 |
|---|---|---|
| 用户登录 | `server.js` 路由前 | 加 `authMiddleware`，挂在 `/api/generate` 之前，注入 `req.user` |
| 额度/计费 | `/api/generate` 内调用上游前 | 校验 `req.user.credits >= cost`，生成成功后扣费 |
| 订单记录 | `/api/generate` 成功响应前 | 写入 `orders` 表（user_id, prompt, image_url, cost, created_at） |
| 支付 | 新路由 `/api/v1/payments/*` | 接入微信支付 / 支付宝 / Stripe，回调更新用户额度 |
| 持久化图片 | 上游返回后 | 上传到 OSS/S3，存自己的 url 防过期 |
| Prompt 审核 | 调用上游前 | 加敏感词过滤或内容审核 API |

## 安全提示

- ⚠️ `.env` 不要提交到仓库（已在 `.gitignore`）
- ⚠️ 本 MVP 没有限流和鉴权，**勿直接暴露公网**；公网部署前至少加上 IP 限流
- ⚠️ 上游 API Key 一旦泄露，第三方可直接消耗你的额度
