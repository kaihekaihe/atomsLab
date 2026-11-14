"""三智能体生成流水线：需求分析师 → 应用架构师 → 蓝图质检员。

- 每个阶段一次真实 LLM 调用；阶段完成即把 {status, ms, note} 落库（runs.steps），前端轮询可见。
- 单阶段失败跳过继续；架构师彻底失败时整体降级为内置规则引擎（engine=local）。
- 运行状态与阶段中间产物（简报、草稿蓝图）都持久化，后台任务被中断后可从断点续跑。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from core.database import db_manager
from models.blueprints import Blueprints
from models.projects import Projects
from models.records import Records
from models.runs import Runs
from services.atomlab_llm import chat_json, llm_configured, llm_timeout_seconds
from services.atomlab_local import local_generate
from services.blueprint import MODE_CN, BlueprintError, normalize_blueprint
from sqlalchemy import func, select

logger = logging.getLogger(__name__)

STEP_DEFS = [("analyst", "需求分析师"), ("architect", "应用架构师"), ("inspector", "蓝图质检员")]

ANALYST_SYS = """你是 AtomLab 的需求分析师。用户会用中文描述想要的业务小应用，也可能在已有应用基础上提出修改。
你的任务：把需求理解成一份结构化的需求简报（JSON），供应用架构师使用。

只输出一个 JSON 对象，不要解释、不要用代码块包裹，结构如下：
{
  "understanding": "20-40 字概括用户想要的东西",
  "entity": "单条记录的 2-4 字名称，如 库存、工单、客户",
  "purpose": "一句话说明这个应用解决什么问题",
  "fieldIdeas": [{"label": "中文字段名", "kind": "text|textarea|number|date|select|boolean", "reason": "为什么需要该字段"}],
  "viewMode": "table | kanban | cards",
  "viewReason": "选择该视图的一句话理由",
  "theme": {"icon": "一个 emoji", "accent": "#rrggbb 十六进制色", "tagline": "20 字以内副标题"},
  "incremental": false
}

要求：
- fieldIdeas 给 4-9 个，覆盖用户提到的全部信息点；可补 1-2 个常用辅助字段（如备注、日期），不要臆造核心业务字段。
- kind 选择：金额/价格/数量/评分用 number；状态/类型/分类/阶段用 select；时间用 date；是/否用 boolean；长描述用 textarea；其余 text。
- 适合按状态分栏跟踪的需求（任务、工单、订单流转、线索阶段）选 kanban；信息密度高、列多选 table；重展示美感选 cards。
- 本次是在已有应用上做局部修改时（增删字段、换视图、改名），incremental 置 true。"""

ARCHITECT_SYS = """你是 AtomLab 的应用架构师。根据需求简报与用户原话，产出一份完整的 AppBlueprint（应用蓝图 JSON）。蓝图会被通用运行时解释渲染，字段 name 是数据层锚点，必须谨慎设计。

只输出一个 JSON 对象，不要解释、不要用代码块包裹：
{
  "app": {"name": "应用名，10 字内", "tagline": "副标题，24 字内", "icon": "一个 emoji", "accent": "#rrggbb"},
  "data": {
    "entity": "记录名，2-4 字",
    "fields": [{"name": "snake_case 标识", "label": "中文名", "kind": "text|textarea|number|date|select|boolean", "required": false, "hint": "占位提示，可选", "options": ["仅 select 需要，2-8 个中文短选项"], "display": "currency 或 percent，仅 number 可选"}],
    "seed": [{"字段name": 值}]
  },
  "views": {"mode": "table|kanban|cards", "columns": ["列表展示字段 name，3-6 个，按重要性排序"], "groupBy": "看板模式必填：分栏用的 select 字段 name；其他模式省略"},
  "actions": {"create": true, "update": true, "remove": true},
  "stats": [{"label": "指标名", "type": "count|sum|avg|ratio", "field": "sum/avg 必填：number 字段 name", "whereField": "ratio 必填：select 字段 name", "whereValue": "ratio 必填：该字段某个 option 的原值"}]
}

