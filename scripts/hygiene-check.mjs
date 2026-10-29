import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["src", "tests", "scripts"];
const extensions = new Set([".ts", ".mjs", ".css", ".html", ".json", ".yml", ".md"]);
const ignoredDirectories = new Set(["node_modules", "dist", ".git"]);
const failures = [];

async function visit(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await visit(join(path, entry.name));
    } else if (extensions.has(extname(entry.name))) {
      const file = join(path, entry.name);
      const content = await readFile(file, "utf8");
      if (!content.endsWith("\n")) failures.push(`${file}: missing final newline`);
      if (/[ \t]+$/m.test(content)) failures.push(`${file}: trailing whitespace`);
    }
  }
}

for (const root of [...roots, ".github"]) await visit(root);
for (const file of ["index.html", "styles.css", "README.md", "package.json", "tsconfig.json", "tsconfig.build.json", ".gitignore", ".npmrc", ".editorconfig", "LICENSE"]) {
  try {
    const content = await readFile(file, "utf8");
    if (!content.endsWith("\n")) failures.push(`${file}: missing final newline`);
    if (/[ \t]+$/m.test(content)) failures.push(`${file}: trailing whitespace`);
  } catch { /* Optional during bootstrap. */ }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Formatting hygiene checks passed.\n");
}
