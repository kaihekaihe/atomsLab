"""AtomLab 业务接口：/api/v1/atomlab/*。

所有登录接口按 current_user.id 隔离；分享读取接口免登录，仅凭随机 token 只读访问。
"""

from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone
from typing import Any, Optional

from core.database import get_db
from dependencies.auth import get_current_user
from fastapi import APIRouter, Depends, HTTPException, Response
from models.blueprints import Blueprints
from models.projects import Projects
from models.records import Records
from models.runs import Runs
from models.shares import Shares
from pydantic import BaseModel
from schemas.auth import UserResponse
from services import atomlab_pipeline as pipeline
from services.blueprint import diff_blueprint, normalize_blueprint, to_csv, validate_record
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/v1/atomlab", tags=["atomlab"])


class ProjectIn(BaseModel):
    name: str
    description: Optional[str] = ""


class ProjectPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


class GenerateIn(BaseModel):
    prompt: str


class RecordIn(BaseModel):
    data: dict[str, Any]


def _iso(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _loads(text: Optional[str], default: Any) -> Any:
    try:
        return json.loads(text) if text else default
    except ValueError:
        return default


def _record_view(row: Records) -> dict[str, Any]:
    return {"id": row.id, "data": _loads(row.data, {}), "created_at": _iso(row.created_at), "updated_at": _iso(row.updated_at)}


async def _project(db: AsyncSession, project_id: int, user_id: str) -> Projects:
    project = await db.scalar(select(Projects).where(Projects.id == project_id, Projects.user_id == user_id))
    if project is None:
        raise HTTPException(status_code=404, detail="项目不存在")
    return project


async def _active_blueprint(db: AsyncSession, project: Projects) -> Optional[dict[str, Any]]:
    if not project.active_blueprint_id:
        return None
    row = await db.get(Blueprints, project.active_blueprint_id)
    return _loads(row.data, None) if row is not None else None


async def _records(db: AsyncSession, project_id: int, user_id: str) -> list[Records]:
    rows = await db.scalars(
        select(Records).where(Records.project_id == project_id, Records.user_id == user_id).order_by(Records.id.asc())
    )
    return list(rows)


def _run_brief(run: Runs) -> dict[str, Any]:
    return {
        "id": run.id,
        "prompt": run.prompt,
        "status": run.status or "running",
        "error": run.error or "",
        "engine": run.engine or "",
        "steps": pipeline.public_steps(run.steps),
        "created_at": _iso(run.created_at),
    }


# ---------------------------------------------------------------- projects


@router.get("/projects")
async def list_projects(user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    counts = (
        select(Records.project_id, func.count(Records.id).label("n"))
        .where(Records.user_id == user.id)
        .group_by(Records.project_id)
        .subquery()
    )
    rows = await db.execute(
        select(Projects, func.coalesce(counts.c.n, 0))
        .outerjoin(counts, counts.c.project_id == Projects.id)
        .where(Projects.user_id == user.id)
        .order_by(Projects.updated_at.desc(), Projects.id.desc())
    )
    return {
        "projects": [
            {
                "id": p.id,
                "name": p.name,
                "description": p.description or "",
                "active_version": p.active_version,
                "record_count": int(n),
                "updated_at": _iso(p.updated_at),
            }
            for p, n in rows.all()
        ]
    }


@router.post("/projects", status_code=201)
async def create_project(body: ProjectIn, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    name = body.name.strip()[:40]
    if not name:
        raise HTTPException(status_code=400, detail="项目名不能为空")
    project = Projects(name=name, description=(body.description or "").strip()[:200], user_id=user.id)
    db.add(project)
    await db.commit()
    return {"project": {"id": project.id, "name": project.name, "description": project.description or ""}}


@router.get("/projects/{project_id}")
async def get_project(project_id: int, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    project = await _project(db, project_id, user.id)
    blueprint = await _active_blueprint(db, project)
    versions = await db.scalars(
        select(Blueprints).where(Blueprints.project_id == project.id, Blueprints.user_id == user.id).order_by(Blueprints.version.desc())
    )
    runs = await db.scalars(
        select(Runs).where(Runs.project_id == project.id, Runs.user_id == user.id).order_by(Runs.id.desc()).limit(20)
    )
    share = await db.scalar(select(Shares).where(Shares.project_id == project.id, Shares.user_id == user.id))
    records = await _records(db, project.id, user.id)
    return {
        "project": {
            "id": project.id,
            "name": project.name,
            "description": project.description or "",
            "created_at": _iso(project.created_at),
            "active_version": project.active_version,
        },
        "blueprint": blueprint,
        "versions": [
            {"id": v.id, "version": v.version, "engine": v.engine or "", "source_prompt": v.source_prompt or "", "created_at": _iso(v.created_at)}
            for v in versions
        ],
        "runs": [_run_brief(r) for r in reversed(list(runs))],
        "shareToken": share.token if share else None,
        "records": [_record_view(r) for r in records],
    }


@router.patch("/projects/{project_id}")
async def update_project(
    project_id: int, body: ProjectPatch, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    project = await _project(db, project_id, user.id)
    if body.name is not None:
        name = body.name.strip()[:40]
        if not name:
            raise HTTPException(status_code=400, detail="项目名不能为空")
        project.name = name
    if body.description is not None:
        project.description = body.description.strip()[:200]
    await db.commit()
    return {"project": {"id": project.id, "name": project.name, "description": project.description or ""}}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: int, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    project = await _project(db, project_id, user.id)
    for model in (Records, Blueprints, Runs, Shares):
        await db.execute(delete(model).where(model.project_id == project.id, model.user_id == user.id))
    await db.delete(project)
    await db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- generation


@router.post("/projects/{project_id}/generate", status_code=202)
async def generate(
    project_id: int, body: GenerateIn, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    project = await _project(db, project_id, user.id)
    prompt = body.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="请输入需求描述")
    if len(prompt) > 2000:
        raise HTTPException(status_code=400, detail="需求描述过长（最多 2000 字）")
    running = await db.scalar(
        select(Runs).where(Runs.project_id == project.id, Runs.user_id == user.id, Runs.status == "running")
    )
    if running is not None:
        raise HTTPException(status_code=409, detail="已有生成任务在进行中，请稍候")
    run = Runs(
        project_id=project.id,
        prompt=prompt,
        status="running",
        steps=json.dumps(pipeline.new_state(), ensure_ascii=False),
        engine="",
        error="",
        user_id=user.id,
    )
    db.add(run)
    project.updated_at = datetime.now(timezone.utc)
    await db.commit()
    pipeline.schedule(run.id)
    return {"runId": run.id}


@router.get("/runs/{run_id}")
async def get_run(run_id: int, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    run = await db.scalar(select(Runs).where(Runs.id == run_id, Runs.user_id == user.id))
    if run is None:
        raise HTTPException(status_code=404, detail="生成任务不存在")
    result = None
    if run.status == "done" and run.blueprint_id:
        bp_row = await db.get(Blueprints, run.blueprint_id)
        if bp_row is not None:
            blueprint = _loads(bp_row.data, None)
            prev_row = await db.scalar(
                select(Blueprints)
                .where(Blueprints.project_id == run.project_id, Blueprints.version < bp_row.version)
                .order_by(Blueprints.version.desc())
                .limit(1)
            )
            prev = _loads(prev_row.data, None) if prev_row is not None else None
            result = {
                "version": bp_row.version,
                "engine": bp_row.engine or run.engine or "",
                "blueprint": blueprint,
                "diff": diff_blueprint(prev, blueprint) if blueprint else [],
            }
    view = {
        "run": {
            "id": run.id,
            "prompt": run.prompt,
            "status": run.status or "running",
            "error": run.error or "",
            "engine": run.engine or "",
            "created_at": _iso(run.created_at),
            "updated_at": _iso(run.updated_at),
        },
        "steps": pipeline.public_steps(run.steps),
        "result": result,
    }
    # 后台任务被中断（实例回收/重启）时，由轮询自动续跑；阶段产物已落库，不会重复已完成阶段。
    if run.status == "running" and not pipeline.is_active(run.id):
        updated = run.updated_at or run.created_at
        if updated is not None and updated.tzinfo is None:
            updated = updated.replace(tzinfo=timezone.utc)
        idle = (datetime.now(timezone.utc) - updated).total_seconds() if updated else 1e9
        if idle > pipeline.stale_after_seconds():
            await db.commit()
            pipeline.schedule(run.id)
    return view


# ---------------------------------------------------------------- records


async def _require_blueprint(db: AsyncSession, project: Projects) -> dict[str, Any]:
    bp = await _active_blueprint(db, project)
    if bp is None:
        raise HTTPException(status_code=400, detail="请先生成应用蓝图")
    return bp


@router.post("/projects/{project_id}/records", status_code=201)
async def create_record(
    project_id: int, body: RecordIn, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    project = await _project(db, project_id, user.id)
    bp = await _require_blueprint(db, project)
    if not bp["actions"].get("create", True):
        raise HTTPException(status_code=403, detail="该应用未开放新增")
    errors, clean = validate_record(bp, body.data, partial=False)
    if errors:
        raise HTTPException(status_code=422, detail="；".join(errors))
    row = Records(project_id=project.id, data=json.dumps(clean, ensure_ascii=False), user_id=user.id)
    db.add(row)
    project.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"record": _record_view(row)}


async def _record(db: AsyncSession, project_id: int, record_id: int, user_id: str) -> Records:
    row = await db.scalar(
        select(Records).where(Records.id == record_id, Records.project_id == project_id, Records.user_id == user_id)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    return row


@router.put("/projects/{project_id}/records/{record_id}")
async def update_record(
    project_id: int,
    record_id: int,
    body: RecordIn,
    user: UserResponse = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    project = await _project(db, project_id, user.id)
    bp = await _require_blueprint(db, project)
    if not bp["actions"].get("update", True):
        raise HTTPException(status_code=403, detail="该应用未开放编辑")
    row = await _record(db, project.id, record_id, user.id)
    errors, clean = validate_record(bp, body.data, partial=True)
    merged = {**_loads(row.data, {}), **clean}
    for field in bp["data"]["fields"]:
        if field.get("required") and field["name"] in clean and merged.get(field["name"]) in (None, ""):
            errors.append(f"{field['label']} 为必填项")
    if errors:
        raise HTTPException(status_code=422, detail="；".join(errors))
    row.data = json.dumps(merged, ensure_ascii=False)
    row.updated_at = datetime.now(timezone.utc)
    project.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"record": _record_view(row)}


@router.delete("/projects/{project_id}/records/{record_id}")
async def delete_record(
    project_id: int, record_id: int, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    project = await _project(db, project_id, user.id)
    bp = await _require_blueprint(db, project)
    if not bp["actions"].get("remove", True):
        raise HTTPException(status_code=403, detail="该应用未开放删除")
    row = await _record(db, project.id, record_id, user.id)
    await db.delete(row)
    await db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- versions


@router.post("/projects/{project_id}/versions/{version_id}/restore", status_code=201)
async def restore_version(
    project_id: int, version_id: int, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)
):
    """恢复 = 以旧版本内容创建一个新版本并激活；不改动任何业务记录。"""
    project = await _project(db, project_id, user.id)
    source = await db.scalar(
        select(Blueprints).where(Blueprints.id == version_id, Blueprints.project_id == project.id, Blueprints.user_id == user.id)
    )
    if source is None:
        raise HTTPException(status_code=404, detail="版本不存在")
    running = await db.scalar(select(Runs.id).where(Runs.project_id == project.id, Runs.status == "running"))
    if running is not None:
        raise HTTPException(status_code=409, detail="生成任务进行中，请稍后再恢复版本")
    bp = normalize_blueprint(_loads(source.data, {}))
    bp["seed"] = []
    max_ver = await db.scalar(select(func.coalesce(func.max(Blueprints.version), 0)).where(Blueprints.project_id == project.id))
    version = int(max_ver or 0) + 1
    row = Blueprints(
        project_id=project.id,
        version=version,
        data=json.dumps(bp, ensure_ascii=False),
        source_prompt=f"恢复自 v{source.version}",
        engine="restore",
        user_id=user.id,
    )
    db.add(row)
    await db.flush()
    project.active_blueprint_id = row.id
    project.active_version = version
    project.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {"version": version, "blueprint": bp}


# ---------------------------------------------------------------- share & export


@router.post("/projects/{project_id}/publish")
async def publish(project_id: int, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    project = await _project(db, project_id, user.id)
    await _require_blueprint(db, project)
    share = await db.scalar(select(Shares).where(Shares.project_id == project.id, Shares.user_id == user.id))
    if share is None:
        share = Shares(project_id=project.id, token=secrets.token_urlsafe(18), user_id=user.id)
        db.add(share)
        await db.commit()
    return {"token": share.token}


@router.delete("/projects/{project_id}/publish")
async def unpublish(project_id: int, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    project = await _project(db, project_id, user.id)
    await db.execute(delete(Shares).where(Shares.project_id == project.id, Shares.user_id == user.id))
    await db.commit()
    return {"ok": True}


@router.get("/share/{token}")
async def read_share(token: str, db: AsyncSession = Depends(get_db)):
    share = await db.scalar(select(Shares).where(Shares.token == token)) if re.fullmatch(r"[A-Za-z0-9_-]{8,64}", token) else None
    project = await db.get(Projects, share.project_id) if share is not None else None
    if share is None or project is None or project.user_id != share.user_id:
        raise HTTPException(status_code=404, detail="分享链接不存在或已失效")
    blueprint = await _active_blueprint(db, project)
    if blueprint is None:
        raise HTTPException(status_code=404, detail="该应用尚未生成")
    records = await _records(db, project.id, project.user_id)
    return {"project": {"name": project.name}, "blueprint": blueprint, "records": [_record_view(r) for r in records]}


@router.get("/projects/{project_id}/export")
async def export_csv(project_id: int, user: UserResponse = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    project = await _project(db, project_id, user.id)
    bp = await _require_blueprint(db, project)
    rows = [_loads(r.data, {}) for r in await _records(db, project.id, user.id)]
    name = re.sub(r'[\\/:*?"<>|\s]+', "_", project.name).strip("_") or "export"
    return {"filename": f"{name}.csv", "csv": to_csv(bp, rows), "count": len(rows)}


@router.get("/health")
async def health(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {"ok": True}
