# Runtime guards：反馈评估与设计草案

状态：**设计提案，不是已实现的工具或当前执行契约**。本轮只修复 Goal 详细读取的原生输入审阅信号；不注册规则、不修改全局配置、不替换 Pi 的权限机制。

## 1. 旧版反馈如何处理

两份反馈使用 `compass_goal(action=get|set)` / `compass_dag(nodes)`，不是当前 v0.10 的调用面。它们是有价值的现场报告，但缺少对应版本与原始 JSONL，不能当作当前版本的复现或成本归因。

| 反馈 | 当前证据与处理 |
|---|---|
| set 原样回显全文 | 当前 `compass_goal` 只回 applied/unchanged、版本、sourceIds、cursor，替换时补 reset 计数；不回显 goal/constraints。无需再加 brief 开关或 hash/lengths。见 `src/index.ts` 的 `registerGoalTool` / `stateResult`。 |
| 重复 set 浪费写入 | `setGoal` 对相同内容、来源与审阅状态幂等；确认新 Human 输入可以产生必要的审阅更新，不应伪装成无变化。见 `src/goal-run.mjs:setGoal`。 |
| 旧约束不能删除 | 当前完整列表替换可删除旧条款；**尚无逐条 ID/patch**。是否增加增量 API 应看当前真实更新成本，不能为旧接口直接增加六七种操作。 |
| get 把未审阅状态看成当前正确约束 | runtime 无法判断语义冲突，但能判断新 Human 输入是否已审阅。`compass_state` 已有 input.reviewed；本轮补齐详细 Goal 读取的同一信号。false 不代表所有约束失效，true 也不代表语义正确。 |
| get 投影 / since last_compact | 已有 compact state、opaque cursor delta、完整详情、定向 context search/pin/mark。先使用这些现有能力；不再引入靠 compaction 推导语义变化的第二个游标。 |
| 文档 output 与 schema 不符 | 当前任务 schema 和 DAG 核心都支持 output；历史不一致不应做兼容层。见 `src/index.ts:taskDefinitionSchema` 与 `src/dag-core.mjs:normalizeTask`。 |
| 所有节点无边、同 cwd 必然冲突 | 不成立：独立只读检查可以合法并行。当前校验依赖引用/环、执行器与只读子任务边界；语义独立性仍归 Agent。不能为了防错给正常只读 DAG 加噪声告警。 |
| 失败后整条 DAG 重投 | 当前有 reopen 和依赖感知失效，保留无关工作。它不是未知 child 的盲重试；unknown 先核对原生身份。不能新增通用 retry 按钮抹掉未知执行结果。 |
| Compass 没有 context 工具 | 当前查询与 model-only mutation 已拆分；Skill 可见不代表扩展加载，model-only 工具本来不在 Code Mode ALL_TOOLS。参见 [工具契约](tool-contract.md)。 |
| AGENTS / NOTES / Goal 三份真相 | 同意风险。AGENTS/文件继续拥有工作规范；Goal 只保留必要任务态和解释，context 按版本保留证据。编译出的 guard 是操作性产物，不升级为另一份 Human 指令。 |

跨 compaction 的价值与 DAG 的收益因任务而异，两份反馈本身也不同。不能由其中一例推导“唯一价值”或普遍净收益。也不应为了采纳而要求每个工具都用一次。

## 2. 定位与责任

**Human 给语义要求 → Agent 编写可检验规则 → runtime 按明确事件执行规则。**

- Agent 负责语义解释、适用工具、允许/禁止案例、识别范围、修订与退休。runtime 不从自然语言推导规则，也不保证任意程序等价性。
- runtime 负责事件真实性、准确的作用域/版本、生效边界、资源隔离、错误与通知交付、确定性执行，以及自身不会破坏工具协议。
- Agent 的判定函数漏检/误报，属于规则质量问题；宿主线程卡死、参数交付不实、跨 scope 覆盖、通知丢失或版本竞争，则是机制缺陷。不能都推给 Agent。
- 这是合作式工作流护栏，不是对抗恶意 Agent/扩展的 OS 安全沙箱。真正的文件/网络权限与进程隔离继续归原生权限或系统沙箱。

