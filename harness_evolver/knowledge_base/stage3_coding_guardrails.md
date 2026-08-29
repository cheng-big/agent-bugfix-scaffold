# Stage 3 — 架构与编码防御规范

## Baseline — 通用

- [ ] 在边界处校验输入，在领域层校验状态机；异常必须保留可定位原因，不吞异常、不返回假成功。
- [ ] 写操作明确事务边界、幂等键、重复提交结果和失败补偿；外部系统不假装参与本地 ACID。
- [ ] 权限和数据范围从服务端登录上下文推导，前端隐藏按钮不能替代接口鉴权。
- [ ] 第三方 SDK loader 失败后可重试，错误态有中文原因和恢复动作，不永久缓存 rejected Promise。
- [ ] 凭据只进入目标平台的本地环境；多端构建后扫描 secret，非目标产物命中必须为 0。
- [ ] 动态容器（抽屉/Tab/弹窗）中的画布等待稳定尺寸并监听 resize；覆盖工具不得与画布共享点击命中。
- [ ] 公共组件暴露明确契约，避免页面复制业务逻辑；响应式状态不得退化为不可追踪的本地存储读取。

## Baseline — Spring Boot / Java

- [ ] Service 承担权限、状态、事务和审计；Controller 只做协议适配与统一响应。
- [ ] MyBatis-Plus 查询显式拼接 DataScope，更新前重新读取并校验可写范围。
- [ ] 事务方法必须可被 Spring 代理调用；禁止同类自调用导致 `@Transactional` 失效。
- [ ] 业务异常与系统异常分层，400/401/403/500 语义稳定且不泄露密钥、SQL 或内部堆栈。

## Baseline — Vue / uni-app

- [ ] 列表、详情、表单都覆盖 loading/empty/error/disabled；动态内容不得改变固定控件尺寸。
- [ ] 业务编码与中文显示值分层，字典和枚举统一映射；页面不得直接展示 camelCase 快照字段。
- [ ] 多端条件编译同时隔离代码与环境变量；H5 配置不能进入 `mp-weixin` 公共 bundle。
- [ ] 地图/上传/原生组件按平台真实能力实现，并保留明确降级，不用静态截图冒充在线能力。

<!-- EVOLVER:MANAGED-START -->

### EVR-COD-8e5a306191 — 凭据隔离与跨平台产物边界失效
- **防御指引：** 编码与构建必须按平台隔离环境变量，默认忽略本地凭据，并在产物中用真实 Secret 做零命中扫描；日志和报告只输出计数。
- **来源 Bug：** E-09, E-10, E-13, E-15, E-16, U-10, U-13, U-20, U-21
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:27`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:30`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:37`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:38`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:59`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:60`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:63`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:65`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:66`
- **适用技术栈：** Docker, Spring Boot, Third-party SDK, Vue/Element Plus, uni-app/WeChat
- **观测次数 / 置信度：** 9 / 0.886

### EVR-COD-8007f5bfa9 — 构建依赖或多端编译契约不完整
- **防御指引：** 引入组件前必须检查其编译器、预处理器与 peer 依赖，并在实现完成后分别构建所有目标平台，保留上游依赖风险。
- **来源 Bug：** E-02, E-05, E-06, E-07
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:52`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:55`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:56`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:57`
- **适用技术栈：** Vue/Element Plus, uni-app/WeChat
- **观测次数 / 置信度：** 4 / 0.867

### EVR-COD-0d6f41421e — 第三方 SDK 生命周期与画布交互不健壮
- **防御指引：** 第三方 SDK 必须具备幂等加载、失败清缓存、可重试错误态、稳定容器尺寸与 resize；画布工具隔离点击命中并验证非空像素和覆盖物边距。
- **来源 Bug：** E-11, E-12
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:61`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:62`
- **适用技术栈：** Third-party SDK, Vue/Element Plus
- **观测次数 / 置信度：** 2 / 0.870

### EVR-COD-4914887c68 — 构建产物与运行实例版本不一致
- **防御指引：** 启动与验收前必须核对实际运行产物哈希/时间、容器挂载 inode、迁移版本和接口标记；禁止用本地编译结果替代运行态证据。
- **来源 Bug：** E-04, E-08
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:54`, `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:58`
- **适用技术栈：** Docker, MySQL/Flyway
- **观测次数 / 置信度：** 2 / 0.856

### EVR-COD-6ecf5c63af — Harness 项目身份配置未完成
- **防御指引：** Harness 安装与 doctor 必须拒绝未替换的项目身份占位符，并在 context 注入前验证角色、权限边界、真源和 DoD 已完成项目适配。
- **来源 Bug：** E-17
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:67`
- **适用技术栈：** 通用
- **观测次数 / 置信度：** 1 / 0.910

### EVR-COD-4557a4afbd — 反馈归因或规则聚类产生误合并
- **防御指引：** Evolver 的算法与 Prompt 必须版本化；变更后强制重析，并用跨模式负样本验证只有同阶段且 guideline 相同或 failure mode 足够相似的规则才可合并。
- **来源 Bug：** E-18
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:68`
- **适用技术栈：** uni-app/WeChat
- **观测次数 / 置信度：** 1 / 0.883

### EVR-COD-1fa1f7a830 — 编码边界缺少防御性守卫
- **防御指引：** 编码阶段必须在输入校验、异常恢复、事务/幂等、权限范围、跨平台构建和第三方依赖边界提供显式守卫与可回读证据。
- **来源 Bug：** U-25
- **来源位置：** `harness_evolver/history/2026-08-fishery-three-in-one-retrospective.md:42`
- **适用技术栈：** uni-app/WeChat
- **观测次数 / 置信度：** 1 / 0.817
<!-- EVOLVER:MANAGED-END -->
