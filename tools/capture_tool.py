"""Hermes tool: capture_content — 内容捕获入库."""
from __future__ import annotations

import sys

HERMES_CUSTOM = "/Users/pipi/hermes-custom"
if HERMES_CUSTOM not in sys.path:
    sys.path.insert(0, HERMES_CUSTOM)

from bridge.capture_bridge import capture_content as do_capture
from bridge.result_envelope import envelope_json
from tools.hermes_custom_envelope import envelope_error_json
from tools.registry import registry

CAPTURE_SCHEMA = {
    "name": "capture_content",
    "description": (
        "提取内容并生成待确认草稿。支持四种输入：\n"
        "1. 链接URL：直接把用户发的链接传给 content（包括微信公众号 mp.weixin.qq.com、"
        "小红书 xhslink.com/xiaohongshu.com、普通网页等）。小红书会按图文笔记处理："
        "先展开分享短链，提取标题/正文/多张图片，并对图片按顺序 OCR 后一起生成草稿；"
        "普通网页会自动抓取网页正文。\n"
        "2. 图片文件路径：当用户发送图片时，你会看到类似 [User sent an image: /tmp/xxx.jpg] "
        "的占位文本——提取其中的文件路径（如 /tmp/xxx.jpg）传给 content，工具会自动做 OCR "
        "提取图中文字并生成草稿。\n"
        "3. 文档文件路径：当用户发送 .md/.txt/.docx/.pdf 等文档时，你会看到本地绝对路径"
        "（如 /Users/.../.hermes/cache/documents/doc_xxx_整理稿.md）。如果用户要求总结、"
        "提取、整理、保存或入库该文档，直接把这个文件路径传给 content，"
        "不要要求用户粘贴正文，也不要假设文档正文已经注入给你。\n"
        "4. 语音/音频转写文本：微信语音消息会自动转成文字传给你，直接把转写文本传给 content "
        "即可，和发普通文本一样处理。\n"
        "如果用户同时要求总结/提取/改写/全文保存/全文入库/全文存储/全文存进数据库，"
        "把用户的原话尽量完整放入 instruction，不要只传 URL，"
        "不要自行压缩、改写或把“着重阐述”改成“只保留”。"
        "Capture 会按用户意图识别四种材料整理契约：全文原文入库（正文一字不改保存）、"
        "精炼整理稿、重点定向整理、原文增强版笔记。"
        "你不要自己替 Capture 改写契约，只要传入原始材料和用户原话。"
        "工具会生成待确认整理稿并返回微信可读预览。重要：本工具不会正式入库。"
        "即使用户在同一条消息里说“提取后入库/整理后存库”，也先生成待审草稿；"
        "只有用户看到草稿后，在后续独立消息确认“确认存库/存库/就这样”，"
        "或前端点击确认入库时，才调用 commit_capture_draft。"
        "生成草稿后，直接把工具返回的 USER_VISIBLE_REPLY 发给用户，不要自动调用 show_capture_draft；"
        "只有用户后续明确要求“展开草稿/查看草稿/看全文/继续看”时才调用 show_capture_draft。"
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "content": {
                "type": "string",
                "description": (
                    "用户发来的原始内容。可以是：(1) URL链接，工具自动抓取网页；"
                    "小红书链接会提取图文和图片 OCR；"
                    "(2) 图片文件路径（如 /tmp/xxx.jpg），工具自动 OCR；"
                    "(3) 文档文件路径（如 /Users/.../doc_xxx.md、.txt、.docx、.pdf），"
                    "工具读取文档正文后处理；"
                    "(4) 语音转写文本或普通文本，直接作为草稿内容处理。"
                ),
            },
            "instruction": {
                "type": "string",
                "description": (
                    "可选。用户同条消息里的整理要求；尽量把用户原话放入 instruction，"
                    "不要自行总结成更短指令。"
                    "例如'总结全文核心观点'、'提取某某部分'、'全文保存'、"
                    "'全文存储'、'全文存进数据库'、'一字不改全文原文入库'、"
                    "'整理成原文增强版笔记'。"
                    "如果用户说“着重/特别阐述某部分”，表示保留全文主要脉络并加重这些部分，"
                    "不要改写成只保留这些部分，除非用户明确说“只要/仅保留”。"
                ),
            },
        },
        "required": ["content"],
    },
}


def _handler(args: dict, **kw) -> str:
    try:
        result = do_capture(args.get("content", ""), instruction=args.get("instruction", ""))
        return envelope_json(result)
    except Exception as exc:
        return envelope_error_json(agent="capture", intent="create_capture_draft", exc=exc)


registry.register(
    name="capture_content",
    toolset="personal-assistant",
    schema=CAPTURE_SCHEMA,
    handler=_handler,
    emoji="📥",
)
