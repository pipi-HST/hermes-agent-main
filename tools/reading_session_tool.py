"""Hermes tools: Reading Session — 阅读讨论会话."""
from __future__ import annotations

from tools.hermes_custom_envelope import (
    envelope_error_json,
    envelope_success_json,
)
from tools.registry import registry

START_SCHEMA = {
    "name": "start_reading_session",
    "description": (
        "开始一个临时阅读讨论会话并自动提取链接正文（支持微信公众号 mp.weixin.qq.com、"
        "小红书、普通网页）。用于两种场景：(1) 用户纯发链接/材料未说明意图时先做只读速览；"
        "(2) 用户围绕文章/链接/Capture/文件/截图问“讲了什么”“这段什么意思”“怎么看”等理解问题。"
        "重要：本工具会自动在只读模式下抓取 source_url 正文并在 meta.extracted_text 中返回，"
        "无需调用 web_extract 或 execute_code 写爬虫；且绝不生成 Capture 草稿、不保存入库。"
        "只有用户明确要求保存、存库、整理入库、全文保存时，才调用 capture_content。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "message": {"type": "string", "description": "用户原始问题。"},
            "source_url": {"type": "string", "description": "当前材料链接，没有则为空。"},
            "capture_id": {"type": "string", "description": "已保存 Capture id，没有则为空。"},
            "draft_id": {"type": "string", "description": "Capture 草稿 id，没有则为空。"},
            "excerpt": {"type": "string", "description": "用户粘贴的原文摘录，没有则为空。"},
            "file_ref": {"type": "string", "description": "用户上传文件路径，没有则为空。"},
            "image_ref": {"type": "string", "description": "用户上传图片路径，没有则为空。"},
        },
        "required": [],
    },
}

DISCUSS_SCHEMA = {
    "name": "discuss_reading",
    "description": (
        "记录并返回当前 Reading Session 的一轮讨论。适合主 Agent 已经围绕原文、"
        "知识库或网页资料解释清楚后，把 user message、assistant_answer 和实际使用的"
        "轻量 evidence 写入 session。不要用它来保存正式笔记。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": {"type": "string", "description": "Reading Session id；为空时使用最近 active session。"},
            "message": {"type": "string", "description": "用户本轮问题。"},
            "focus": {"type": "string", "description": "本轮讨论焦点。"},
            "assistant_answer": {
                "type": "string",
                "description": "准备发给用户的解释。应按理解逻辑组织，不机械按来源类型分区。",
            },
            "evidence": {
                "type": "array",
                "description": "本轮实际使用的轻量依据，只保存短摘录。",
                "items": {
                    "type": "object",
                    "properties": {
                        "source_kind": {"type": "string", "description": "original | knowledge_base | web"},
                        "source_id": {"type": "string"},
                        "title": {"type": "string"},
                        "url": {"type": "string"},
                        "excerpt": {"type": "string"},
                        "used_for": {"type": "string"},
                    },
                },
            },
        },
        "required": ["message"],
    },
}

SHOW_SCHEMA = {
    "name": "show_reading_session",
    "description": "查看当前或指定 Reading Session 的来源、焦点、最近问题和已记录依据。",
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": {"type": "string", "description": "Reading Session id；为空时使用最近 active session。"},
        },
        "required": [],
    },
}

SUMMARIZE_SCHEMA = {
    "name": "summarize_reading_session",
    "description": (
        "把 Reading Session 整理成可审阅草稿。只有用户明确要求“整理进笔记/保存讨论/"
        "补进原文/合并到主笔记/做成知识卡片”时才调用。output_type 不明确时传空，"
        "工具会返回 1/2/3 确认问题：原文增强版主笔记、Capture Note、知识卡片。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": {"type": "string", "description": "Reading Session id；为空时使用最近 active session。"},
            "output_type": {
                "type": "string",
                "description": "enhance_capture | local_learning_note | knowledge_card；不确定时传空。",
            },
            "instruction": {"type": "string", "description": "用户关于整理形态和侧重点的原话。"},
        },
        "required": [],
    },
}

COMMIT_SCHEMA = {
    "name": "commit_reading_artifact",
    "description": (
        "用户确认后提交 Reading Draft。enhance_capture 会备份旧 Capture 并写回主笔记；"
        "local_learning_note 会写入知识库正式记录；knowledge_card 会写入结构化知识卡片。"
        "只有用户明确确认时才调用。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "draft_id": {"type": "string", "description": "Reading Draft id；为空时默认最近 open draft。"},
        },
        "required": [],
    },
}


