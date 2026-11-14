"""AppBlueprint（应用蓝图）：归一化、记录校验、版本差异与 CSV 导出。

纯函数模块，不依赖数据库；与前端 `lib/atomlab/types.ts` 的类型保持一致。
"""

from __future__ import annotations

import copy
import math
import re
import unicodedata
from typing import Any

KINDS = ("text", "textarea", "number", "date", "select", "boolean")
MODES = ("table", "kanban", "cards")
STAT_TYPES = ("count", "sum", "avg", "ratio")
MODE_CN = {"table": "表格", "kanban": "看板", "cards": "卡片"}

_ACCENTS = ["#6c5ce7", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6"]
_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_RESERVED = {"id", "created_at", "updated_at", "project_id"}
MAX_FIELDS = 12
MAX_COLUMNS = 7
MAX_STATS = 3
MAX_SEED = 5


class BlueprintError(ValueError):
    """蓝图无法归一化（例如字段不足）。"""


def _s(value: Any, max_len: int) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        value = "true" if value else "false"
    return re.sub(r"\s+", " ", str(value)).strip()[:max_len]


def _slug(value: Any) -> str:
    text = unicodedata.normalize("NFKD", str(value if value is not None else ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    if text and text[0].isdigit():
        text = f"f_{text}"
    return text[:40]


def _pick_accent(seed_text: str) -> str:
    h = 0
    for ch in seed_text:
        h = (h * 31 + ord(ch)) % 997
    return _ACCENTS[h % len(_ACCENTS)]


def _pick_icon(value: Any) -> str:
    text = _s(value, 4)
    if not text:
        return "📦"
    ch = text[0]
    return ch if not re.match(r"^[a-zA-Z0-9\s#.,]$", ch) else "📦"


def to_number(value: Any) -> int | float | None:
    """转换为有限数值；布尔与非法输入返回 None。整数值保持 int。"""
    if isinstance(value, bool) or value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num):
        return None
    return int(num) if num.is_integer() else num


def _to_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "是", "y"}
    return bool(value)


def _options(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, (str, int, float)):
            continue
        label = _s(item, 16)
        if label and label not in out:
            out.append(label)
        if len(out) >= 8:
            break
    return out


def normalize_blueprint(raw: Any) -> dict[str, Any]:
    """把模型/规则引擎产出的原始蓝图整理成运行时可安全渲染的结构。

    越界内容修正或丢弃；有效字段少于 2 个时抛 BlueprintError，由调用方决定降级。
    """
    root = raw if isinstance(raw, dict) else {}
    data = root.get("data") if isinstance(root.get("data"), dict) else {}
    if isinstance(data.get("fields"), list):
        fields_raw = data["fields"]
    elif isinstance(root.get("fields"), list):
        fields_raw = root["fields"]
    else:
        fields_raw = []

    fields: list[dict[str, Any]] = []
    used: set[str] = set()
    for item in fields_raw:
        if len(fields) >= MAX_FIELDS or not isinstance(item, dict):
            continue
        name = _slug(item.get("name", item.get("key")))
        label = _s(item.get("label", item.get("name")), 24) or name
        if not name:
            name = _slug(label) or "field"
        candidate, i = name, 2
        while candidate in used or candidate in _RESERVED:
            candidate = f"{name}_{i}"
            i += 1
        name = candidate

        kind = str(item.get("kind", item.get("type", ""))).lower()
        if kind not in KINDS:
            kind = "text"
        options: list[str] | None = None
        if kind == "select":
            options = _options(item.get("options"))
            if len(options) < 2:
                kind, options = "text", None

        field: dict[str, Any] = {"name": name, "label": label, "kind": kind, "required": bool(item.get("required"))}
        if options:
            field["options"] = options
        hint = _s(item.get("hint", item.get("placeholder")), 40)
        if hint:
            field["hint"] = hint
        if kind == "number" and item.get("display") in ("currency", "percent"):
            field["display"] = item["display"]
        used.add(name)
        fields.append(field)
    if len(fields) < 2:
        raise BlueprintError("蓝图字段不足（至少 2 个）")

    by_name = {f["name"]: f for f in fields}

    views_raw = root.get("views") if isinstance(root.get("views"), dict) else {}
    if views_raw.get("mode") in MODES:
        mode = views_raw["mode"]
    elif root.get("layout") in ("kanban", "cards"):
        mode = root["layout"]
    else:
        mode = "table"

    cols_src = views_raw.get("columns")
    if not isinstance(cols_src, list):
        cols_src = views_raw.get("visibleFields") if isinstance(views_raw.get("visibleFields"), list) else []
    columns: list[str] = []
    for col in cols_src:
        hit = by_name.get(_slug(col))
        if hit and hit["name"] not in columns:
            columns.append(hit["name"])
        if len(columns) >= MAX_COLUMNS:
            break
    if not columns:
        columns = [f["name"] for f in fields[:5]]

    group_by: str | None = None
    if views_raw.get("groupBy"):
        g = by_name.get(_slug(views_raw["groupBy"]))
        if g and g["kind"] == "select":
            group_by = g["name"]
    if mode == "kanban":
        if not group_by:
            group_by = next((f["name"] for f in fields if f["kind"] == "select"), None)
        if not group_by:
            mode = "table"
    if group_by and group_by not in columns:
        columns.insert(0, group_by)

    actions_raw = root.get("actions") if isinstance(root.get("actions"), dict) else {}
    actions = {k: True if actions_raw.get(k) is None else bool(actions_raw.get(k)) for k in ("create", "update", "remove")}

    app_raw = root.get("app") if isinstance(root.get("app"), dict) else {}
    app_name = _s(app_raw.get("name") or root.get("name") or root.get("title"), 20) or "未命名应用"
    accent_raw = _s(app_raw.get("accent") or app_raw.get("primaryColor"), 7)
    app = {
        "name": app_name,
        "tagline": _s(app_raw.get("tagline") or app_raw.get("description"), 40),
        "icon": _pick_icon(app_raw.get("icon")),
        "accent": accent_raw.lower() if _HEX_RE.match(accent_raw) else _pick_accent(app_name),
    }

    stats: list[dict[str, Any]] = []
    for st in root.get("stats") if isinstance(root.get("stats"), list) else []:
        if len(stats) >= MAX_STATS or not isinstance(st, dict):
            continue
        label = _s(st.get("label"), 16)
        stype = st.get("type") if st.get("type") in STAT_TYPES else "count"
        if not label or any(x["label"] == label for x in stats):
            continue
        field = None if stype == "count" else by_name.get(_slug(st.get("field")))
        if stype in ("sum", "avg") and (not field or field["kind"] != "number"):
            continue
        stat: dict[str, Any] = {"label": label, "type": stype}
        if field:
            stat["field"] = field["name"]
        if stype == "ratio":
            wf = by_name.get(_slug(st.get("whereField")))
            wv = _s(st.get("whereValue"), 24)
            if not wf or wf["kind"] != "select" or wv not in wf.get("options", []):
                continue
            stat["whereField"] = wf["name"]
            stat["whereValue"] = wv
        stats.append(stat)

    if isinstance(data.get("seed"), list):
        seed_raw = data["seed"]
    elif isinstance(root.get("seed"), list):
        seed_raw = root["seed"]
    else:
        seed_raw = []
    seed: list[dict[str, Any]] = []
    for row in seed_raw:
        if len(seed) >= MAX_SEED or not isinstance(row, dict):
            continue
        cleaned: dict[str, Any] = {}
        bad = False
        for f in fields:
            v = row.get(f["name"])
            if v is None or v == "":
                continue
            if f["kind"] == "number":
                num = to_number(v)
                if num is None:
                    bad = True
                    break
                cleaned[f["name"]] = num
            elif f["kind"] == "boolean":
                cleaned[f["name"]] = _to_bool(v)
            elif f["kind"] == "select":
                sv = _s(v, 24)
                if sv not in f.get("options", []):
                    bad = True
                    break
                cleaned[f["name"]] = sv
            elif f["kind"] == "date":
                sv = _s(v, 10)
                if not _DATE_RE.match(sv):
                    bad = True
                    break
                cleaned[f["name"]] = sv
            else:
                cleaned[f["name"]] = _s(v, 200)
        if bad or any(f["required"] and cleaned.get(f["name"]) in (None, "") for f in fields):
            continue
        seed.append(cleaned)

    views: dict[str, Any] = {"mode": mode, "columns": columns[:MAX_COLUMNS]}
    if group_by:
        views["groupBy"] = group_by
    return {
        "app": app,
        "data": {"entity": _s(data.get("entity") or data.get("entityName"), 8) or "记录", "fields": fields},
        "views": views,
        "actions": actions,
        "stats": stats,
        "seed": seed,
    }


def validate_record(bp: dict[str, Any], payload: Any, partial: bool) -> tuple[list[str], dict[str, Any]]:
    """按蓝图做服务端校验（必填 / 枚举 / 数值 / 日期）。partial=True 时只校验提供的键。"""
    errors: list[str] = []
    clean: dict[str, Any] = {}
    by_name = {f["name"]: f for f in bp["data"]["fields"]}
    for key, value in (payload or {}).items() if isinstance(payload, dict) else []:
        field = by_name.get(key)
        if not field:
            continue
        if value is None or value == "":
            if partial:
                clean[key] = None if field["kind"] == "number" else ""
            continue
        kind = field["kind"]
        if kind in ("text", "textarea"):
            clean[key] = _s(value, 2000 if kind == "textarea" else 200)
        elif kind == "number":
            num = to_number(value)
            if num is None:
                errors.append(f"{field['label']} 必须是数字")
            else:
                clean[key] = num
        elif kind == "date":
            sv = _s(value, 10)
            if not _DATE_RE.match(sv):
                errors.append(f"{field['label']} 需要 YYYY-MM-DD 格式的日期")
            else:
                clean[key] = sv
        elif kind == "select":
            sv = _s(value, 24)
            if sv not in field.get("options", []):
                errors.append(f"{field['label']} 的取值不在选项内")
            else:
                clean[key] = sv
        else:
            clean[key] = _to_bool(value)
    if not partial:
        for field in bp["data"]["fields"]:
            if field.get("required") and clean.get(field["name"]) in (None, ""):
                errors.append(f"{field['label']} 为必填项")
    return errors, clean


def diff_blueprint(prev: dict[str, Any] | None, nxt: dict[str, Any]) -> list[str]:
    if not prev:
        parts = [f"首次生成：{len(nxt['data']['fields'])} 个字段", f"{MODE_CN[nxt['views']['mode']]}视图"]
        if nxt["stats"]:
            parts.append(f"{len(nxt['stats'])} 个统计卡")
        if nxt["seed"]:
            parts.append(f"{len(nxt['seed'])} 条示例数据")
        return parts
    out: list[str] = []
    old = {f["name"]: f for f in prev["data"]["fields"]}
    new = {f["name"]: f for f in nxt["data"]["fields"]}
    added = [f["label"] for n, f in new.items() if n not in old]
    removed = [n for n in old if n not in new]
    if added:
        out.append(f"新增字段：{'、'.join(added)}")
    if removed:
        out.append(f"移除字段 {len(removed)} 个")
    changed = [
        f["label"]
        for n, f in new.items()
        if n in old
        and (
            old[n]["label"] != f["label"]
            or old[n]["kind"] != f["kind"]
            or old[n].get("options", []) != f.get("options", [])
        )
    ]
    if changed:
        out.append(f"调整字段：{'、'.join(changed)}")
    if prev["views"]["mode"] != nxt["views"]["mode"]:
        out.append(f"视图切换为{MODE_CN[nxt['views']['mode']]}")
    if bool(prev["stats"]) != bool(nxt["stats"]):
        out.append("增加统计卡片" if nxt["stats"] else "移除统计卡片")
    if prev["app"]["name"] != nxt["app"]["name"]:
        out.append(f"应用更名为「{nxt['app']['name']}」")
    return out or ["蓝图细节微调，结构保持不变"]


def to_csv(bp: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    """生成带 BOM 的 CSV，保证 Excel 直接打开中文不乱码。"""

    def esc(v: Any) -> str:
        sv = "" if v is None else str(v)
        return f'"{sv.replace(chr(34), chr(34) * 2)}"' if re.search(r'[",\n]', sv) else sv

    fields = bp["data"]["fields"]
    lines = [",".join(esc(f["label"]) for f in fields)]
    for row in rows:
        cells = []
        for f in fields:
            v = row.get(f["name"])
            if f["kind"] == "boolean":
                v = "是" if v else "否"
            cells.append(esc(v))
        lines.append(",".join(cells))
    return "\ufeff" + "\n".join(lines)


def clone(bp: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(bp)
