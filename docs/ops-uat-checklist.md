# Image Studio 运营 UAT 清单

适用范围：兑换码运营闭环（后台发码/撤销 + 前台兑换 + 指标校验）

## 1. 测试目标

- 验证后台可稳定批量发码。
- 验证后台抽检撤销行为正确。
- 验证前台可成功兑换有效码，并正确更新余额。
- 验证批次统计与实际行为一致。

## 2. 前置条件

1. 本地服务可启动。
2. 具备 `ADMIN_TOKEN`。
3. 已开启 credits：`CREDITS_ENABLED=true`。
4. 建议使用独立端口执行 UAT，避免影响日常开发实例。

推荐启动命令：

```bash
ADMIN_TOKEN=local-admin-token CREDITS_ENABLED=true PORT=3001 node server.js
```

后台地址：`http://localhost:3001/admin.html`
前台地址：`http://localhost:3001/`

## 3. UAT 场景步骤

### 场景 A：后台批量发码（100 个）

1. 打开后台页面，填写 `ADMIN_TOKEN`，点击“刷新”。
2. 调用发码接口创建批次（建议参数：`count=100`, `credits_per_code=10`, `prefix=UAT`）。

通过标准：

- 返回状态 `201`。
- `codes` 数组长度为 100。
- 记录 `batch_id` 供后续步骤使用。

### 场景 B：后台抽检撤销（3 个）

1. 使用 `batch_id` 查询批次码列表。
2. 随机选 3 个 `code_id` 调用撤销接口。
3. 对同一 `code_id` 再次撤销一次。

通过标准：

- 首次撤销 3 次均返回 `200`，状态为 `revoked`。
- 重复撤销返回 `409`，错误码为 `code_already_revoked`。

### 场景 C：前台兑换验证

1. 再创建一个单码批次（`count=1`, `credits_per_code=12`）。
2. 到前台输入该兑换码并点击“兑换”。

通过标准：

- 前台提示“兑换成功，已增加 X credits”。
- 余额按预期增加（本次应增加 12）。

### 场景 D：批次统计一致性校验

1. 查询场景 A 的 `batch_id` 对应批次统计。

通过标准：

- 统计结果满足：
  - `total = 100`
  - `revoked = 3`
  - `redeemed = 1`（若已兑换其中 1 个）
  - `active = 96`
  - `expired = 0`（未配置过期时）

## 4. 快速接口示例

### 创建批次

```bash
curl -X POST http://localhost:3001/api/admin/redemption-batches \
  -H "content-type: application/json" \
  -H "x-admin-token: local-admin-token" \
  -d '{"name":"uat-batch-100","count":100,"credits_per_code":10,"prefix":"UAT"}'
```

### 查询批次

```bash
curl -H "x-admin-token: local-admin-token" \
  "http://localhost:3001/api/admin/redemption-batches?limit=200"
```

### 查询批次码

```bash
curl -H "x-admin-token: local-admin-token" \
  "http://localhost:3001/api/admin/redemption-codes?batch_id=<batch_id>&limit=500"
```

### 撤销兑换码

```bash
curl -X POST http://localhost:3001/api/admin/redemption-codes/<code_id>/revoke \
  -H "content-type: application/json" \
  -H "x-admin-token: local-admin-token" \
  -d '{"note":"uat sample revoke"}'
```

### 前台兑换对应接口

```bash
curl -X POST http://localhost:3001/api/redeem \
  -H "content-type: application/json" \
  -d '{"code":"<raw_code>"}'
```

## 5. 结果记录模板

- 测试时间：
- 测试环境：
- 提交版本（commit）：
- 场景 A：通过 / 失败
- 场景 B：通过 / 失败
- 场景 C：通过 / 失败
- 场景 D：通过 / 失败
- 失败详情与请求 ID：
- 结论：可上线 / 不可上线

## 6. 清理建议

- 结束后停止临时服务，避免占用端口。
- 若是共享环境，清理仅用于 UAT 的测试批次和测试码。
