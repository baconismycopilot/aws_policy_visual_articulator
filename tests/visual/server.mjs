/**
 * A static file server for the Playwright suite.
 *
 * `python3 -m http.server` cannot take the load: its listen backlog is 5, and
 * eight parallel workers opening six connections each blows past that, so page
 * loads stall and tests fail on a 30s timeout rather than on anything real.
 * Node's http server takes a backlog argument and holds up fine.
 *
 * Dev-only, and deliberately dependency-free.
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../site/", import.meta.url));
const PORT = Number(process.env.PORT || 8081);

const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
    // Strip the query string, then normalize away any "../" traversal.
    // A stray "%" makes decodeURIComponent throw, and an unhandled rejection
    // in here would take the whole server down mid-run — which surfaces as an
    // unrelated test timing out rather than as anything readable.
    let path;
    try {
        path = decodeURIComponent(req.url.split("?")[0]);
    } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad request");
        return;
    }
    const relative = normalize(path).replace(/^(\.\.[/\\])+/, "");
    let file = join(ROOT, relative);

    try {
        const info = await stat(file);
        if (info.isDirectory()) file = join(file, "index.html");
        await stat(file);
    } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
    }

    res.writeHead(200, {
        "content-type": TYPES[extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
});

// The third argument is the listen backlog — the whole point of this file.
server.listen(PORT, "127.0.0.1", 511, () => {
    console.log(`serving site/ on http://127.0.0.1:${PORT}`);
});
