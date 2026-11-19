# Runtime guards：执行契约与设计边界

`runtime_guard` 已实现为独立于 Goal/DAG 的共享内核，由 Compass 的一个 Pi 适配器注册。它不解析 Human 自然语言、不自动生成规则、不改变 AGENTS/NOTES，也不要求创建 Goal。Pi 入口通过原生 loader 静态导入 getAgentDir 并注入 profile provider；内核不自行动态查找全局安装的宿主 SDK。

**Human 已明确选择原生 hook 范围**：检查 `tool_call` 当时观察到的参数，覆盖直接和 Code Mode 嵌套调用；不保证后续插件再次改参，也不覆盖独立 child/remote 进程或扩展内部 exec。不是最终参数检查器或 OS 安全沙箱。无需修改已安装 Pi。

## 注册并使用一条规则

先用 `runtime_guard({operation:{action:"get"}})` 获取 compact scope revisions；新作用域的 revision 为 0。之后复用 mutation 回执，不要每轮重读全部规则。

下面的例子只提醒**显式 limit 大于 200**，不声称检查 read 的默认值、文件总行数或图片：

```json
{
  "operation": {
    "action": "put",
    "scope": "session",
    "expectedRevision": 0,
    "rule": {
      "id": "explicit-read-limit",
      "tools": ["read"],
      "read": ["input.limit"],
      "effect": "warn",
      "check": "e=>({verdict:typeof e.input.limit==='number'&&e.input.limit>200?'violation':'pass'})",
      "hint": "Read a smaller line range.",
      "cases": [
        {"event":{"toolName":"read","input":{"limit":50}},"expected":"pass"},
        {"event":{"toolName":"read","input":{"limit":500}},"expected":"violation"}
      ]
    }
  }
}
```

注册回执保留 applied/unchanged、scope/id/revision；不回显源码，也不发列表 cursor。revision 是**本次提交的作用域版本**，不是单条规则的计数或返回时的最新全局状态。注册完成后，后续准入使用新规则；已准入或运行的调用不追溯撤销。Code Mode 中应顺序 await 注册与被保护操作，不能并行注册和执行后假定顺序。

## 固定操作面

所有参数使用 `{operation:{action,...}}`，Native schema 为 root object + action union。

| action | 输入与行为 |
|---|---|
| get | 默认返回各 scope 的 revision 和简短规则列表；指定 scope 时只返回该 scope，cursor 仅在同一列表视图复用。未变只回 unchanged/cursor。指定 id 时默认 session，返回规则定义和 scope revision，不带 cursor。 |
| put | expectedRevision + rule；创建或完整替换同 scope 的 ID。验证结构、纯函数表达式和提供的案例，再 CAS 激活。完全相同的定义不重跑 VM 或写入。 |
| test | scope/id + cases；只运行判定，按输入顺序返回 verdict 和相关原因；只有不符时才附 expected。不写状态、不执行真实工具或真实设备动作。 |
| remove | scope/id + expectedRevision；只删除该 scope 的定义。删除也推进 scope revision，不能以重用旧 ID 绕过版本检查。 |

scope 默认 session。未知 ID、过期版本、非法字段、案例失败和不可用 runtime 不等同。验证失败不激活；Native session 写入结果不确定时回执为 `stateChanged:"unknown"`，先 get 核对而非盲重试。成功写入直接返回本次提交的 revision，不重读整个 scope。

### 判定函数与观察

check 是 JS 函数表达式，返回且只返回：

```js
e => ({ verdict: "pass" /* 或 violation / unknown */, reason: "可选，最多240字符" })
```

`e` 包含原生 toolName、toolCallId、parentToolCallId、cwd，以及 read 所选的 input 字段。read 使用 input 或 input.field 路径；重叠的父/子选择合并为父选择。未选择的数据不可凭空假设存在。

