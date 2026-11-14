"""OpenAI 兼容 /chat/completions 的最小异步客户端，只收 JSON 对象。

配置只在调用时从环境变量读取（由 Atoms Cloud Keys 注入）：
LLM_BASE_URL、LLM_API_KEY、LLM_MODEL、LLM_TIMEOUT_MS、LLM_MAX_TOKENS，
可选 LLM_EXTRA_BODY（JSON，供应商特有参数，如关闭思考模式）。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

import httpx


class LLMError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def _int_env(name: str, default: int) -> int:
    try:
        value = int(float(_env(name)))
        return value if value > 0 else default
    except ValueError:
        return default


def llm_configured() -> bool:
    return bool(_env("LLM_API_KEY") and _env("LLM_BASE_URL") and _env("LLM_MODEL"))


def llm_timeout_seconds() -> float:
    return _int_env("LLM_TIMEOUT_MS", 90000) / 1000


def _body(system: str, user: str, json_mode: bool) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": _env("LLM_MODEL"),
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.4,
        "max_tokens": _int_env("LLM_MAX_TOKENS", 4096),
        "stream": False,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    extra = _env("LLM_EXTRA_BODY")
    if extra:
        try:
            parsed = json.loads(extra)
            if isinstance(parsed, dict):
                body.update(parsed)
        except ValueError:
            pass
    return body


async def _post(body: dict[str, Any]) -> dict[str, Any]:
    url = _env("LLM_BASE_URL").rstrip("/") + "/chat/completions"
    headers = {"Authorization": f"Bearer {_env('LLM_API_KEY')}", "Content-Type": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=llm_timeout_seconds()) as client:
            res = await client.post(url, headers=headers, json=body)
    except httpx.TimeoutException as exc:
        raise LLMError(f"LLM 请求超时（{int(llm_timeout_seconds())}s）") from exc
    except httpx.HTTPError as exc:
        raise LLMError(f"无法连接 LLM 服务：{type(exc).__name__}") from exc
    if res.status_code >= 400:
        raise LLMError(f"LLM 服务返回 HTTP {res.status_code}：{res.text[:160]}", res.status_code)
    try:
        return res.json()
    except ValueError as exc:
        raise LLMError("LLM 响应不是合法 JSON") from exc


async def _post_with_retry(body: dict[str, Any]) -> dict[str, Any]:
    """连接级失败（无 HTTP 状态码）时等待 1.5s 重试一次；超时不重试，避免拖垮整体耗时。"""
    try:
        return await _post(body)
    except LLMError as exc:
        if exc.status is None and "超时" not in str(exc):
            await asyncio.sleep(1.5)
            return await _post(body)
        raise


_THINK_RE = re.compile(r"<think(?:ing)?>.*?</think(?:ing)?>", re.S | re.I)
_FENCE_RE = re.compile(r"```(?:json|JSON)?\s*(.*?)```", re.S)


def extract_json_object(text: str) -> dict[str, Any]:
    """从 LLM 输出中提取 JSON 对象。

    容忍：<think> 思考块、```json 代码块包裹、前后杂散说明文字、推理过程中夹带的 {...}。
    通过括号配对（感知字符串与转义）扫描所有平衡的顶层对象，靠后的候选优先
    （思考模型的最终答案通常位于推理之后），并优先尝试代码块内容。
    """
    cleaned = _THINK_RE.sub("", text or "").strip()
    candidates: list[str] = []

    def scan(source: str) -> None:
        depth, start, in_str, esc = 0, -1, False, False
        for i, ch in enumerate(source):
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif ch == "}" and depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    candidates.append(source[start : i + 1])

    scan(cleaned)
    for block in _FENCE_RE.findall(cleaned):
        scan(block.strip())

    for cand in reversed(candidates):
        for attempt in (cand, re.sub(r",\s*([}\]])", r"\1", cand)):  # 容忍尾逗号
            try:
                parsed = json.loads(attempt)
            except ValueError:
                continue
            if isinstance(parsed, dict):
                return parsed
    raise LLMError("LLM 输出中找不到可解析的 JSON 对象")


async def chat_json(system: str, user: str) -> dict[str, Any]:
    """一次真实 LLM 调用，返回解析后的 JSON 对象。"""
    if not llm_configured():
        raise LLMError("未配置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL")
    try:
        payload = await _post_with_retry(_body(system, user, json_mode=True))
    except LLMError as exc:
        if exc.status == 400:  # 部分兼容网关不接受 response_format
            payload = await _post_with_retry(_body(system, user, json_mode=False))
        else:
            raise
    try:
        message = payload["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMError("LLM 响应缺少 choices") from exc
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise LLMError("LLM 返回内容为空（可能被思考内容占满输出额度）")
    return extract_json_object(content)
