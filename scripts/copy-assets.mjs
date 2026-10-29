import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await Promise.all([
  copyFile("index.html", "dist/index.html"),
  copyFile("styles.css", "dist/styles.css"),
]);