推荐一个独立于 Goal/DAG 的共享 guard 内核，由**一个** Pi 扩展适配层拥有。Compass 可引用 guard 身份，不复制规则引擎、不强制创建 Goal，也不在两个入口各跑一次 hook。包/仓库归属在实施前决定。

## 3. 最短工作流与提议接口

1. Agent 看当前语义要求，按需注册或修改一条规则；不要求每轮重建规则。
2. 一次 put 完成结构/语法验证、可选案例检查和原子激活，回小回执。
3. 后续每个匹配的工具调用执行判定：pass、violation 或 unknown。
4. 命中按 warn/block 处理。Agent 根据短反馈修订同一 ID，不另外复制一条规则。

建议一个小控制工具 `runtime_guard`，root object + operation union：

| 操作 | 必要行为 |
|---|---|
| put | 创建或替换一个 scope 内的 ID；expectedRevision 防止丢失更新；提交成功后生效。 |
| get | 默认只列身份、版本、效果与有效 scope；指定 ID 才取源码、案例、来源。支持原样传回的 cursor，避免重复全文。 |
| test | 只跑判定函数，不调用被检查的真实工具，不写规则/状态，不产生真实设备动作。 |
| remove | 按 ID + expectedRevision 删除；不允许 local 删除 global。 |

规则最小信息：`id`、`scope`、`tools`、`read`、`effect`、`check`、短修正提示；可选来源引用和测试案例。check 是 Agent 提交的纯 JS 函数源码，不是 Node 模块路径；返回值严格校验，不能把任意 truthy 值当成命中。

- tools 使用原生工具名，不猜命名空间别名。未加载的 lazy 工具可以登记，但回执明确 unresolvedTargets，不声称已有覆盖。
- read 声明需要的事件字段，例如 input.command；避免把 write 的 MB 级正文、图片或整个上下文复制到 VM。需要完整字段时显式声明，超预算不能静默截断。
- runtime 提供稳定的调用 ID、parent ID、原生 cwd 和选定输入快照；不提供 fs、network、process、import、tools 或 models。
- 可选案例必须实际通过，否则不激活。案例通过不等于语义正确；不强制每条规则凑相同数量的测试。
- put/get 的 mutation 回执只含 status、scope/id/revision 与必要的生效/未知目标信息，不回显源码和案例。
- Code Mode 中可以顺序 await 注册后再调用工具；不得并行注册和执行后声称顺序有保障。原生已准入或已运行的调用不追溯撤销。

## 4. 提醒与阻止必须分清

### warn

执行照常继续，**不改原工具 content、structuredContent、isError、usage 或图片**。不向外部工具的 JSON 后拼文本；那会破坏程序化调用。

命中提醒用原生 custom message 在合法边界交给父 Agent，不伪装 Human 消息，不为提醒单独触发模型调用。按原生顶层调用/批次聚合重复规则，保留命中次数；正常未命中不增加提示。

尤其要验收 Code Mode：即使脚本丢弃了 nested 工具返回值，父 Agent 仍能看到提醒。仅把消息放到 nested content/details 或 TUI notify 中都不够。准确的原生投递时机是 P0 验证项，不能只靠 fake event bus 声称完成。

### block

在执行前返回 Pi 的 block 决定：工具不执行、不产生该调用的副作用、不返回正常业务结果。**仍返回短错误结果**并保留 call/result 配对；“结果不返回”不能实现为悬挂调用或删掉 toolResult。

不默认终止整个 Agent，不自动重跑、不自动执行修正命令。修正后由 Agent 选择下一步。

执行完才发现输出不合要求，只能记录/提醒或阻止未来调用，不能声称撤销副作用。首版不提供“执行后 block 并藏掉结果”。

### unknown / evaluator error

unknown、抛错、超时、超量输入、非法返回值与 violation 区分。默认 block 规则检查失败时阻止该调用，warn 规则则提醒后继续，回执注明“未完成检查”，不伪造违反语义的结论。不自动关闭失效规则。

控制工具及 Human 紧急恢复入口不受**本机制自己的**通配规则封锁，仍受原生权限限制。修复 scope 权限保持不变；不能通过 local 修复入口弱化 global。

## 5. Scope、来源和一致性

共享一套格式和执行器，global/project/session 只是规则作用域：

