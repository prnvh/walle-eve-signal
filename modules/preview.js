import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

// Show the latest run, or the saved example if no local run exists yet.
export async function startPreview(port = 4173) {
  let html;
  try {
    html = await readFile("runs/replay.html", "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    html = await readFile(new URL("../examples/replay.html", import.meta.url), "utf8");
  }

  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(html);
  });

  // Wait until the server is ready. Errors go back to the calling function.
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
