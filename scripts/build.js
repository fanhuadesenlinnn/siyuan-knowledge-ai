"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const packageZip = path.join(root, "package.zip");

function copyFile(name) {
  fs.copyFileSync(path.join(root, name), path.join(dist, name));
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else fs.copyFileSync(source, target);
  }
}

async function main() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.rmSync(packageZip, { force: true });
  fs.mkdirSync(dist, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(root, "index.js")],
    bundle: true,
    outfile: path.join(dist, "index.js"),
    format: "cjs",
    platform: "browser",
    target: "es2020",
    external: ["siyuan"],
    logLevel: "silent",
  });

  for (const file of ["plugin.json", "index.css", "README.md", "icon.png", "preview.png"]) {
    copyFile(file);
  }
  copyDir(path.join(root, "i18n"), path.join(dist, "i18n"));

  execFileSync("zip", ["-r", packageZip, "."], {
    cwd: dist,
    stdio: "inherit",
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