- 不提供 Node、fs、network、import、tools、models。不得打印输出或写 store；用返回的 reason 解释判断。
- 每次判定拥有新的隔离 VM；Date/random 固定为确定性环境，不是实时钟。没有通用可变状态或计时器。
- 投影只读自有数据属性，不执行 host getter，不沿继承属性构造目标，也不修改 Pi-owned input。输入是有界 JSON 快照，不静默截断。
- 可选 sourceRefs 是溯源引用，不是新 Human 指令或已核验 fresh 的标记。内容/语义失效仍由 Agent 审阅。
- 可选 cases 为 1–8 个 event/expected。提供的案例必须通过才能激活，但“案例通过”不等于语义正确。
- lazy 工具尚未注册时可以登记其原生名；回执列 unresolvedTargets，不假装已有覆盖。`*` 显式匹配所有工具，控制工具自身除外。

## warn、block 与 unknown

**warn** 不改 content、structuredContent、details、isError、usage 或图片。命中通过原生 turn_end custom-message draft 聚合给父 Agent，即使 Code Mode 丢弃 nested 返回值。未命中不发消息，不为提醒请求额外 provider turn。提醒遵从 Pi 原生提交/上下文生命周期，不是新的系统权威。

**block** 在观察点阻止调用执行，不返回正常业务数据；仍有原生短错误结果并保持 call/result 配对。不默认终止整个 Agent，不自动执行补救命令，不重试。nested block 的错误即使被脚本吞掉，也有父级边界提醒，包括 scope 竞争和 runtime 不可用。

unknown、坏返回值、异常、超预算、取消和超时不伪装成语义违规。block 规则检查失败则阻止；warn 规则检查失败则提醒后继续。无法读取规则存储或规则在判定期间变化时，不能知道是否新增了禁止条件，因此拒绝本次准入。

`runtime_guard` 不受自身规则封锁，避免坏规则锁死修复；仍受其他原生权限控制。修复须使用对应 scope 和新 revision，不能用 local 弱化 global。存储损坏需要 Human 修复对应文件或选择支持的 Native branch，不提供静默重置。

提醒用短文本列出受影响的工具、规则、结果及修正建议。相同命中聚合计数，最多 16 组、约 2 KiB；省略时注明次数。不复述整份规则、内部调用 ID 或原始工具输入。

## Scope 与持久化

| scope | 所有权与生命周期 |
|---|---|
| session | 默认。通过原生 runtime-guard.state custom entry 持久化；Native tree 恢复该分支的状态，不复制 transcript、不随 Goal 替换自动猜测退休。 |
| local | 当前 Pi cwd 的 canonical path，不扫描/推断 git root，也不因一次 shell cd 改变。不同项目不共享 local 定义。 |
| global | 当前 Pi profile，共享给使用该 profile 且加载此扩展的其他 Pi 进程；Agent 按 Human 授权范围维护，不因一次项目例外擅改全局。 |

同名规则的身份是 scope + id。所有适用规则共同检查；local pass/warn 不抵消 global block。

Global/local 共用 `<getAgentDir()>/runtime-guards.sqlite`，首次写入才创建，数据库权限 0600。使用 Node 内置 SQLite/WAL、零 busy 等待及 BEGIN IMMEDIATE/CAS；没有自制文件租约或第二个语义规范仓库。SQLite 在 Node 22 的实验性提示不等于测试失败。

热路径只读 namespace revision；版本不变复用已验证快照，变化后重新加载。VM await 不持数据库事务锁，检查完成后再核对版本；竞争直接报未执行，不无限循环重试。不同进程共用版本检查，不靠 fs.watch 假定即时一致。已打开的存储消失或被替换会失败可见，不静默变成空规则。控制操作在入队时绑定原生 epoch，读取状态或运行 VM 的 await 后再次校验；旧分支既不能向新分支提交规则或空策略准入，也不能把迟到提醒投递进去。

Schema v1 current-only；不迁移、不清空未知版本。规则源码是 Agent 编译的操作性产物；AGENTS/NOTES 与原生 Human 记录仍拥有语义来源。

## 隔离、预算和成本

生产依赖固定的公开 `@earendil-works/pi-codemode@1.5.2`，不依赖 Pi 未导出的 VM internals，也不假设它在 native loader 的别名中。TypeBox 仍只使用 Pi peer，Node 最低版本由 dependency 提升到 22.19.0。

