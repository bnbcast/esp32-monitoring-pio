// tools/build-docs.mjs - render markdown docs under doc/ into a static site in web/doc/.
// No dependencies. Run: node tools/build-docs.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, relative, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcRoot = join(root, "doc");
const outRoot = join(root, "web", "doc");

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return "\u0000" + (codes.length - 1) + "\u0000";
  });
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
    let href = esc(u);
    if (!/^(https?:|#|mailto:)/.test(u) && u.endsWith(".md")) href = esc(u.slice(0, -3) + ".html");
    return '<a href="' + href + '">' + t + "</a>";
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => "<code>" + esc(codes[+i]) + "</code>");
  return s;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function render(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0, inCode = false, list = null, para = [];
  const flushPara = () => {
    if (para.length) {
      out.push("<p>" + inline(para.join(" ")) + "</p>");
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push("</" + list + ">");
      list = null;
    }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      flushPara(); closeList();
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        out.push("<pre><code>");
        inCode = true;
      }
      i++;
      continue;
    }
    if (inCode) {
      out.push(esc(line));
      i++;
      continue;
    }
    if (!line.trim()) {
      flushPara(); closeList(); i++; continue;
    }
    if (line.trim().startsWith("|")) {
      flushPara(); closeList();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(lines[i].trim());
        i++;
      }
      const cells = (r) => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      let body = rows.filter((r) => !/^\|[\s:|-]+\|$/.test(r));
      if (body.length) {
        out.push("<div class=\"table-wrap\"><table>");
        out.push("<thead><tr>" + cells(body[0]).map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead>");
        out.push("<tbody>");
        for (const r of body.slice(1)) out.push("<tr>" + cells(r).map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>");
        out.push("</tbody></table></div>");
      }
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); closeList();
      const lvl = m[1].length;
      const id = slug(m[2].replace(/`/g, ""));
      out.push('<h' + lvl + ' id="' + id + '">' + inline(m[2]) + "</h" + lvl + ">");
      i++; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushPara();
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push("<li>" + inline(line.replace(/^\s*[-*]\s+/, "")) + "</li>");
      i++; continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara();
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push("<li>" + inline(line.replace(/^\s*\d+\.\s+/, "")) + "</li>");
      i++; continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara(); closeList();
      out.push("<blockquote>" + inline(line.replace(/^>\s?/, "")) + "</blockquote>");
      i++; continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushPara(); closeList(); out.push("<hr>"); i++; continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara(); closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

const PAGE = (title, body, nav, active, depth = 0) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - Orion Docs</title>
<link rel="icon" type="image/png" sizes="32x32" href="${"../".repeat(depth + 1)}icons/orion-32.png">
<style>
:root{--bg:#0d0f12;--panel:#151a20;--line:#252d37;--ink:#e8edf3;--muted:#9aa7b5;--accent:#ffe600;--code:#0a0c0f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,Segoe UI,Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.layout{display:flex;min-height:100vh}
aside{width:270px;flex:none;background:var(--panel);border-right:1px solid var(--line);padding:22px 18px;position:sticky;top:0;height:100vh;overflow:auto}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;font-weight:700;letter-spacing:.5px}
.brand img{width:30px;height:30px}
.nav-group{margin:16px 0 6px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:1.4px}
nav a{display:block;padding:6px 9px;border-radius:6px;color:var(--ink);font-size:14px}
nav a:hover{background:#1e252d;text-decoration:none}
nav a.on{background:#2a333d;color:var(--accent)}
main{flex:1;min-width:0;padding:38px 48px 80px;max-width:1000px}
h1{font-size:30px;margin:0 0 18px;border-bottom:1px solid var(--line);padding-bottom:12px}
h2{font-size:22px;margin:34px 0 12px}
h3{font-size:17px;margin:26px 0 8px}
h4{font-size:15px;margin:20px 0 6px;color:var(--muted)}
p{margin:10px 0}
code{background:var(--code);padding:2px 6px;border-radius:4px;font:13px/1.5 ui-monospace,Consolas,monospace}
pre{background:var(--code);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow:auto}
pre code{padding:0;background:none}
.table-wrap{overflow:auto;margin:14px 0}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{border:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
th{background:#1b222a}
tbody tr:nth-child(even){background:#11161b}
blockquote{margin:12px 0;padding:10px 14px;border-left:3px solid var(--accent);background:#1a1d13;color:#e6e2b8}
hr{border:0;border-top:1px solid var(--line);margin:26px 0}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:18px 0}
.card{display:block;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.card:hover{border-color:var(--accent);text-decoration:none}
.card strong{display:block;margin-bottom:4px}
.card span{color:var(--muted);font-size:12px}
@media(max-width:820px){.layout{display:block}aside{width:auto;height:auto;position:static}main{padding:24px 18px 60px}}
</style>
</head>
<body>
<div class="layout">
<aside>
<div class="brand"><img src="${"../".repeat(depth + 1)}icons/orion-32.png" alt=""> ORION DOCS</div>
<nav>${nav}</nav>
</aside>
<main id="content">${body}</main>
</div>
</body>
</html>
`;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

const files = walk(srcRoot);
const pages = files.map((f) => ({ path: f, rel: relative(srcRoot, f).split("\\").join("/") }));
pages.sort((a, b) => a.rel.localeCompare(b.rel));

const groups = { "": [], api: [], project: [], hardware: [] };
for (const p of pages) {
  const parts = p.rel.split("/");
  const key = parts.length > 1 ? parts[0] : "";
  if (groups[key]) groups[key].push(p);
}

const titles = {};
for (const p of pages) {
  const first = readFileSync(p.path, "utf8").split("\n").find((l) => l.startsWith("# "));
  titles[p.rel] = first ? first.replace(/^#\s+/, "").trim() : p.rel;
}

function navHtml(active, depth = 0) {
  const up = "../".repeat(depth);
  const label = { "": "Overview", api: "API", project: "Project", hardware: "Hardware" };
  let h = '<a class="' + (active === "" ? "on" : "") + '" href="' + up + 'index.html">Docs home</a>';
  h += '<div class="nav-group">Tools</div><a href="' + up + '../api/docs/">API Tester</a>';
  for (const key of Object.keys(groups)) {
    if (!groups[key].length) continue;
    h += '<div class="nav-group">' + label[key] + "</div>";
    for (const p of groups[key]) {
      const href = up + p.rel.replace(/\.md$/, ".html");
      h += '<a class="' + (active === p.rel ? "on" : "") + '" href="' + href + '">' + esc(titles[p.rel]) + "</a>";
    }
  }
  return h;
}

try { rmSync(outRoot, { recursive: true, force: true }); } catch (e) {}
mkdirSync(outRoot, { recursive: true });
for (const p of pages) {
  const dest = join(outRoot, p.rel.replace(/\.md$/, ".html"));
  mkdirSync(dirname(dest), { recursive: true });
  const body = render(readFileSync(p.path, "utf8"));
  const depth = p.rel.split("/").length - 1;
  writeFileSync(dest, PAGE(titles[p.rel], body, navHtml(p.rel, depth), p.rel, depth), "utf8");
  console.log("wrote", relative(root, dest));
}

const cards = groups[""].map((p) =>
  '<a class="card" href="' + p.rel.replace(/\.md$/, ".html") + '"><strong>' + esc(titles[p.rel]) + "</strong><span>" + esc(p.rel) + "</span></a>"
).join("");
for (const key of ["api", "project", "hardware"]) {
  if (!groups[key].length) continue;
  const items = groups[key].map((p) =>
    '<li><a href="' + p.rel.replace(/\.md$/, ".html") + '">' + esc(titles[p.rel]) + "</a></li>"
  ).join("");
  groups[key].html = '<h2>' + key[0].toUpperCase() + key.slice(1) + "</h2><ul>" + items + "</ul>";
}
const home = '<h1>Orion Project Documentation</h1><p>Complete reference for the ESP32 tracker, the history API and the dashboard.</p><div class="cards">' +
  cards + "</div>" + ["api", "project", "hardware"].map((k) => groups[k].html || "").join("");
writeFileSync(join(outRoot, "index.html"), PAGE("Documentation", home, navHtml(""), ""), "utf8");
console.log("wrote web/doc/index.html");

