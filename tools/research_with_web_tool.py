"""Hermes tool: research_with_web — 本地知识库 + 联网研究."""
from __future__ import annotations

import asyncio
import threading
from typing import Any

from tools.hermes_custom_envelope import (
    envelope_error_json,
    envelope_success_json,
)
from tools.registry import registry

WEB_CONTEXT_ANSWER_STYLE_CONTRACT = (
    "回答应以解决用户问题为第一目标；如果表格有助于比较、分类或辅助扫描，可以使用表格；"
    "表格只能辅助理解，不能替代回答。"
)


async def async_web_assist_answer(**kwargs):
    """Research entry point: local checkout or the knowledge service.

    In HTTP mode the service runs the async bridge in its threadpool, so the
    blocking client call is pushed off this event loop.  Older checkouts only
    ship ``async_light_web_answer``; that case is a 404 from the dispatcher and
    an ``AttributeError`` in local mode.
    """
    from integrations.hermes_knowledge.client import KnowledgeNotFound
    from tools.hermes_custom_envelope import call_custom_bridge

    try:
        return await asyncio.to_thread(
            call_custom_bridge,
            "research_bridge",
            "async_web_assist_answer",
            **kwargs,
        )
    except (KnowledgeNotFound, AttributeError):
        return await asyncio.to_thread(
            call_custom_bridge,
            "research_bridge",
            "async_light_web_answer",
            **kwargs,
        )


_async_research_entry = async_web_assist_answer

RESEARCH_WITH_WEB_SCHEMA = {
    "name": "research_with_web",
    "description": (
        "Hermes Knowledge 研究工具：结合当前文章、个人知识库和公开网页证据回答研究问题。"
        "是否调用本工具由主模型根据用户意图和可用上下文判断；mode 由用户显式选择、"
        "调用方结构化参数或研究 planner 决定。不要把私人文章全文发给搜索引擎；"
        "工具会通过 planner 生成受限 web_search query，并使用网页上下文答疑链路。"
        "回答必须保留 [K1]/[K2] 本地知识库引用和 [W1]/[W2] 联网来源引用，"
        f"完整答案遵循回答风格合同：{WEB_CONTEXT_ANSWER_STYLE_CONTRACT}"
        "代码负责引用合法性和预算边界，语义取舍由回答模型在候选材料内完成。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "用户问题。",
            },
            "mode": {
                "type": "string",
                "enum": ["current_article_only", "local_only", "local_web", "web_only"],
                "description": "检索模式。默认 local_web；隐私优先用 local_only；只查公开信息用 web_only。",
                "default": "local_web",
            },
            "article_context": {
                "type": "object",
                "description": "可选，当前文章上下文，包括 title/body/folder_path/kind/id。",
            },
            "selection_context": {
                "type": "object",
                "description": "可选，用户选中文本和前后文。",
            },
            "export_file": {
                "type": "boolean",
                "description": "用户明确要求导出完整研究报告时为 true；普通回答为 false。",
                "default": False,
            },
            "force_web": {
                "type": "boolean",
                "description": "用户已明确开启联网搜索时为 true；强制至少执行一次公开网页检索。",
                "default": False,
            },
        },
        "required": ["query"],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        progress_callback = kw.get("tool_progress_callback")
        result = _run_research_coro(
            _async_research_entry(
                query=args.get("query", ""),
                mode=args.get("mode", "local_web"),
                article_context=args.get("article_context") or None,
                selection_context=args.get("selection_context") or None,
                export_file=bool(args.get("export_file", False)),
                force_web=bool(args.get("force_web", False)),
                event_callback=_research_event_callback(progress_callback),
            )
        )
        result["meta"] = {
            **result.get("meta", {}),
            "handler_instruction": (
                "网页端和工作台最终回答使用 meta.answer；短消息通道可使用 chat_preview；"
                f"完整答案遵循回答风格合同：{WEB_CONTEXT_ANSWER_STYLE_CONTRACT}"
                "保留 [K]/[W] 引用；保存为笔记或卡片时把 source_map/meta.sources 一起传给 save_answer_to_knowledge。"
            ),
        }
        return envelope_success_json(result)
    except Exception as exc:
        return envelope_error_json(agent="research", intent="research_answer", exc=exc)


def _run_research_coro(coro):
    """Run the research coroutine from sync tool dispatch paths."""
    try:
        running_loop = asyncio.get_running_loop()
    except RuntimeError:
        running_loop = None

    if not (running_loop and running_loop.is_running()):
        return asyncio.run(coro)

    box: dict[str, Any] = {}

    def _run_in_thread() -> None:
        try:
            box["result"] = asyncio.run(coro)
        except BaseException as exc:
            box["error"] = exc

    thread = threading.Thread(target=_run_in_thread, name="research-with-web-runner", daemon=True)
    thread.start()
    thread.join()
    if "error" in box:
        raise box["error"]
    return box.get("result")


