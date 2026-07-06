const PORT = Number(Bun.env.PORT ?? 5173);
const ROOT = "static";

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url  = new URL(req.url);
		const path = url.pathname === "/" ? "/receiver.html" : url.pathname;
		const file = Bun.file(`${ROOT}${path}`);
		if (await file.exists()) return new Response(file);
		return new Response("Not found", { status: 404 });
	},
});

console.log(`remote sample listening on http://localhost:${PORT}`);
