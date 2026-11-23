"""Hermes Knowledge Dashboard plugin router."""
from plugins.web_knowledge.routes import (
    _KNOWLEDGE_DEFAULT_FOLDERS,
    _KnowledgeLibrarySelectionChatBody,
    _knowledge_capture_library_item,
    _knowledge_conn,
    _knowledge_custom_module,
    _knowledge_custom_root,
    _knowledge_db_path,
    _knowledge_file_url,
    _knowledge_local_root,
    _knowledge_selection_chat_messages,
    _knowledge_vault_path,
    _new_capture_agent,
    register_knowledge_routes,
    router,
)

__all__ = [
    "_KNOWLEDGE_DEFAULT_FOLDERS",
    "_KnowledgeLibrarySelectionChatBody",
    "_knowledge_capture_library_item",
    "_knowledge_conn",
    "_knowledge_custom_module",
    "_knowledge_custom_root",
    "_knowledge_db_path",
    "_knowledge_file_url",
    "_knowledge_local_root",
    "_knowledge_selection_chat_messages",
    "_knowledge_vault_path",
    "_new_capture_agent",
    "register_knowledge_routes",
    "router",
]
