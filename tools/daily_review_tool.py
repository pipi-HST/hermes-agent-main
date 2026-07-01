"""Hermes tool: daily_review — 手动触发艾宾浩斯每日复习."""
from __future__ import annotations

from tools.hermes_custom_envelope import call_custom_bridge, envelope_error_json, envelope_success_json
from tools.registry import registry

REVIEW_SCHEMA = {
    "name": "daily_review",
    "description": (
        "触发每日知识复习，根据艾宾浩斯遗忘曲线推送需要回顾的内容。"
        "调用后如果用户追问“展开一下”“讲深一点”“举例”“这对我有什么启发”，"
        "应调用 review_followup 沿刚刚讲过的回顾项继续讲。"
        "只有用户明确要求“对比”“关联其他文章”“找相关材料”时，才调用 search_my_notes。"
    ),
    "parameters": {
        "type": "object",
        "properties": {},
        "required": [],
    },
}


def run_daily_review():
    return call_custom_bridge("review_bridge", "run_daily_review")


def _handler(args: dict, **kw) -> str:
    try:
        result = run_daily_review()
        return envelope_success_json(result)
    except Exception as exc:
        return envelope_error_json(agent="review", intent="run_daily_review", exc=exc)


registry.register(
    name="daily_review",
    toolset="knowledge-review",
    schema=REVIEW_SCHEMA,
    handler=_handler,
    emoji="📖",
)
