const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".json": "application/json; charset=utf-8"
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.join(root, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (url.pathname === "/") filePath = path.join(root, "index.html");
  if (!path.extname(filePath)) filePath = path.join(filePath, "index.html");
  fs.readFile(filePath, (error, body) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(body);
  });
}).listen(port, "127.0.0.1", () => {
  console.log(`Icon Listing static server running at http://127.0.0.1:${port}/home/`);
});