一个惰性 Node Worker 内使用公开 InlineCodemodeSandbox，每次 start 创建新的 VM；Inline 不在 Pi 主线程运行。没有第二个 Agent loop。Worker 空闲 30 秒回收，下一次需要时重建；空 profile/未匹配路径不启动 VM。

| 边界 | 上限/行为 |
|---|---|
| 每 scope 规则 | 32 条，完整 control snapshot 256 KiB |
| 单规则源码 | 8 KiB；hint 240 字节 |
| tools / read | 各最多 16 项；read 路径最多 10 段 |
| 单判定观察 | 64 KiB JSON、最多 64 层；越限 unknown，不截断 |
| VM | 32 MiB；Worker V8 old/young generation 64/16 MiB |
| 准入 | 一个活动批次，最多 16 个等待批次 |
| 执行期限 | 默认 1 秒，含等候与冷启动；取消/超时终止 Worker，实际退出后才能复用容量 |

Worker idle/超时退出后的队列都会继续调度；终止失败则关闭容量并拒绝等待者。独立工具取消信号必须传入控制操作，在提交前再次检查，不能只用 Agent-wide signal。

本地延迟与完整进程 RSS 见 [测量](measurements-v0.10.0.md#runtime-guard-cost)。它们不是 provider latency、token 净节省或功能独占内存证明。多条匹配规则增加判定成本，应注册少量值得机械检查的要求，而不是把每句 prose 都搬进去。

## 场景与责任边界

“不能 cd”的判定应检查实际工具参数，而不是整段 Code Mode 文本或宿主设置 cwd 的内部 shell 包装。Agent 要区分命令、引号、注释、文件名、数据 heredoc 与执行、别名、间接 shell、自定义工具、PowerShell 等覆盖范围。内核不把 includes('cd') 宣传成语义保证，也不硬编码几十种 shell 变体。

Agent 负责函数漏检/误报和案例质量；框架负责正确交付观察、scope/CAS、生效边界、CPU/内存约束、取消、通知和协议不变。Host prototype 污染、丢失 nested 通知、跨 scope cursor 误报 unchanged、关停期间丢队列等都是机制缺陷，不推给规则作者。

“IR 间隔至少 60 秒”、资源并发占用等有状态条件**不在本版保证内**。它们需要原子 check-and-reserve、终态/未知态、跨进程时钟和重启语义；超时不代表设备没收到命令，不能自动释放保护重发。此版本只交付无状态的工具调用检查，等待/调度继续归原生能力。

## 证据与验收

- `src/runtime-guard*.mjs`：纯数据/schema、scope store、VM/Worker、Pi 适配，控制工具只有一个入口。
- `tests/runtime-guard-host.test.mjs`：独立 Node 子进程清除 NODE_OPTIONS 且不加载测试解析 hook；实际 public SDK discoverAndLoadExtensions/factory/Runner 检查空规则读取、真正 Worker 判定与临时 profile SQLite。full preflight 复用该检查；不发 provider 请求、不接触 Human profile。
- `tests/runtime-guard*.test.mjs`：实际 SQLite/public sandbox/installed ExtensionRunner，覆盖 CRUD、CAS、原生分支、warn 结果保持、nested 提醒、已接受的后续改参边界、取消、原型安全、超时恢复、idle 退出期间准入、存储损坏。
- `scripts/measure-runtime-guards.mjs`：临时 profile 与内存 branch adapter，不创建 Human profile 规则。无规则、未匹配、匹配通过和阻止分别计量。
- [canonical local evidence](architecture-v0.10.0.md#final-local-evidence)：实际完整验证结果。Registry/branch adapter 测试不是 live AgentSession/provider 验收。

旧版反馈中 set 全量回显、幂等、output 和 context 入口已有当前接口对应修复；完整约束列表可以删除旧条款，但仍没有逐条 patch。无边 + 同 cwd 不必然冲突；当前 DAG 已校验依赖引用/环并限制自动子任务只读。不能新增无条件“失败重试”绕过 unknown run identity。全量 Goal 详情的 input.reviewed 表示原生输入是否待审阅，不代表 runtime 已判断语义正确或冲突。完整使用成本仍需 Human live 证据。
