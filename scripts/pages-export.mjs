import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const port = 4173;
const server = spawn("npx", ["--yes", "srvx", "--static", ".vercel/output/static", ".vercel/output/functions/__server.func/index.mjs", "--port", String(port)], {
  stdio: "inherit",
  shell: false,
});

try {
  let html = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) {
        html = await response.text();
        break;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!html) throw new Error("Could not render the app for GitHub Pages");
  await mkdir(".vercel/output/static", { recursive: true });
  await writeFile(".vercel/output/static/index.html", html);
  await writeFile(".vercel/output/static/404.html", html);
} finally {
  server.kill();
}
