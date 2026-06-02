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
