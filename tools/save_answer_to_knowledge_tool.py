"""Hermes tool: save_answer_to_knowledge — 保存优秀回答为可审阅知识草稿."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.answer_bridge import save_answer_to_knowledge as do_save
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

SAVE_ANSWER_SCHEMA = {
    "name": "save_answer_to_knowledge",
    "description": (
        "把当前对话中一段高质量 AI 回答保存为可审阅知识草稿。适合用户说"
        "“把刚才这段存起来”“这个解释很好，做成卡片”“保存这轮讨论”等。"
        "不要直接写 Knowledge File；工具只生成 reading_draft。"
        "如果要保存的是刚才 search_my_notes/RAG 的完整回答，answer_source 传 latest_rag_full_answer，"
        "避免把微信或前端里被截断/压缩的预览存成正文。"
        "如果用户要求补进主笔记但回答涉及多个 Capture，工具会要求用户选择目标。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "hermes_session_id": {"type": "string", "description": "当前 Hermes 会话 id。"},
            "user_message": {"type": "string", "description": "被保存回答对应的用户问题。"},
            "assistant_answer": {"type": "string", "description": "要保存的 AI 回答原文。"},
            "instruction": {"type": "string", "description": "用户关于保存形态的原话。"},
            "output_type": {
                "type": "string",
                "enum": ["auto", "local_learning_note", "knowledge_card", "enhance_capture"],
                "description": "保存形态；不确定传 auto。",
            },
            "assistant_message_id": {"type": "string", "description": "前端消息 id；没有则为空。"},
            "sources": {
                "type": "array",
                "description": "实际引用来源，来自回答引用、工具结果或主 Agent 上下文。",
                "items": {"type": "object"},
            },
            "target_capture_id": {
                "type": "string",
                "description": "明确要补进的 Capture id；不明确时留空。",
            },
            "answer_source": {
                "type": "string",
                "enum": ["auto", "provided", "latest_rag_full_answer"],
                "description": "保存内容来源；保存刚才 RAG 完整回答时传 latest_rag_full_answer，否则传 auto。",
            },
        },
        "required": ["assistant_answer"],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        return envelope_json(
            do_save(
                hermes_session_id=args.get("hermes_session_id", ""),
                user_message=args.get("user_message", ""),
                assistant_answer=args.get("assistant_answer", ""),
                instruction=args.get("instruction", ""),
                output_type=args.get("output_type", "auto"),
                assistant_message_id=args.get("assistant_message_id", ""),
                sources=args.get("sources") or [],
                target_capture_id=args.get("target_capture_id", ""),
                answer_source=args.get("answer_source", "auto"),
            )
        )
    except Exception as exc:
        return envelope_error_json(agent="reading", intent="save_answer_to_knowledge", exc=exc)


registry.register(
    name=SAVE_ANSWER_SCHEMA["name"],
    toolset="personal-assistant",
    schema=SAVE_ANSWER_SCHEMA,
    handler=_handler,
    emoji="💾",
)
