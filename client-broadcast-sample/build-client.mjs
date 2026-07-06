import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "static";

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

await Bun.build({
	entrypoints: ["./index.ts"],
	outdir: OUT_DIR,
	target: "browser",
	format: "esm",
	minify: true,
});

await copyFile("index.html", join(OUT_DIR, "index.html"));
await copyFile("style.css", join(OUT_DIR, "style.css"));

console.log(`Built static files into ${OUT_DIR}/`);