def _reading_bridge():
    """Bind the reading bridge calls through the shared dispatch helper.

    Local mode keeps the previous behaviour (validated checkout + direct
    import); HTTP mode routes each call to the knowledge service, so the
    reading session tools work without a local checkout.
    """
    from tools.hermes_custom_envelope import call_custom_bridge

    def _bind(function_name: str):
        def _call(*args, **kwargs):
            return call_custom_bridge("reading_bridge", function_name, *args, **kwargs)

        return _call

    return {
        "commit": _bind("commit_reading_artifact"),
        "discuss": _bind("discuss_reading"),
        "show": _bind("show_reading_session"),
        "start": _bind("start_reading_session"),
        "summarize": _bind("summarize_reading_session"),
    }


def do_start(**kwargs):
    return _reading_bridge()["start"](**kwargs)


def do_discuss(**kwargs):
    return _reading_bridge()["discuss"](**kwargs)


def do_show(**kwargs):
    return _reading_bridge()["show"](**kwargs)


def do_summarize(**kwargs):
    return _reading_bridge()["summarize"](**kwargs)


def do_commit(**kwargs):
    return _reading_bridge()["commit"](**kwargs)


def _start_handler(args: dict, **kw) -> str:
    try:
        return envelope_success_json(
            do_start(
                message=args.get("message", ""),
                source_url=args.get("source_url", ""),
                capture_id=args.get("capture_id", ""),
                draft_id=args.get("draft_id", ""),
                excerpt=args.get("excerpt", ""),
                file_ref=args.get("file_ref", ""),
                image_ref=args.get("image_ref", ""),
            )
        )
    except Exception as exc:
        return envelope_error_json(agent="reading", intent="start_reading_session", exc=exc)


def _discuss_handler(args: dict, **kw) -> str:
    try:
        return envelope_success_json(
            do_discuss(
                session_id=args.get("session_id", ""),
                message=args.get("message", ""),
                focus=args.get("focus", ""),
                assistant_answer=args.get("assistant_answer", ""),
                evidence=args.get("evidence") or [],
            )
        )
    except Exception as exc:
        return envelope_error_json(agent="reading", intent="discuss_reading", exc=exc)


def _show_handler(args: dict, **kw) -> str:
    try:
        return envelope_success_json(do_show(session_id=args.get("session_id", "")))
    except Exception as exc:
        return envelope_error_json(agent="reading", intent="show_reading_session", exc=exc)


def _summarize_handler(args: dict, **kw) -> str:
    try:
        return envelope_success_json(
            do_summarize(
                session_id=args.get("session_id", ""),
                output_type=args.get("output_type", ""),
                instruction=args.get("instruction", ""),
            )
        )
    except Exception as exc:
        return envelope_error_json(agent="reading", intent="summarize_reading_session", exc=exc)


def _commit_handler(args: dict, **kw) -> str:
    try:
        return envelope_success_json(
            do_commit(
                draft_id=args.get("draft_id", ""),
                confirmation=kw.get("user_task", ""),
            )
        )
    except Exception as exc:
        return envelope_error_json(agent="reading", intent="commit_reading_artifact", exc=exc)


registry.register(
    name=START_SCHEMA["name"],
    toolset="personal-assistant",
    schema=START_SCHEMA,
    handler=_start_handler,
    emoji="📖",
)
registry.register(
    name=DISCUSS_SCHEMA["name"],
    toolset="personal-assistant",
    schema=DISCUSS_SCHEMA,
    handler=_discuss_handler,
    emoji="💬",
)
registry.register(
    name=SHOW_SCHEMA["name"],
    toolset="personal-assistant",
    schema=SHOW_SCHEMA,
    handler=_show_handler,
    emoji="📚",
)
registry.register(
    name=SUMMARIZE_SCHEMA["name"],
    toolset="personal-assistant",
    schema=SUMMARIZE_SCHEMA,
    handler=_summarize_handler,
    emoji="📝",
)
registry.register(
    name=COMMIT_SCHEMA["name"],
    toolset="personal-assistant",
    schema=COMMIT_SCHEMA,
    handler=_commit_handler,
    emoji="✅",
)