def _research_event_callback(progress_callback):
    async def _on_event(event: dict[str, Any]) -> None:
        if not progress_callback:
            return
        label = _research_event_label(event)
        if not label:
            return
        payload = _research_event_payload(event)
        try:
            progress_callback(
                "research.progress",
                "research_with_web",
                label,
                None,
                **payload,
            )
        except Exception:
            pass

    return _on_event


def _research_event_label(event: dict[str, Any]) -> str:
    event_type = str(event.get("type") or "")
    if event_type == "planning_start":
        return "规划检索任务"
    if event_type == "plan":
        queries = event.get("queries") or []
        return f"已规划 {len(queries)} 个查询" if queries else "已完成检索规划"
    if event_type == "queries_ready":
        queries = event.get("queries") or []
        return f"已准备 {len(queries)} 个搜索关键词" if queries else "已准备搜索关键词"
    if event_type == "local_search_start":
        return "检索本地知识库"
    if event_type == "local_search_done":
        sources = event.get("knowledge_sources") or []
        return f"本地知识库返回 {len(sources)} 个来源"
    if event_type == "web_search_start":
        queries = event.get("queries") or []
        return f"开始联网搜索 {len(queries)} 个查询"
    if event_type == "web_query_start":
        return f"搜索：{event.get('query') or ''}".strip()
    if event_type == "web_query_done":
        sources = event.get("web_sources") or []
        return f"发现 {len(sources)} 个网页候选"
    if event_type in {"web_rank_done", "web_ranked", "web_rewrite_done", "web_fallback_done"}:
        sources = event.get("web_sources") or []
        return f"候选排序完成：{len(sources)} 个网页"
    if event_type == "materials_selected":
        candidate_count = int(event.get("candidate_count") or 0)
        material_count = int(event.get("material_count") or 0)
        opened_pages = int(event.get("opened_pages") or 0)
        if opened_pages:
            return f"找到 {candidate_count} 个网页，准备读取 {opened_pages} 页"
        return f"找到 {candidate_count} 个网页，已选择 {material_count} 个摘要来源"
    if event_type == "web_classify_done":
        candidates = event.get("candidate_sources") or []
        clues = event.get("clue_sources") or []
        rejected = event.get("rejected_sources") or []
        return f"筛选来源：候选 {len(candidates)}，线索 {len(clues)}，拒绝 {len(rejected)}"
    if event_type == "web_extract_start":
        opened_pages = int(event.get("opened_pages") or 0)
        urls = event.get("urls") or []
        count = opened_pages or len(urls) or len(event.get("web_sources") or [])
        return f"正在读取 {count} 个网页"
    if event_type == "web_extract_done":
        sources = event.get("web_sources") or []
        opened_pages = int(event.get("opened_pages") or 0)
        extracted_pages = int(event.get("extracted_pages") or 0)
        summary_only_pages = int(event.get("summary_only_pages") or 0)
        if opened_pages and not extracted_pages and summary_only_pages:
            return "网页正文读取失败，已使用搜索摘要"
        if opened_pages:
            return f"网页读取完成：全文 {extracted_pages} 页，摘要 {summary_only_pages} 个"
        return f"已使用搜索摘要：{len(sources)} 个来源"
    if event_type == "evidence_critic_done":
        sources = event.get("web_sources") or []
        rejected = event.get("rejected_sources") or []
        return f"证据裁判完成：采用 {len(sources)}，拒绝 {len(rejected)}"
    if event_type == "web_fallback_start":
        return "证据不足，启动补充搜索"
    if event_type == "web_rewrite_start":
        return "搜索质量不足，重写查询词"
    if event_type == "web_query_error":
        return f"搜索失败：{event.get('query') or ''}".strip()
    if event_type == "warnings":
        warnings = event.get("warnings") or []
        return str(warnings[0]) if warnings else "检索产生警告"
    if event_type == "synthesis_start":
        return "基于已采用证据生成回答"
    return ""


def _research_event_payload(event: dict[str, Any]) -> dict[str, Any]:
    event_type = str(event.get("type") or "")
    payload: dict[str, Any] = {
        "stage": event_type,
        "status": "warning" if event_type in {"warnings", "web_query_error"} else "running",
    }
    for key in (
        "queries",
        "web_sources",
        "candidate_sources",
        "clue_sources",
        "rejected_sources",
        "warnings",
        "candidate_count",
        "material_count",
        "opened_pages",
        "extracted_pages",
        "summary_only_pages",
        "result_count",
        "path",
    ):
        if key in event:
            payload[key] = event[key]
    if event_type in {"materials_selected", "web_extract_done", "evidence_critic_done", "synthesis_start"}:
        payload["status"] = "completed"
    return payload


registry.register(
    name=RESEARCH_WITH_WEB_SCHEMA["name"],
    toolset="knowledge-research",
    schema=RESEARCH_WITH_WEB_SCHEMA,
    handler=_handler,
    emoji="🌐",
    max_result_size_chars=120_000,
)