- session 默认：适合临时任务，不意外扩散；随原生分支恢复，不靠模型记住。
- project：按明确的 canonical 项目根标识，不随一次 bash cd 漂移。
- global：profile 级规则，跨项目生效；Agent 只能在 Human 授权的作用域内维护，不能因本项目一次例外擅改全局。
- 同时适用的规则全部成立；local 不能用同名 ID 覆盖或降级 global。warn 不抵消 block。身份是 scope + id，不是一个隐式覆盖链。
- 代码/效果/来源更新以版本 CAS 激活；旧版本或验证失败均不改活动状态。注册回执界定生效点，已准入调用使用其明确的快照。
- 只有“同进程收到回执”不足以宣称其他 Pi 进程同步更新。共享持久化的版本检查和激活语义必须单独验证；不能靠 fs.watch 保证立即一致。

持久化候选优先评估 Node 内置 SQLite 的小表/事务，避免自写不可靠的 read-check-rename 或过期锁协议。global 和 project 用 scope key，session 继续尊重原生分支生命周期。是否采用 SQLite、最低 Node 版本和实际开销需 P0 证据，不在此预先承诺为已选实现。

任何事务都不跨 VM await 持锁。先取快照，在事务外判定，再验证版本并提交；规则被并发修改时不能沿用旧判定。竞争需有界处理并明确未执行，不能无限重试或偷偷放行。

来源引用记录原生输入身份，或文件位置/版本，不复制整份 AGENTS/NOTES 为第二规范。内容 hash 变化只能证明来源变化，不能证明规则语义失效或生成正确修订。没有检查就不能标 fresh。新 Human 输入仍由 Agent 解释；runtime 不自动撤销所有现有保护，也不从新文字自动改规则。

## 6. “不能 cd”及覆盖边界

应检查实际 bash 调用的参数，而不是扫描整段 Code Mode 源码，也不是拦截宿主为设置 cwd 生成的内部 shell 包装。

规则作者至少要区分：真正的 cd 命令、分号/管道/子 shell、注释、`echo 'cd x'`、文件名、here-document 的数据与执行、引号转义、别名/函数、`bash -c`、PowerShell、Python/自定义工具的间接执行。

不把 `command.includes('cd')` 包装成通用保证；也不为这个例子把几十种 shell 模式写死到内核。判定器的语法支持、保守性与未覆盖路径属于明确的规则覆盖范围。必要的共享解析 helper 可以在真实案例支持后加入，不先建一套万用 DSL。

原生边界已确认的限制：

1. `tool_call` 可阻止工具，nested Code Mode 调用也经过它。
2. Pi 1.5.2 的后续 tool_call handler 仍能改 input，且不重新验证。**一次早期检查不等于检查了最终执行参数。** 仅靠“我最后注册”或冻结 Pi-owned input 不足以成为通用解法。
3. 普通 tool_call 看不到扩展内部 exec、任意程序内部系统调用、未装适配器的独立 child/remote runtime 或 Human 的 ! 命令。不能把 global 理解为覆盖所有 OS 行为。

因此“最终参数上的防护”是 P0 的阻断性问题：先找到受支持的原生最终检查边界，或给出经过验证的扩展组合/受控工具适配范围。若只能提供 tool_call 观察点上的护栏，必须按这个较窄边界命名和验收；不能把宿主集成缺口归咎于 Agent 规则写错。不得为此偷偷修改已安装 Pi、重写所有原生工具或建第二个工具执行器。

## 7. 轻量运行，而不是把模型换成另一个重循环

- 无启用作用域时不启动 VM；工具选择先用缓存索引过滤。全局即时一致若要求版本探测，就实测该成本，不同时宣称零 I/O。
- 同一次事件的适用规则批量检查；只传声明字段，不扫描整段 history、不让模型逐次判定。
- 缓存已验证规则、selector 与版本化源码 bundle。公共 Code Mode sandbox 每次运行创建新 VM，不能凭空声称已经缓存了跨调用 JS 函数。
- Agent JS 不用 Node eval/new Function/node:vm 冒充安全沙箱。复用公开 Code Mode/QuickJS 能力；不给规则执行外部动作的工具。
- 需要独立 worker 的硬期限、VM 内存/输入/输出/代码体积预算和取消清理；Promise.race 不能终止恶意循环或不可中断内建函数。失效 worker 不能继续占着执行容量却标成空闲。
- 初步方向是惰性共享的 warm worker、隔离执行上下文与有界准入；不能为每个规则/调用新开线程，也不能共享可被上一条规则污染的全局对象。公共 API 能否同时满足这些要求及其成本先验证，验证不了就停，不扩成自研通用 VM 框架。

