# Hermes Agent — Web UI

Browser-based dashboard for the Knowledge workspace, sessions, configuration, API keys, and other Hermes Agent settings.

## Stack

- **Vite** + **React 19** + **TypeScript**
- **Tailwind CSS v4** with Hermes Paper as the default theme
- **Nous Research UI** components and local UI primitives

## Development

```bash
# From the repository root, start the Dashboard backend
python -m hermes_cli.main dashboard --no-open

# In another terminal at the repository root, start Vite with HMR
cd web/
npm ci
npm run dev
```

The Vite dev server defaults to the FastAPI backend at `http://127.0.0.1:9119`. Set `HERMES_DASHBOARD_URL` before starting Vite if the backend uses a different address.

## Build

```bash
npm run build
```

This outputs to `../hermes_cli/web_dist/`, which the FastAPI server serves as a static SPA. The built assets are included in the Python package via `pyproject.toml` package-data.

## Structure

```
src/
├── components/ui/   # Reusable UI primitives (Card, Badge, Button, Input, etc.)
├── lib/
│   ├── api.ts       # API client — typed fetch wrappers for all backend endpoints
│   └── utils.ts     # cn() helper for Tailwind class merging
├── pages/
│   ├── KnowledgeChatPage        # Topic workbench and default landing page
│   ├── KnowledgeLibraryPage     # Library and assisted reading
│   ├── KnowledgeCardsBoardPage  # Knowledge card gallery
│   ├── ConfigPage   # Dynamic config editor (reads schema from backend)
│   └── EnvPage      # API key management with save/clear
├── App.tsx          # Main layout and navigation
├── main.tsx         # React entry point
└── index.css        # Tailwind imports and theme variables
```
