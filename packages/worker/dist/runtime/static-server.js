function jsString(value) {
    return JSON.stringify(value);
}
export function parsePort(value, fallback) {
    if (!value)
        return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0 || n >= 65536)
        return fallback;
    return n;
}
export function createLiveStaticServerCode(root) {
    const normalizedRoot = root.replace(/^\/+/, '').replace(/\/+$/, '') || 'home/user';
    return `
import { WorkerEntrypoint } from "cloudflare:workers";

const ROOT = ${jsString(normalizedRoot)};
const TEXT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function cleanPath(pathname) {
  const parts = [];
  for (const raw of pathname.split("/")) {
    if (!raw || raw === ".") continue;
    if (raw === "..") { parts.pop(); continue; }
    parts.push(raw);
  }
  return parts.join("/");
}

function joinRoot(rel) {
  return rel ? ROOT + "/" + rel : ROOT;
}

function contentType(path) {
  const idx = path.lastIndexOf(".");
  const ext = idx >= 0 ? path.slice(idx).toLowerCase() : "";
  return TEXT_TYPES[ext] || "application/octet-stream";
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

async function resolveFile(supervisor, rel) {
  const base = joinRoot(rel);
  const stat = await supervisor.stat(base);
  const isDirectory = stat && (stat.type === "directory" || stat.isDir || stat.isDirectory);
  if (stat && !isDirectory) return { path: base, stat };
  if (isDirectory) {
    for (const index of ["index.html", "index.htm"]) {
      const candidate = base.replace(/\\/+$/, "") + "/" + index;
      const s = await supervisor.stat(candidate);
      if (s && !(s.type === "directory" || s.isDir || s.isDirectory)) return { path: candidate, stat: s };
    }
    return { directory: base };
  }
  return null;
}

async function renderDirectory(supervisor, path, rel, url) {
  const entries = await supervisor.readdir(path);
  const rows = entries
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1))
    .map((entry) => {
      const suffix = entry.type === "directory" ? "/" : "";
      const href = new URL(url);
      href.pathname = href.pathname.replace(/\\/?$/, "/") + encodeURIComponent(entry.name) + suffix;
      return '<li><a href="' + href.pathname + href.search + '">' + htmlEscape(entry.name + suffix) + '</a></li>';
    })
    .join("");
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Index of /' + htmlEscape(rel) + '</title>' +
    '<h1>Index of /' + htmlEscape(rel) + '</h1><ul>' + rows + '</ul>',
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export default class NimbusStaticServer extends WorkerEntrypoint {
  async fetch(request) {
    return this.handleHttpRequest(request);
  }

  async handleHttpRequest(request) {
    const supervisor = this.env && this.env.SUPERVISOR;
    if (!supervisor) {
      return new Response("Nimbus static server: SUPERVISOR binding missing", { status: 500 });
    }
    const url = new URL(request.url);
    const rel = cleanPath(decodeURIComponent(url.pathname));
    const resolved = await resolveFile(supervisor, rel);
    if (!resolved) return new Response("Not found", { status: 404 });
    if (resolved.directory) return renderDirectory(supervisor, resolved.directory, rel, url);
    const bytes = await supervisor.readFileBytes(resolved.path);
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(bytes, {
      headers: {
        "Content-Type": contentType(resolved.path),
        "Cache-Control": "no-store",
      },
    });
  }
}
`;
}
