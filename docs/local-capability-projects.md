# 本地 Hermes 能力项目

这个 Hermes runtime 本地接了两个能力项目。

| 能力 | 本地路径 | runtime 工具 |
|------|----------|--------------|
| Knowledge | `/Users/pipi/hermes-custom` | Capture、Library、RAG、Theme、Garden、Review、Canvas |
| Life | `/Users/pipi/hermes-life` | `record_life_event`、`life_tick` |

## 规则

不要把 Life 实现重新塞回 `hermes-custom`。

不要为了 Life 再启动第二个 Hermes gateway。

Hermes runtime 只负责消息入口、工具注册和投递；业务逻辑分别留在 Knowledge / Life 项目里。

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

