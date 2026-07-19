import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const OUT_DIR = "static";

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

await Bun.build({
	entrypoints: [
		"./receiver.ts",
		"./controller.ts",
	],
	outdir: OUT_DIR,
	target: "browser",
	format: "esm",
	minify: true,
});

await copyFile("receiver.html", join(OUT_DIR, "receiver.html"));
await copyFile("controller.html", join(OUT_DIR, "controller.html"));
await copyFile("style-receiver.css", join(OUT_DIR, "style-receiver.css"));
await copyFile("style-controller.css", join(OUT_DIR, "style-controller.css"));
await copyFile("qrcode.min.js", join(OUT_DIR, "qrcode.min.js"));

console.log(`Built static files into ${OUT_DIR}/`);
