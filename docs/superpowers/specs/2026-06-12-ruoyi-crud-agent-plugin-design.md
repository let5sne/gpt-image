# RuoYi CRUD Agent Codex Plugin Design

日期: 2026-06-12

## 背景

当前 `gpt-image` 项目已经从极简 Node/Express MVP 演进出邮箱登录、credits 钱包、兑换码、API 客户、管理员补偿、审计日志、DB 影子读写和后台页面等业务能力。继续在单文件后端和手写后台里扩展用户、产品、权限、支付、订单等 CRUD，会让后续维护和验收成本持续升高。

用户希望探索一条更可复用的路径: 以 `dromara/RuoYi-Vue-Plus` 作为业务逻辑后端，以 `CrazyLionCat/plus-ui` 作为管理后台前端，先构建一个可复用的 RuoYi CRUD Agent。该 Agent 首先在独立 sandbox 中生成并验收一个产品套餐 CRUD 模块，成功后再发布为 Codex 插件，并在后续阶段接入 `gpt-image` 业务。

## 已确认决策

- 第一阶段选择 "C: 先建代码生成/Agent 基建"，不直接迁移 `gpt-image` 业务。
- MVP 成功闭环选择 "后端 + plus-ui 管理页 + 真实验收脚本"。
- 首个验证模块选择 "产品套餐"。
- 产品套餐设计采用 "通用为主，保留 `gpt-image` 售卖包扩展点"。
- Agent 输入契约采用结构化 YAML/JSON spec。
- 验收环境采用独立 RuoYi/plus-ui sandbox。
- 第一版形态采用 Codex 插件骨架优先。
- sandbox 依赖采用 "默认固定版本，提供升级检查命令"。
- 实现路线采用 "混合式插件骨架": Skill 编排 + 小脚本内核，后续逐步收敛为 CLI。

## 目标

Phase 0-1 的目标是交付一个可复跑、可审计、可发布为 Codex 插件的 RuoYi CRUD Agent MVP:

1. 插件目录按 Codex plugin 形态组织。
2. 输入以结构化 spec 为准，禁止自然语言直接驱动代码生成。
3. 使用固定版本的 RuoYi-Vue-Plus 和 plus-ui sandbox。
4. 基于产品套餐样例生成后端 CRUD、plus-ui 管理页面、菜单和按钮权限。
5. 自动执行后端编译、前端构建、接口 smoke、页面存在性检查。
6. 输出 Markdown 和 JSON 双格式验收报告。

## 非目标

Phase 1 不迁移 `gpt-image` 现有业务，不接入真实支付，不实现订单、兑换码生成、钱包账本迁移，也不把 RuoYi 后端替换为生产主后端。这些能力进入 Phase 4 之后再单独设计。

Phase 1 不引入 MCP server。插件先只包含 Skill、schema、templates、scripts、fixtures 和 docs。等脚本内核稳定后，再评估是否加入 MCP 或正式 CLI。

## 插件结构

建议目录:

```text
ruoyi-crud-agent-plugin/
  .codex-plugin/plugin.json
  skills/ruoyi-crud-agent/SKILL.md
  schemas/crud-spec.schema.json
  examples/product-plan.yaml
  templates/backend/
  templates/plus-ui/
  scripts/
    validate-spec
    init-sandbox
    generate-module
    verify-module
    report
  fixtures/
    versions.lock
    sandbox/
  docs/
    plugin-publishing.md
    spec-format.md
```

职责划分:

- `SKILL.md`: 定义 Codex 何时启用 Agent、如何要求 spec、如何调用脚本、如何解释失败和修复建议。
- `schemas/`: 定义 CRUD spec 的 JSON Schema，保证输入可校验、可版本化。
- `examples/`: 保存产品套餐 golden path 样例。
- `templates/backend/`: 保存 RuoYi 后端 entity、mapper、service、controller、permission/menu seed 等模板。
- `templates/plus-ui/`: 保存管理页 API、路由、列表、表单、状态控件等模板。
- `scripts/`: 执行确定性动作，包括 spec 校验、sandbox 初始化、代码生成、验收和报告。
- `fixtures/`: 保存 sandbox 版本锁和可复跑测试夹具。
- `docs/`: 保存插件发布说明、spec 格式和兼容矩阵。

## 执行流程

Agent 主流程为:

1. 读取 spec: 用户提供 YAML 或 JSON。Codex Skill 可帮助用户把自然语言收敛为 spec，但生成入口只接受结构化文件。
2. 校验 spec: `scripts/validate-spec` 使用 JSON Schema 做字段级校验。失败时输出路径、原因和修复建议。
3. 准备 sandbox: `scripts/init-sandbox` 根据 `fixtures/versions.lock` 拉取固定版本的 RuoYi-Vue-Plus 与 plus-ui。
4. 生成模块: `scripts/generate-module` 根据 spec 写入后端 CRUD、plus-ui 管理页、菜单权限和必要 seed。
5. 运行验收: `scripts/verify-module` 运行后端编译、前端构建、接口 smoke 和页面存在性检查。
6. 输出报告: `scripts/report` 生成 Markdown 和 JSON 报告，记录 spec、版本锁、生成文件、命令结果、失败原因和可复跑命令。

成功标准是 `examples/product-plan.yaml` 能在固定版本 sandbox 中端到端通过，并生成完整验收报告。

## Spec 格式

第一版以 YAML 为主，同时允许 JSON。产品套餐样例:

