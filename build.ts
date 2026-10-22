import { cp, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { zipSync } from "fflate";

import { name, version } from "./package.json";

const formatSize = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(2)} KB`);

const manifest: chrome.runtime.ManifestV3 = {
  manifest_version: 3,
  version,
  name: "PR Panel for GitHub",
  description: "Side panel with GitHub PRs awaiting my review and my open PRs.",
  minimum_chrome_version: "120",
  permissions: ["sidePanel", "storage", "alarms"],
  host_permissions: ["https://github.com/*"],
  background: {
    type: "module",
    service_worker: "background.js",
  },
  side_panel: {
    default_path: "sidepanel.html",
  },
  icons: {
    16: "assets/images/icon-16.png",
    32: "assets/images/icon-32.png",
    48: "assets/images/icon-48.png",
    128: "assets/images/icon-128.png",
  },
  action: {
    default_title: "PR Panel",
    default_icon: {
      16: "assets/images/icon-16.png",
      32: "assets/images/icon-32.png",
    },
  },
};

await rm("dist", { recursive: true, force: true });
await Bun.write(`dist/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
await cp("assets", `dist/assets`, { recursive: true });
await cp("LICENSE", "dist/LICENSE");

const start = performance.now();
const result = await Bun.build({
  entrypoints: ["src/background.ts", "src/sidepanel.html"],
  outdir: "dist",
  target: "browser",
  naming: "[name].[ext]",
});
if (!result.success) {
  throw new AggregateError(result.logs, "Extension build failed");
}

const rows = result.outputs.map((output) => ({
  path: relative("dist", output.path),
  size: formatSize(output.size),
  kind: output.kind,
}));

const width = Math.max(...rows.map((row) => row.path.length));
for (const row of rows) {
  console.log(`  ${row.path.padEnd(width)}  ${row.size.padStart(8)}  (${row.kind})`);
}
console.log(`\n  ${rows.length} files in ${Math.round(performance.now() - start)}ms`);

if (Bun.argv.includes("--zip")) {
  const files: Record<string, Uint8Array> = {};
  const paths = Array.from(new Bun.Glob("**/*").scanSync({ cwd: "dist", onlyFiles: true })).sort();
  for (const path of paths) {
    files[path.replaceAll(sep, "/")] = await Bun.file(join("dist", path)).bytes();
  }
  const archive = zipSync(files);
  const archivePath = `releases/${name}-${manifest.version}.zip`;
  await Bun.write(archivePath, archive);
  console.log(`\n  ${archivePath}  ${formatSize(archive.length)}`);
}
