# Stage 1 — 需求拆分与边界自审清单

## Baseline

- [ ] 每个角色列出可见菜单、可执行动作、数据范围与明确禁止动作；只读角色不出现写入口。
- [ ] 每个业务实体给出完整状态机：起点、终点、驳回/重提、取消/过期、接管与不可逆状态。
- [ ] 页面契约覆盖 `data / action / input`，列表必须闭环到详情，详情字段有分组、顺序和中文显示值。
- [ ] 跨实体引用使用受数据范围约束的选择器，客户端不得手填业务 ID 或区县 ID。
- [ ] 高频任务判断是否应内联；同级类型优先使用一套可复用导航，禁止无意义的嵌套 Tab。
- [ ] 认证、授权、绑定、停用、失关联等准入状态均有对应路由、空态、错误态和恢复动作。
- [ ] 父级上下文（项目/租户/监测点等）在首屏可见，定义切换、持久化和未提交数据清理规则。
- [ ] 第三方服务明确供应商、平台差异、凭据、域名、授权、降级和正式环境责任人。
- [ ] 每条统计、汇总和看板数字都绑定真实接口与验收口径，禁止演示常量。
- [ ] 未决歧义进入熔断账，标明影响、默认假设、确认人和恢复条件。

<!-- EVOLVER:MANAGED-START -->

### EVR-REQ-af01ced95e — 页面信息架构与显示契约不完整
- **防御指引：** 页面契约必须覆盖列表到详情闭环、字段中文值与顺序、同级导航、重复入口、嵌套 Tab、空态/错误态和高频任务内联决策。
- **来源 Bug：** U-01, U-02, U-03, U-04, U-06, U-09, U-11, U-14, U-15, U-22, U-26
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:18`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:19`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:20`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:21`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:23`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:26`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:28`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:31`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:32`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:39`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:43`
- **适用技术栈：** Vue/Element Plus, uni-app/WeChat
- **观测次数 / 置信度：** 11 / 0.931

### EVR-REQ-46ce432c6f — 角色能力与禁止动作边界不完整
- **防御指引：** 需求拆分必须为每个角色生成菜单、允许动作、禁止动作和数据范围矩阵；只读角色在页面与接口两层都不得出现写入口。
- **来源 Bug：** U-05, U-17, U-18, U-19, U-23, U-24
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:22`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:34`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:35`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:36`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:40`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:41`
- **适用技术栈：** Vue/Element Plus, uni-app/WeChat
- **观测次数 / 置信度：** 6 / 0.843

### EVR-REQ-245d6e0734 — 身份与认证生命周期未完整建模
- **防御指引：** 需求与页面契约必须列出登录、认证、授权、绑定、解绑、停用和重新准入的完整状态矩阵，并逐状态定义路由、数据、动作与恢复。
- **来源 Bug：** U-08, U-12, U-27
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:25`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:29`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:44`
- **适用技术栈：** Vue/Element Plus, uni-app/WeChat
- **观测次数 / 置信度：** 3 / 0.883

### EVR-REQ-3df2e92108 — 交付反馈未形成上游规则闭环
- **防御指引：** 交付阶段必须把用户反馈和工程失败结构化编号、归因并映射到上游阶段；阶段完成门禁检查新增反馈已进入 Evolver 事实账。
- **来源 Bug：** U-07, U-28
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:24`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:45`
- **适用技术栈：** 通用
- **观测次数 / 置信度：** 2 / 0.783

### EVR-REQ-97626a2f26 — 业务父级上下文与切换规则缺失
- **防御指引：** 页面契约必须声明业务父级上下文、可见位置、选择器、持久化、请求必带字段以及切换时未提交状态清理策略，并用至少两条真实数据验收。
- **来源 Bug：** U-16
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:33`
- **适用技术栈：** 通用
- **观测次数 / 置信度：** 1 / 0.950
<!-- EVOLVER:MANAGED-END -->