```yaml
module:
  name: productPlan
  title: 产品套餐
  package: com.example.business.product
  table: biz_product_plan
  menuPath: business/product-plan

fields:
  - name: planCode
    title: 套餐编码
    type: string
    required: true
    unique: true
    list: true
    form: true
    search: true

  - name: planName
    title: 套餐名称
    type: string
    required: true
    list: true
    form: true
    search: true

  - name: priceCents
    title: 售价分
    type: integer
    required: true
    min: 0
    list: true
    form: true

  - name: credits
    title: 点数
    type: integer
    required: true
    min: 1
    list: true
    form: true

  - name: status
    title: 状态
    type: enum
    options: [enabled, disabled]
    default: enabled
    list: true
    form: true
    search: true

  - name: sortOrder
    title: 排序
    type: integer
    default: 0
    list: true
    form: true

permissions:
  menu: business:productPlan
  list: business:productPlan:list
  create: business:productPlan:add
  update: business:productPlan:edit
  delete: business:productPlan:remove
  export: business:productPlan:export

acceptance:
  backend:
    compile: true
    smokeCrud: true
  frontend:
    build: true
    routeVisible: true
    formFields: [planCode, planName, priceCents, credits, status, sortOrder]
  report:
    format: [markdown, json]
```

产品套餐字段采用通用业务命名，同时兼容后续 `gpt-image` 售卖包:

- `planCode`: 可映射 `starter`、`standard`、`pro`。
- `planName`: 可映射体验包、标准包、专业包。
- `priceCents`: 用整数分表示金额，避免浮点误差。
- `credits`: 对应生图点数。
- `status`: 支持上下架。
- `sortOrder`: 支持前台展示排序。

## Sandbox 与版本锁

sandbox 不属于 `gpt-image` 生产代码，也不直接承载未来业务后台。它是插件的 fixture 和验收环境。

建议结构:

```text
fixtures/sandbox/
  backend/
  frontend/
```

版本锁格式:

```yaml
ruoyiVuePlus:
  repo: https://github.com/dromara/RuoYi-Vue-Plus.git
  ref: "full commit hash or immutable tag recorded during fixture creation"
plusUi:
  repo: https://github.com/CrazyLionCat/plus-ui.git
  ref: "full commit hash or immutable tag recorded during fixture creation"
java:
  version: "17"
node:
  version: ">=20"
packageManager:
  frontend: pnpm
```

策略:

- 默认 `init-sandbox` 按锁定版本初始化，保证可复跑。
- `check-upstream` 只检查上游更新，不自动升级。
- `upgrade-fixture` 作为显式动作，升级后必须重新跑产品套餐 golden path。
- 验收报告必须记录实际 commit、Java、Node、Maven 和 pnpm 版本。
- 缺少 Java、Maven、Node 或 pnpm 时，报告状态为 `blocked`，不能报告成功。

## 验收闭环

`verify-module` 至少覆盖:

- 后端编译或模块级测试。
- 前端 typecheck 或 build。
- 接口 smoke: 列表、新增、编辑、删除、状态切换。
- 页面检查: 菜单路由存在、列表字段存在、表单字段存在、按钮权限标识存在。
- 报告检查: Markdown 和 JSON 均生成，且包含 spec hash、sandbox 版本、生成文件清单和命令结果。

Codex 最终汇报时只应基于真实命令结果和报告内容，不用代码阅读替代验收。

## 错误处理

第一版错误模型分为:

- `invalid_spec`: spec 不符合 schema。
- `environment_blocked`: Java、Maven、Node、pnpm 或 git 不可用。
- `sandbox_init_failed`: 固定版本仓库拉取或依赖安装失败。
- `generation_conflict`: 目标文件已存在、菜单码冲突、权限码冲突或模板 marker 不匹配。
- `backend_verify_failed`: 后端编译或接口 smoke 失败。
- `frontend_verify_failed`: 前端构建或页面检查失败。
- `report_failed`: 验收报告生成失败。

每类错误都应输出可复跑命令和下一步建议。脚本负责给出机器可读错误码，Codex Skill 负责给出面向用户的解释。

## 分阶段路线

### Phase 0: 设计冻结

交付本设计文档，明确插件目录、spec schema、产品套餐样例、验收流程、版本锁策略和后续路线。不写实现代码。

### Phase 1: 本地插件 MVP

交付插件骨架、`ruoyi-crud-agent` Skill、schema、`product-plan.yaml`、sandbox 初始化、生成脚本、验收报告。成功标准是产品套餐模块在固定版本 RuoYi/plus-ui sandbox 内端到端通过。

### Phase 2: Agent 稳定化

补齐常见失败诊断: 字段名不合法、权限码冲突、菜单路由冲突、后端编译失败、前端构建失败、数据库 migration 冲突。增加第二个样例模块，但不进入支付和账本。

### Phase 3: 插件发布准备

整理 `.codex-plugin/plugin.json`、README、报告样例、版本号、许可证声明、上游兼容矩阵和安装说明。若脚本内核已稳定，再收敛为正式 CLI；否则先按轻量插件发布。

### Phase 4: 接入 gpt-image

以产品套餐 CRUD 为桥头堡，开始映射到 `gpt-image` 当前售卖包、credits、订单和支付。此阶段重新设计 RuoYi 后端与 Node 生图链路的边界，不复用 Phase 1 的 MVP 作为生产迁移方案。

## 参考资料

- Codex Plugins: https://developers.openai.com/codex/plugins
- Build Codex Plugins: https://developers.openai.com/codex/plugins/build
- RuoYi-Vue-Plus: https://github.com/dromara/RuoYi-Vue-Plus
- plus-ui: https://github.com/CrazyLionCat/plus-ui
