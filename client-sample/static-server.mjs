const PORT = Number(Bun.env.PORT ?? 5173);

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname === "/" ? "/index.html" : url.pathname;
		const file = Bun.file(`.${path}`);
		if (await file.exists()) return new Response(file);
		return new Response("Not found", { status: 404 });
	},
});

console.log(`client sample listening on http://localhost:${PORT}`);
