import { resolve } from "node:path";

// Test host routing mirrors the standalone and hosted entries, without SPA fallback.
export async function staticAssets(assets, path, headers = {}) {
  const relative = ["/", "/chat"].includes(path)
    ? "index.html"
    : path.replace(/^\//, "");
  const target = resolve(assets, relative);
  if (!target.startsWith(`${assets}/`))
    return new Response(null, { status: 404 });
  const file = Bun.file(target);
  return (await file.exists())
    ? new Response(file, { headers })
    : new Response(null, { status: 404 });
}