硬性规则：
1. fields 4-10 个；name 只用小写字母、数字、下划线，全表唯一。
2. select 必须给 options（2-8 个不重复）。
3. kanban 必须配 groupBy 且指向一个 select 字段；columns 里要包含 groupBy。
4. stats 0-3 个；sum/avg 的 field 必须是 number 字段；ratio 的 whereValue 必须逐字等于该 select 字段的某个 option。
5. seed 每条的 key 必须是 fields 里的 name；number 给数值、select 给 options 原值、date 给 YYYY-MM-DD、boolean 给 true/false；内容贴近真实业务、有区分度；看板应用要覆盖每个分组各至少一条。首次生成给 3-5 条；在已有蓝图上增量修改时 seed 必须是空数组（业务数据已存在，不要重复编造）。
6. 增量修改时：保留未提及字段的 name 与 label 不变（name 是历史数据锚点），只动用户要求改的部分。
7. required 只给核心标识字段（名称/标题/编号/主题），其余 false。
8. 用户明确要求某状态标色/统计/高亮时，优先用 stats 表达；应用名与 icon 要贴合业务。"""

INSPECTOR_SYS = """你是 AtomLab 的蓝图质检员。给你一份 AppBlueprint JSON 与用户需求原话，请逐项检查并输出修复后的完整蓝图 JSON（结构同架构师）。

检查清单：
1. 字段 name 是否全部合法（小写字母/数字/下划线、唯一、不以数字开头）；label 是否可读。
2. kind 是否在 text|textarea|number|date|select|boolean 内；select 的 options 是否 2-8 个且无重复。
3. views.columns 是否都指向真实字段、数量 3-6；mode 为 kanban 时 groupBy 是否存在且为 select 字段。
4. stats：type 是否合法；sum/avg 的 field 是否存在且为 number；ratio 的 whereField/whereValue 是否存在且 whereValue 逐字在 options 内。
5. seed：key 是否都在 fields 内；值是否与 kind 匹配（select 值必须在 options 内、date 是否 YYYY-MM-DD）；看板应用是否覆盖各分组；增量修改时 seed 保持空数组。
6. 语义贴合：是否遗漏用户明确提到的信息点；字段是否冗余。

