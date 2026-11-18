from pathlib import Path

from gateway.attachment_policy import (
    AgentReply,
    collect_local_attachments,
    register_knowledge_exports,
)


def test_requested_successful_knowledge_export_is_granted(tmp_path):
    root = tmp_path / "knowledge"
    export_dir = root / "data" / "exports" / "rag"
    export_dir.mkdir(parents=True)
    report = export_dir / "answer.md"
    report.write_text("# Report\n", encoding="utf-8")
    result = {
        "status": "success",
        "durable_artifacts": [{
            "type": "rag_answer_report",
            "status": "created",
            "path": str(report),
        }],
    }

    with collect_local_attachments("请把这份报告以文件的形式发给我") as granted:
        register_knowledge_exports(
            root,
            "rag_bridge",
            "search_knowledge_base",
            {"export_file": True},
            result,
        )
        reply = AgentReply("已生成报告", tuple(granted.values()))

    assert reply.local_media() == [(str(report), False)]
