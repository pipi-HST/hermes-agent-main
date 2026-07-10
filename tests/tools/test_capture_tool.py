"""Tests for Capture tool routing guidance."""
from __future__ import annotations


def test_capture_content_schema_accepts_document_file_paths():
    import tools.capture_tool as tool

    description = tool.CAPTURE_SCHEMA["description"]
    content_description = (
        tool.CAPTURE_SCHEMA["parameters"]["properties"]["content"]["description"]
    )

    assert "文档文件路径" in description
    assert ".docx" in description
    assert ".pdf" in description
    assert "不要要求用户粘贴正文" in description
    assert "工具读取文档正文后处理" in content_description


def test_capture_schema_keeps_coverage_separate_from_presentation_contract():
    import tools.capture_tool as tool

    description = tool.CAPTURE_SCHEMA["description"]
    instruction_description = (
        tool.CAPTURE_SCHEMA["parameters"]["properties"]["instruction"]["description"]
    )

    assert "全文入库表示覆盖全文，不等于一字不改原样保存" in description
    assert "正式 Capture 始终需要可读性整理、章节、目录和重点加粗" in description
    assert "只传用户原话" in instruction_description
    assert "不要把“全文入库”扩写成“一字不改”" in instruction_description


def test_capture_handler_uses_user_wording_as_instruction_contract(monkeypatch):
    import json
    import tools.capture_tool as tool

    observed: dict[str, str] = {}

    def fake_capture(content: str, **kwargs):
        observed["content"] = content
        observed["instruction"] = kwargs.get("instruction", "")
        return {"status": "success"}

    monkeypatch.setattr(tool, "do_capture", fake_capture)

    payload = json.loads(tool._handler(
        {
            "content": "https://example.test/article",
            "instruction": "全文原文入库，一字不改保存正文",
        },
        user_task="这个篇文章全文入库：https://example.test/article",
    ))

    assert payload["status"] == "success"
    assert observed["instruction"] == "这个篇文章全文入库"


def test_revise_tools_do_not_claim_new_documents():
    import tools.refine_capture_tool as refine_tool
    import tools.revise_capture_draft_tool as revise_tool

    refine_description = refine_tool.REFINE_SCHEMA["description"]
    revise_description = revise_tool.REVISE_CAPTURE_DRAFT_SCHEMA["description"]

    assert "发送新文档" in refine_description
    assert "capture_content(content=文件路径或链接" in refine_description
    assert "不要调用本工具" in refine_description
    assert "发送新文档" in revise_description
    assert "capture_content(content=文件路径或链接" in revise_description
    assert "不要调用本工具" in revise_description
