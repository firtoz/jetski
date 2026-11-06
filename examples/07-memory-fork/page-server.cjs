const http = require("node:http");
const fs = require("node:fs");
const html = fs.readFileSync("/workspace/page.html");
const file = "/workspace/fork-marker.txt";
http
  .createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // No persistent browser HTTP sessions need to survive the checkpoint.
    res.setHeader("Connection", "close");
    if (req.method === "GET" && req.url === "/file") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(
        fs.existsSync(file) ? fs.readFileSync(file) : "(not written yet)",
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  })
  .listen(8899, "127.0.0.1");
