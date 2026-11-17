# 本地 Hermes 能力项目

这个 Hermes runtime 接了两个能力项目：Knowledge 和 Life。

## 部署形态

Knowledge 的推荐生产形态是 HTTP 模式：设置 `HERMES_KNOWLEDGE_URL`（以及 `HERMES_KNOWLEDGE_TOKEN`）。Runtime 只负责消息入口、工具注册和投递；解析、存储、检索、卡片生成等业务逻辑都留在 Knowledge service 里。

| 配置 | 用途 | 生产可用 |
|------|------|----------|
| `HERMES_KNOWLEDGE_URL` + token | HTTP 模式，Dashboard 与工具委托 service | 是，推荐 |
| `HERMES_KNOWLEDGE_LOCAL_ROOT`（旧名 `HERMES_CUSTOM_ROOT`） | runtime 把本地 checkout 插入 `sys.path`，直接 import bridge 模块 | 否，仅开发和离线调试 |
| `HERMES_KNOWLEDGE_DB` / `HERMES_KNOWLEDGE_VAULT` | Dashboard 少数读路由直接读取 SQLite / vault 的路径 | 已知例外，不是 HTTP 模式必需配置 |

### Local fallback 仅限开发

`HERMES_KNOWLEDGE_LOCAL_ROOT` / `HERMES_CUSTOM_ROOT` 只用于开发和离线调试。它会让 runtime 直接导入另一个 checkout 的 Python 模块，把 runtime 进程和该 checkout 的依赖、目录布局绑在一起，因此不是生产部署方案。

local fallback 仍然保留，现有开发和离线流程可以继续用；但新代码不得扩大它：新增 Knowledge 能力应走 HTTP service contract，不要增加新的本地模块导入或文件读写入口。

### Dashboard 读路由的已知例外

HTTP 模式下大多数 Knowledge 读写已经委托给 service，但仍有少数路径会解析或读取本地 SQLite / vault（例如 automation-boundaries 的路径展示，以及 service 未覆盖时的本地兼容分支）。这些路径的例外配置是：

- `HERMES_KNOWLEDGE_DB`：指向与 service 相同的 `captures.db`。
- `HERMES_KNOWLEDGE_VAULT`：指向与 service 相同的 vault 目录。

它们不是 HTTP 模式的必需配置。未设置时，这些读路径使用 `~/Hermes/knowledge` 下的约定路径；文件不存在时对应路由返回 404，不会因此关闭整个 Knowledge 功能。只有在命中这些读路由、且需要读取 service 之外的真实数据时，才需要显式设置。

## 规则

不要把 Life 实现重新塞回 `hermes-custom`。

不要为了 Life 再启动第二个 Hermes gateway。

Hermes runtime 只负责消息入口、工具注册和投递；业务逻辑分别留在 Knowledge / Life 项目里。

不要为 Knowledge 新增 local fallback 调用点。HTTP 模式是生产路径，本地导入只服务于开发调试。

## Life 工具导入检查

```bash
cd /Users/pipi/Downloads/hermes-agent-main
.venv/bin/python -m pytest tests/tools/test_life_tools_imports.py -q
```

## 直接 smoke

```bash
cd /Users/pipi/Downloads/hermes-agent-main
.venv/bin/python - <<'PY'
from tools.record_life_event_tool import _handler as record_handler
from tools.life_tick_tool import _handler as tick_handler

print(record_handler({"message": "午饭吃了牛肉饭"})[:300])
print(tick_handler({"dry_run": True})[:300])
PY
```

预期：两个输出都是 JSON envelope，并且包含 `"agent": "life"`。
