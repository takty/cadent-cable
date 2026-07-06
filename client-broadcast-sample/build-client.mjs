import { mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";

await mkdir("dist", { recursive: true });

await Bun.build({
	entrypoints: ["./index.ts"],
	outdir: "dist",
	target: "browser",
	format: "esm",
	minify: false,
});

await copyFile(join("dist", "index.js"), join("dist", "app.js"));
console.log("Built dist/app.js");
