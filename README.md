# Image Studio · 极简 AI 图片创作站点

一个跑通核心创作链路的 MVP：用户输入 prompt → 后端代理 AI 接口 → 返回图片。

## 技术栈

- **后端**：Node.js (≥ 18) + Express，仅 1 个核心接口 `/api/generate`
- **前端**：单文件原生 HTML/CSS/JS，零构建
- **配置**：`.env` 管理 API Key

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

配置后重新部署：

```bash
vercel --prod
```

### 4. 说明

- 项目已包含 `vercel.json`，会把 `server.js` 作为 Node Serverless Function 运行。
- Vercel 模式下为无状态代理：`/api/generate` 直接返回上游图片 URL，不做本地落盘。
- 因为无状态，`/api/gallery` 在 Vercel 上返回空数组；本地开发模式才会写入 `storage/metadata.json`。
- 若要线上保留画廊，建议接入 OSS/S3 + 数据库（或 Vercel Blob + KV）。

## API

### POST `/api/generate`

请求体：
```json
{ "prompt": "...", "size": "1024x1024", "n": 1 }
```

响应：
```json
{
  "images": [{ "url": "https://...", "b64_json": null }],
  "took_ms": 12345,
  "model": "gpt-image-2"
}
```

### GET `/api/health`

健康检查。

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
