import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const host = "127.0.0.1";
const port = 9120;
const root = dirname(fileURLToPath(import.meta.url));
const demoPath = join(root, "knowledge-layout-focus-demo.html");

const server = createServer(async (req, res) => {
  if (req.url !== "/" && req.url !== "/knowledge-layout-focus-demo.html") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }

  try {
    const html = await readFile(demoPath);
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
    });
    res.end(html);
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  console.log(`Hermes layout demo: http://${host}:${port}/knowledge-layout-focus-demo.html`);
});