只输出修复后的完整蓝图 JSON，不要输出检查过程。若全部合格，原样输出。"""

# 进程内正在执行的 run，防止重复调度；同时持有强引用避免任务被 GC。
_ACTIVE: dict[int, asyncio.Task] = {}


def new_state() -> dict[str, Any]:
    return {
        "steps": [{"seq": i + 1, "agent": a, "title": t, "status": "pending"} for i, (a, t) in enumerate(STEP_DEFS)],
        "ctx": {},
    }


def parse_state(raw: str | None) -> dict[str, Any]:
    try:
        state = json.loads(raw or "")
    except ValueError:
        state = None
    if isinstance(state, list):  # 兼容只存 steps 列表的旧格式
        state = {"steps": state, "ctx": {}}
    if not isinstance(state, dict) or not isinstance(state.get("steps"), list):
        state = new_state()
    state.setdefault("ctx", {})
    return state


def public_steps(raw: str | None) -> list[dict[str, Any]]:
    return parse_state(raw)["steps"]


def stale_after_seconds() -> float:
    """超过该时长没有任何落库更新，视为后台任务已中断，需要续跑。"""
    return llm_timeout_seconds() * 2 + 30


def _err(exc: BaseException) -> str:
    return str(exc)[:120] or type(exc).__name__


def _hist(history: list[str]) -> str:
    return "\n".join(f"{i + 1}. {h}" for i, h in enumerate(history)) if history else "（无）"


def _dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


async def _save_state(run_id: int, state: dict[str, Any]) -> None:
    async with db_manager.session() as db:
        run = await db.get(Runs, run_id)
        if run is None or run.status != "running":
            return
        run.steps = _dump(state)
        run.updated_at = datetime.now(timezone.utc)
        await db.commit()


async def _load_inputs(run_id: int) -> dict[str, Any] | None:
    async with db_manager.session() as db:
        run = await db.get(Runs, run_id)
        if run is None or run.status != "running":
            return None
        project = await db.get(Projects, run.project_id)
        if project is None or project.user_id != run.user_id:
            return None
        current = None
        if project.active_blueprint_id:
            bp_row = await db.get(Blueprints, project.active_blueprint_id)
            if bp_row is not None:
                try:
                    current = json.loads(bp_row.data)
                except ValueError:
                    current = None
        history_rows = await db.scalars(
            select(Runs.prompt)
            .where(Runs.project_id == run.project_id, Runs.user_id == run.user_id, Runs.id < run.id)
            .order_by(Runs.id.desc())
            .limit(2)
        )
        inputs = {
            "run_id": run.id,
            "project_id": run.project_id,
            "user_id": run.user_id,
            "prompt": run.prompt,
            "history": list(reversed(list(history_rows))),
            "current": current,
            "state": parse_state(run.steps),
        }
        await db.commit()
        return inputs


async def _finalize(inp: dict[str, Any], bp: dict[str, Any], engine: str, state: dict[str, Any]) -> None:
    """写入新版本、首次生成时写种子数据、激活版本并结束 run（单事务）。"""
    async with db_manager.session() as db:
        # 行锁 + 状态复核：即便续跑与原任务并发，也只会落库一次
        run = await db.scalar(select(Runs).where(Runs.id == inp["run_id"]).with_for_update())
        project = await db.get(Projects, inp["project_id"])
        if project is None or run is None or run.status != "running":
            await db.rollback()
            return
        max_ver = await db.scalar(
            select(func.coalesce(func.max(Blueprints.version), 0)).where(Blueprints.project_id == project.id)
        )
        record_count = await db.scalar(
            select(func.count(Records.id)).where(Records.project_id == project.id, Records.user_id == inp["user_id"])
        )
        first_generation = project.active_blueprint_id is None and not record_count
        if not first_generation:
            bp = {**bp, "seed": []}
        version = int(max_ver or 0) + 1
        row = Blueprints(
            project_id=project.id,
            version=version,
            data=_dump(bp),
            source_prompt=inp["prompt"],
            engine=engine,
            run_id=run.id,
            user_id=inp["user_id"],
        )
        db.add(row)
        await db.flush()
        if first_generation:
            for seed in bp.get("seed", []):
                db.add(Records(project_id=project.id, data=_dump(seed), user_id=inp["user_id"]))
        project.active_blueprint_id = row.id
        project.active_version = version
        project.updated_at = datetime.now(timezone.utc)
        state.pop("ctx", None)
        run.steps = _dump({"steps": state["steps"], "ctx": {}})
        run.status = "done"
        run.engine = engine
        run.blueprint_id = row.id
        run.error = ""
        run.updated_at = datetime.now(timezone.utc)
        await db.commit()


async def _fail_run(run_id: int, state: dict[str, Any], message: str) -> None:
    for step in state["steps"]:
        if step["status"] in ("pending", "running"):
            step["status"] = "failed"
            step["note"] = message
    async with db_manager.session() as db:
        run = await db.get(Runs, run_id)
        if run is None:
            return
        run.steps = _dump({"steps": state["steps"], "ctx": {}})
        run.status = "failed"
        run.error = message
        run.updated_at = datetime.now(timezone.utc)
        await db.commit()


async def _finish_local(inp: dict[str, Any], state: dict[str, Any], reason: str) -> None:
    steps = state["steps"]
    t0 = time.monotonic()
    try:
        result = local_generate(inp["prompt"], inp["current"])
    except Exception as exc:  # noqa: BLE001
        await _fail_run(inp["run_id"], state, f"规则引擎也失败：{_err(exc)}")
        return
    if steps[0]["status"] != "done":
        steps[0].update(status="done", ms=int((time.monotonic() - t0) * 1000), note=result["understanding"])
    steps[1].update(status="done", ms=steps[1].get("ms", 0), note=f"本地规则引擎：{result['reason']}（{reason}）")
    steps[2].update(status="skipped", note="本地规则模式，无需质检")
    await _save_state(inp["run_id"], state)
    await _finalize(inp, result["blueprint"], "local", state)


async def _stage(state: dict[str, Any], idx: int, run_id: int, coro_factory) -> tuple[Any, int]:
    step = state["steps"][idx]
    step["status"] = "running"
    step.pop("note", None)
    await _save_state(run_id, state)
    t0 = time.monotonic()
    try:
        return await coro_factory(), int((time.monotonic() - t0) * 1000)
    except Exception as exc:  # noqa: BLE001
        raise _StageFailed(_err(exc), int((time.monotonic() - t0) * 1000)) from exc


class _StageFailed(Exception):
    def __init__(self, message: str, ms: int):
        super().__init__(message)
        self.ms = ms


async def _execute(run_id: int) -> None:
    inp = await _load_inputs(run_id)
    if inp is None:
        return
    state = inp["state"]
    steps, ctx = state["steps"], state["ctx"]
    current = inp["current"]

    if not llm_configured():
        await _finish_local(inp, state, "未配置 LLM 环境变量")
        return

    # 阶段 1：需求分析（失败则跳过，架构师直接从原话理解）
    if steps[0]["status"] not in ("done", "failed"):
        user = "\n\n".join(
            [
                f"【本次需求】\n{inp['prompt']}",
                f"【之前提过的需求（最近 {len(inp['history'])} 条）】\n{_hist(inp['history'])}",
                f"【当前应用蓝图】\n{_dump(current) if current else 'null（首次生成）'}",
                "请按系统要求输出需求简报 JSON。",
            ]
        )
        try:
            brief, ms = await _stage(state, 0, run_id, lambda: chat_json(ANALYST_SYS, user))
            ctx["brief"] = brief
            understanding = str(brief.get("understanding") or "").strip()[:60]
            steps[0].update(status="done", ms=ms, note=f"理解需求：{understanding}" if understanding else "产出需求简报")
        except _StageFailed as exc:
            steps[0].update(status="failed", ms=exc.ms, note=f"分析失败（{exc}），跳过该阶段")
        await _save_state(run_id, state)

    # 阶段 2：蓝图设计（失败则整体降级为规则引擎）
    draft = ctx.get("draft")
    if steps[1]["status"] != "done" or not draft:
        brief = ctx.get("brief")
        user = "\n\n".join(
            [
                f"【用户需求原话】\n{inp['prompt']}",
                f"【需求分析师简报】\n{_dump(brief) if brief else '（分析阶段失败，请直接从用户原话理解）'}",
                f"【当前应用蓝图（增量修改时保留未提及字段的 name）】\n{_dump(current) if current else 'null（首次生成）'}",
                "请输出完整 AppBlueprint JSON。",
            ]
        )
        try:
            raw, ms = await _stage(state, 1, run_id, lambda: chat_json(ARCHITECT_SYS, user))
            draft = normalize_blueprint(raw)
            if current is not None:
                draft["seed"] = []
            ctx["draft"] = draft
            steps[1].update(
                status="done",
                ms=ms,
                note=(
                    f"产出蓝图：{len(draft['data']['fields'])} 个字段 · {MODE_CN[draft['views']['mode']]}视图 · "
                    f"{len(draft['stats'])} 个统计 · {len(draft['seed'])} 条示例数据"
                ),
            )
            await _save_state(run_id, state)
        except (_StageFailed, BlueprintError) as exc:
            steps[1].update(status="failed", ms=getattr(exc, "ms", 0), note=f"设计失败（{_err(exc)}）")
            await _save_state(run_id, state)
            steps[1]["ms"] = getattr(exc, "ms", 0)
            await _finish_local(inp, state, "架构师阶段失败，整体降级")
            return

    # 阶段 3：质检修复（失败则沿用架构师蓝图）
    final_bp = draft
    if steps[2]["status"] not in ("done", "failed"):
        user = "\n\n".join(
            [f"【用户需求原话】\n{inp['prompt']}", f"【待质检蓝图】\n{_dump(draft)}", "请按检查清单输出修复后的完整蓝图 JSON。"]
        )
        try:
            raw, ms = await _stage(state, 2, run_id, lambda: chat_json(INSPECTOR_SYS, user))
            fixed = normalize_blueprint(raw)
            if current is not None:
                fixed["seed"] = []
            final_bp = fixed
            steps[2].update(status="done", ms=ms, note=_inspection_note(draft, fixed))
        except (_StageFailed, BlueprintError) as exc:
            steps[2].update(status="failed", ms=getattr(exc, "ms", 0), note=f"质检失败（{_err(exc)}），沿用架构师蓝图")
        ctx["final"] = final_bp
        await _save_state(run_id, state)
    elif ctx.get("final"):
        final_bp = ctx["final"]

    await _finalize(inp, final_bp, "agent", state)


def _inspection_note(before: dict[str, Any], after: dict[str, Any]) -> str:
    notes: list[str] = []
    b = {f["name"] for f in before["data"]["fields"]}
    a = {f["name"] for f in after["data"]["fields"]}
    if a - b:
        notes.append(f"补字段 {len(a - b)} 个")
    if b - a:
        notes.append(f"删字段 {len(b - a)} 个")
    for key, label in (("views", "修正视图"), ("stats", "修正统计"), ("app", "修正应用信息"), ("seed", "修正示例数据")):
        if before.get(key) != after.get(key):
            notes.append(label)
    return f"质检完成：{'、'.join(notes) if notes else '逐项核对通过'}"


async def _guarded(run_id: int) -> None:
    try:
        await _execute(run_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("AtomLab pipeline crashed for run %s", run_id)
        try:
            async with db_manager.session() as db:
                run = await db.get(Runs, run_id)
                state = parse_state(run.steps if run else None)
                await db.commit()
            await _fail_run(run_id, state, f"流水线异常：{_err(exc)}")
        except Exception:  # noqa: BLE001
            logger.exception("Failed to mark run %s as failed", run_id)
    finally:
        _ACTIVE.pop(run_id, None)


def schedule(run_id: int) -> bool:
    """在后台启动（或续跑）流水线，HTTP 请求立即返回。已在本进程运行时不重复调度。"""
    task = _ACTIVE.get(run_id)
    if task is not None and not task.done():
        return False
    _ACTIVE[run_id] = asyncio.create_task(_guarded(run_id))
    return True


def is_active(run_id: int) -> bool:
    task = _ACTIVE.get(run_id)
    return task is not None and not task.done()
