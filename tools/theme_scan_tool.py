"""Hermes tool: theme_scan — 手动触发主题聚类."""
from __future__ import annotations

import sys
sys.path.insert(0, "/Users/pipi/hermes-custom")

from bridge.theme_bridge import run_theme_scan
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

THEME_SCAN_SCHEMA = {
    "name": "theme_scan",
    "description": (
        "手动触发知识库主题聚类扫描，发现最近保存内容之间的关联。"
        "这是索引图谱优先的扫描：先用 identity/section embeddings 和元数据找关系，"
        "不再逐篇调用 LLM 精筛；LLM 只负责解释已经发现的候选关联。"
        "扫描发现关联时，Theme Agent 会说明这些材料的共同问题，"
        "并给出可沉淀方向，而不是要求用户先判断它是方法还是观点。"
        "如果返回“没有发现足够强的主题关联”，这不是扫描失败，"
        "只是当前材料之间的关系强度不够。"
        "如果工具返回“扫描不完整”或 warnings，必须如实告诉用户这次结果不可靠，"
        "不要改写成“知识库没有关联”。"
        "面向用户回复时尽量照抄 chat_preview，不要暴露 processed_ids 等内部 ID 列表。"
        "默认只扫描最近未扫描的新内容；当用户明确要求“重建主题页”"
        "“扫描全部知识库”“重新整理主题/MOC”时，传 rescan_all=true。"
        "如果用户只要求扫描最近内容，而工具返回“没有待扫描的新内容”，"
        "不要自动改成 rescan_all=true；应先问用户是否全库扫描。"
        "如果刚刚返回“没有待扫描的新内容”，而用户追问“有哪些内容/有哪些组/第一组是什么”，"
        "应调用 theme_candidates 查看已有候选组，不要用 search_my_notes 临时拼组。"
        "如果工具返回 next_actions，并且用户回复编号选择某一组，"
        "应使用对应 next_action.payload 的 question_id 调用 synthesize_garden，"
        "不要再用 search_my_notes 重新猜材料。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "rescan_all": {
                "type": "boolean",
                "description": (
                    "是否重扫已扫描过的 captures。默认 false；只有用户明确要求"
                    "重建/扫描全部/重新整理主题页时才设为 true。"
                ),
            },
            "export_file": {
                "type": "boolean",
                "description": "只有用户明确要求发文件、导出完整扫描报告或附件时才设为 true；普通扫描保持 false。",
            },
        },
        "required": [],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = run_theme_scan(
            rescan_all=bool(args.get("rescan_all")),
            export_file=bool(args.get("export_file", False)),
        )
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="theme", intent="run_theme_scan", exc=exc)


registry.register(
    name="theme_scan",
    toolset="personal-assistant",
    schema=THEME_SCAN_SCHEMA,
    handler=_handler,
    emoji="🔗",
)
