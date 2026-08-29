# 脚手架能力进化报告

- 生成时间：2026-08-28T16:52:59.533382+00:00
- 扫描文档：1
- 变更 / 未变更文档：1 / 0
- 累计 Bug 事实：46
- 分析模式：{"heuristic": 46}

## 阶段归因

| Stage | Bug 数 | 规则数 |
|---|---:|---:|
| REQUIREMENT | 23 | 5 |
| DATABASE | 1 | 1 |
| CODING | 20 | 7 |
| TESTING | 2 | 1 |

## 规则变化

- 新增：EVR-COD-0d6f41421e, EVR-COD-1fa1f7a830, EVR-COD-4557a4afbd, EVR-COD-4914887c68, EVR-COD-6ecf5c63af, EVR-COD-8007f5bfa9, EVR-COD-8e5a306191, EVR-DAT-6d1774dbd7, EVR-REQ-245d6e0734, EVR-REQ-3df2e92108, EVR-REQ-46ce432c6f, EVR-REQ-97626a2f26, EVR-REQ-af01ced95e, EVR-TES-afc9090226
- 移除：无

## 本次高频防御规则

### REQUIREMENT
- `EVR-REQ-af01ced95e` (11次) 页面契约必须覆盖列表到详情闭环、字段中文值与顺序、同级导航、重复入口、嵌套 Tab、空态/错误态和高频任务内联决策。
- `EVR-REQ-46ce432c6f` (6次) 需求拆分必须为每个角色生成菜单、允许动作、禁止动作和数据范围矩阵；只读角色在页面与接口两层都不得出现写入口。
- `EVR-REQ-245d6e0734` (3次) 需求与页面契约必须列出登录、认证、授权、绑定、解绑、停用和重新准入的完整状态矩阵，并逐状态定义路由、数据、动作与恢复。
- `EVR-REQ-3df2e92108` (2次) 交付阶段必须把用户反馈和工程失败结构化编号、归因并映射到上游阶段；阶段完成门禁检查新增反馈已进入 Evolver 事实账。
- `EVR-REQ-97626a2f26` (1次) 页面契约必须声明业务父级上下文、可见位置、选择器、持久化、请求必带字段以及切换时未提交状态清理策略，并用至少两条真实数据验收。

### DATABASE
- `EVR-DAT-6d1774dbd7` (1次) 数据模型与 API 契约必须统一大整数 ID 的序列化类型，并使用超过 JavaScript 安全整数的真实值验证列表到详情回读。

### CODING
- `EVR-COD-8e5a306191` (9次) 编码与构建必须按平台隔离环境变量，默认忽略本地凭据，并在产物中用真实 Secret 做零命中扫描；日志和报告只输出计数。
- `EVR-COD-8007f5bfa9` (4次) 引入组件前必须检查其编译器、预处理器与 peer 依赖，并在实现完成后分别构建所有目标平台，保留上游依赖风险。
- `EVR-COD-0d6f41421e` (2次) 第三方 SDK 必须具备幂等加载、失败清缓存、可重试错误态、稳定容器尺寸与 resize；画布工具隔离点击命中并验证非空像素和覆盖物边距。
- `EVR-COD-4914887c68` (2次) 启动与验收前必须核对实际运行产物哈希/时间、容器挂载 inode、迁移版本和接口标记；禁止用本地编译结果替代运行态证据。
- `EVR-COD-6ecf5c63af` (1次) Harness 安装与 doctor 必须拒绝未替换的项目身份占位符，并在 context 注入前验证角色、权限边界、真源和 DoD 已完成项目适配。

### TESTING
- `EVR-TES-afc9090226` (2次) 测试矩阵必须在真实 AppID 的模拟器或真机覆盖原生组件、权限、软键盘、安全区和平台选择器；缺环境时显式标记证据边界。

## 更新文件

- `harness_evolver/knowledge_base/stage1_requirements_checklist.md`
- `harness_evolver/knowledge_base/stage2_db_design_rules.md`
- `harness_evolver/knowledge_base/stage3_coding_guardrails.md`
- `harness_evolver/knowledge_base/stage4_test_case_matrix.md`
- `harness_evolver/state/evolution_state.json`
- `harness_evolver/state/bug_traces.jsonl`
