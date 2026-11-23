# 本地 Hermes 能力项目

这个 Hermes runtime 接了两个能力项目：Knowledge 和 Life。

## 部署形态

Knowledge 的推荐生产形态是 HTTP 模式：设置 `HERMES_KNOWLEDGE_URL`（以及 `HERMES_KNOWLEDGE_TOKEN`）。Runtime 只负责消息入口、工具注册和投递；解析、存储、检索、卡片生成等业务逻辑都留在 Knowledge service 里。

| 配置 | 用途 | 生产可用 |
|------|------|----------|
| `HERMES_KNOWLEDGE_URL` + token | HTTP 模式，Dashboard 与工具委托 service | 是，推荐 |
| `HERMES_KNOWLEDGE_LOCAL_ROOT`（旧名 `HERMES_CUSTOM_ROOT`） | runtime 把本地 checkout 插入 `sys.path`，直接 import bridge 模块 | 否，仅开发和离线调试 |
| `HERMES_KNOWLEDGE_DB` / `HERMES_KNOWLEDGE_VAULT` | Dashboard 打开本地文件时定位 SQLite 和 Vault | 按功能配置 |

### Local fallback 仅限开发

`HERMES_KNOWLEDGE_LOCAL_ROOT` / `HERMES_CUSTOM_ROOT` 只用于开发和离线调试。它会让 runtime 直接导入另一个 checkout 的 Python 模块，把 runtime 进程和该 checkout 的依赖、目录布局绑在一起，因此不是生产部署方案。

local fallback 仍然保留，现有开发和离线流程可以继续用；但新代码不得扩大它：新增 Knowledge 能力应走 HTTP service contract，不要增加新的本地模块导入或文件读写入口。

### 打开本地文件和检查服务

HTTP 模式下，资料列表、卡片、草稿和伴读等业务请求由 Knowledge Service 处理。Dashboard 的「打开本地文件」在 Runtime 主机上查询 SQLite，并打开对应的资料 Markdown。在用到此功能时，确保 Runtime 能访问服务使用的路径：

- `HERMES_KNOWLEDGE_DB`：指向与 service 相同的 `captures.db`。
- `HERMES_KNOWLEDGE_VAULT`：指向与 service 相同的 vault 目录。

HTTP 模式下，未指定变量且没有本地 checkout 时，Runtime 使用 `~/Hermes/knowledge/data/captures.db` 和 `~/Hermes/knowledge`。需要打开本地文件的请求在找不到数据库或目标文件时会失败。自动化清单 `automation-boundaries` 也会解析 Vault 路径供展示。

`GET /api/knowledge/runtime-check` 在 HTTP 模式下只报告传输方式。检查服务连通性和依赖状态时，直接请求 Knowledge Service 的 `GET /api/health`，按服务配置带上 Bearer 令牌并查看响应中的 `status`。

### Garden 卡片草稿确认

`POST /api/garden/drafts` 只生成卡片草稿，不会保存卡片，也不提供 `auto_commit` 一次落卡的语义。用户在 Dashboard 确认后，Runtime 才为该 draft 申请一次性的 confirmation token，再调用 commit；合成和保存始终是两个步骤。

Runtime 使用 `/api/garden/drafts/preview`，因为旧服务的非预览接口会自动保存。通过 Dashboard 保存要求 Service 契约 v2 或以上。HTTP 的「停止」是协作式取消；界面等待服务结果，不会把取消请求的回执当成写入已经停止。

## 规则

不要把 Life 实现重新塞回 `hermes-custom`。

不要为了 Life 再启动第二个 Hermes gateway。

Hermes runtime 只负责消息入口、工具注册和投递；业务逻辑分别留在 Knowledge / Life 项目里。

不要为 Knowledge 新增 local fallback 调用点。HTTP 模式是生产路径，本地导入只服务于开发调试。

## Life 工具导入检查

```bash
cd "<repos>/hermes-agent-main"
.venv/bin/python -m pytest tests/tools/test_life_tools_imports.py -q
```

## 直接 smoke

```bash
cd "<repos>/hermes-agent-main"
.venv/bin/python - <<'PY'
from tools.record_life_event_tool import _handler as record_handler
from tools.life_tick_tool import _handler as tick_handler

print(record_handler({"message": "午饭吃了牛肉饭"})[:300])
print(tick_handler({"dry_run": True})[:300])
PY
```

预期：两个输出都是 JSON envelope，并且包含 `"agent": "life"`。