本轮本机微探测（Node 22.22.1、公开 pi-codemode 1.5.2、32 MiB VM 限额、空 tools/globals、每次十个简单判断，7 次运行含首次）：

| 执行方式 | 首次 | 后六次中位数 | 解释 |
|---|---:|---:|---|
| CodemodeSandbox，逐次新建 worker | 44.350 ms | 31.592 ms | 不适合作为轻量热路径默认实现。 |
| InlineCodemodeSandbox，宿主线程 | 8.469 ms | 5.853 ms | 不能据此选择它：不可中断内建运算仍可能卡宿主。 |

这不是 native hook 集成、warm worker 实现、恶意代码隔离或 provider 收益证明，也没有测得该功能的独占 RSS。第一个探测脚本因等待 unref worker 的退出而以未完成顶层 await 结束；修正探测脚本后才得到上表，不能把失败的脚本算作通过。

## 8. 有状态限制：单独承认成本

“不能 cd”是无状态的；“IR 至少间隔 60 秒”“资源不能并发占用”不是。不能把读上次时间然后放行当作并发安全。

若纳入有状态能力，需要原子 check-and-reserve、调用身份、终态/未知态处理，以及跨进程 scope 的一致时钟/状态语义。并行调用不能同时通过；超时不代表设备没收到命令，不能自动释放保护再重发。重启、时钟倒退、更新判定代码时未结束的 reservation 都必须有明确状态。

首个可交付垂直切片以无状态工具调用检查为界；只预留事件/版本边界，不先开放未经验证的通用可变 store、计时器、锁服务或自动补救动作。有状态能力单独过事务性验收，等待与调度仍复用原生能力。不能把首版包装成已能保证设备冷却间隔。

## 9. 实施顺序与验收

| 阶段 | 要证明什么 |
|---|---|
| P0，先验证、不铺功能 | 最终参数检查边界；parent/nested 的 warn 可达且原结果不变；公开沙箱复用的安全和热路径成本；scope 持久化/CAS 的可行性。任一关键项无证据就暴露范围，不转写成“支持”。 |
| P1，最小通用垂直切片 | 单规则 put → 验证 → 生效 → warn/block → 按 ID 修订/删除；无规则快路径；语法/返回/超时错误；原生紧急恢复；global/project/session 不越权覆盖。 |
| P2，再覆盖真实复杂规则 | 真实 command 边缘案例、lazy MCP、扩展组合、独立子进程覆盖声明；有需求且事务验收通过后再做状态型限制。 |

最小测试矩阵应覆盖：pass/violation/unknown；坏代码与超时；注册失败不激活；并发修订不丢更新；local 不能弱化 global；聚合提醒不丢 nested 命中；JSON/structuredContent/image 正常结果不变；block 不执行且仍有错误配对；重启/分支恢复；后续 handler 改参数的可复现场景。性能单列未匹配路径、命中路径、并发/超时、RSS 与 provider 调用数，不能只报平均值。

目标不是“自动管住所有语义”，而是：Agent 能以低成本把适合机械检查的要求编译成可验证、可修改、可追责的防护；不适合机械保证的要求仍保持语义与证据边界。

## 10. 证据定位

- 当前工程：`src/index.ts` 的 registerGoalTool / taskDefinitionSchema / registerContextSearchTool / registerContextTool；`src/goal-run.mjs` 的 setGoal / buildGoalDetails / transitionTasks；`src/dag-core.mjs` 的 normalizeTask / assertAcyclic。
- 原生 Pi 1.5.2：安装包 `docs/extensions.md` 的 Tool Events、pi.sendMessage 与 Calling Other Tools；`dist/core/extensions/runner.js:emitToolCall`。后续 handler 可变输入与 load-order chaining 是公开契约，不是推测。
- 公开沙箱 1.5.2：`@earendil-works/pi-codemode` 的 exports，CodemodeSandboxBase / CodemodeSandbox / InlineCodemodeSandbox / RemoteCodemodeSandbox / serveCodemodeRemote 的类型与生命周期说明。这里只确认公开能力，尚未证明复用后的 guard 集成。
