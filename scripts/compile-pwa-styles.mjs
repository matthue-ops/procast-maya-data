// Development only. Pages deploys the committed CSS without installing npm packages.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), "procast-css-"));
try {
  const args = [
    "-i",
    "styles/tailwind.css",
    "--content",
    "index.html",
    "-o",
    path.join(temp, "app.css"),
    "--minify",
  ];
  if (process.env.MAYA_TAILWIND_CLI)
    execFileSync(process.execPath, [process.env.MAYA_TAILWIND_CLI, ...args], {
      cwd: root,
      stdio: "inherit",
    });
  else
    execFileSync(
      "npx",
      ["--yes", "--package=tailwindcss@3.4.17", "tailwindcss", ...args],
      { cwd: root, stdio: "inherit" },
    );
  const hash = createHash("sha256")
    .update(await readFile(path.join(root, "index.html")))
    .update(await readFile(path.join(root, "styles/tailwind.css")))
    .update("tailwindcss@3.4.17")
    .digest("hex");
  const css = await readFile(path.join(temp, "app.css"), "utf8");
  await writeFile(
    path.join(root, "vendor/tailwind/app.css"),
    `/* Procast styles source-sha256: ${hash} */\n${css}\n`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
