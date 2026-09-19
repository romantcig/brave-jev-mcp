<!-- GSD:project-start source:PROJECT.md -->

## Project

**Brave MCP × Jev 过滤层**

brave/brave-search-mcp-server 的独立"jev 版"分支：在 `brave_llm_context` 工具的返回里嵌入一层**页面粒度**的过滤，去掉重复文章和农场文章，减缓上下文增长，提高送到模型面前的内容质量。使用者是老大本人（Claude Code 会话里的联网搜索），验证后作为独立仓库公开到 GitHub。

**Core Value:** `brave_llm_context` 每次返回的来源，都是对 intent 有独立信息价值的页面：一手来源、原创论证、独有事实留下；转述、模板、列表页、旧版页去掉；拿不准时保守，宁可多留。

### Constraints

- **Legal**: 公开文件（含 `.planning/`、`notes/` 公开笔记、代码注释、提交信息）不得出现任何 Jev 准确率、概率、延迟、成本对比数字 — TypeSafe MCA 2.3(f)；数字只写 `notes/private-*.md`（gitignore）
- **Secrets**: 所有 key 走环境变量或 gitignore 文件，不进仓库；本机 key、代理、配置路径见 `notes/private-local-env.md`；`.jev.json` 探测输出全部 gitignore
- **Tech stack**: 沿用上游 Node ESM + TypeScript 5 + zod 4 + MCP SDK 1.30，`node --test` + tsx 测试，prettier 格式，测试文件与源文件并排；过滤库不含任何 MCP 类型 — 便于将来挂到别的宿主
- **Upstream compatibility**: 对上游只动三处（`execute()` 适配、工具声明、去 outputSchema / structuredContent），其余全部放纯库目录 — 保证 `git merge upstream/main` 可持续；outputSchema 与 structuredContent 必须一起去掉
- **Ordering**: 过滤管道十步顺序固定，任何一步不重排；幸存内容保持 Brave 原序 — 不丢 Brave 的时效和站点权重信号
- **Jev**: 单来源一次请求、并行、进程级并发闸；钉版本 ID；跨来源比较不问 Jev；单请求 state + 全部问题 ≤ 64k token、state + 最长单题 ≤ 32k，超限直接拒绝而非截断
- **Runtime**: Windows 10 + MSYS2 Bash，Node 25；原生 fetch 需 `NODE_USE_ENV_PROXY=1` 才走代理
- **Publishing**: 保留 MIT 与上游署名；个人化中文工具描述放仓库外覆盖文件，仓库里只放通用英文描述
- **Workflow**: 改 `src/` 前需老大明确授权；智能体并发受 API 限额约束 — 执行顺序化，一次只开一个智能体

<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->

## Technology Stack

代码地图不在此复制。按需读 `.planning/codebase/STACK.md`、`CONVENTIONS.md`、`ARCHITECTURE.md`、`STRUCTURE.md`、`INTEGRATIONS.md`、`TESTING.md`、`CONCERNS.md`。
<!-- GSD:stack-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->
