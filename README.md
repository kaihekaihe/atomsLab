# AtomLab · 智能体应用工作台（Atoms Cloud 全栈版）

一句话描述业务需求，三个智能体（需求分析师 → 应用架构师 → 蓝图质检员）接力生成可增删改查的业务应用。
本仓库即线上运行代码：前端 Vite + React，后端 FastAPI，数据存放在 Atoms Cloud 数据库。

## 项目结构

```text
app/
├── start_app_v2.sh                 # 平台启动脚本（前端 + 后端）
├── backend/                        # FastAPI
│   ├── routers/atomlab.py          # /api/v1/atomlab/* 业务接口
│   ├── services/
│   │   ├── atomlab_pipeline.py     # 三阶段智能体流水线（异步、逐阶段落库、可续跑）
│   │   ├── atomlab_llm.py          # OpenAI 兼容 /chat/completions 客户端 + 容错 JSON 提取
│   │   ├── atomlab_local.py        # 内置规则引擎（模板 + 增量补丁）
│   │   └── blueprint.py            # 蓝图归一化、记录校验、版本差异、CSV
│   ├── models/ services/<表>.py routers/<表>.py alembic/   # 由 Atoms Cloud 生成，勿手改
│   └── core/ main.py lambda_handler.py                    # 框架文件，勿改
└── frontend/                       # Vite + React + Tailwind
    └── src/
        ├── pages/Studio.tsx        # 工作台（项目 / 画布 / 对话 / 智能体轨迹 / 版本）
        ├── pages/Share.tsx         # /share/:token 免登录只读分享
        ├── components/atomlab/     # AppCanvas、DynamicField、ChatPanel、TracePanel、VersionsPanel、Sidebar
        └── lib/atomlab/            # 类型、接口封装、统计计算
```

## 核心机制

- **生成**：`POST /projects/{id}/generate` 立即返回 `runId`（202），流水线在后台运行；
  每个阶段完成即把 `{status, ms, note}` 写入 `runs.steps`，前端每 1.2 秒轮询 `GET /runs/{runId}` 展示实时轨迹。
- **容错**：单阶段失败跳过继续；架构师失败时整体降级为规则引擎，结果用 `engine` 标注 `agent` / `local`。
  JSON 提取兼容代码块包裹、前后杂散文字和 `<think>` 思考内容。
- **蓝图**：字段类型 text / textarea / number / date / select / boolean；视图 table / kanban（拖拽换列，空列自动隐藏）/ cards；
  统计卡 count / sum / avg / ratio。种子数据只在首次生成时写入。
- **其他**：数据按登录用户隔离；记录服务端校验（必填 / 枚举 / 数值 / 日期）；
  版本恢复会新建一个版本，不改动业务数据；发布后生成随机 token，免登录只读分享；支持 CSV 导出。

## 环境变量

LLM 配置只从运行时环境变量读取，在 **Atoms Cloud → Keys** 中配置，不写入代码或文件：

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` | OpenAI 兼容接口地址（不含 `/chat/completions`） |
| `LLM_API_KEY` | 接口密钥 |
| `LLM_MODEL` | 模型名 |
| `LLM_TIMEOUT_MS` | 单次请求超时（毫秒） |
| `LLM_MAX_TOKENS` | 单次最大输出 token |
| `LLM_EXTRA_BODY` | 可选，JSON，供应商特有参数 |

未配置时自动使用规则引擎（engine=local）。数据库、认证等配置由平台注入。

## 启动与检查

```bash
cd app && ./start_app_v2.sh --local          # 本地启动前后端
cd app/frontend && pnpm exec tsc -p tsconfig.app.json --noEmit && pnpm run lint && pnpm run build
cd app/backend && python -m py_compile routers/atomlab.py services/atomlab_*.py services/blueprint.py
```
