// worker.mjs — Cloudflare Worker (Modules syntax)
// Bindings:
//   R2 bucket: IMAGES_BUCKET
//   Secret:    ADMIN_KEY

const ORIGIN = "https://images.chainguard.dev";
const DIR_PATH = "/directory";
const EDGE_HTML_TTL = 300;      // seconds (edge cache)
const MAX_PAGES_CAP = 5000;     // absolute cap
const BATCH_PAGES_DEFAULT = 5;  // pages per /admin/build call
const SNAPSHOT_KEY = "catalog.json";

// allow plus signs in slugs (e.g., libstdc++)
const SLUG_RE = /^[a-z0-9][a-z0-9._+\-]*$/;
// deny exact tokens we saw from badges
const BAD_SLUGS = new Set(["fips","free","validated","hardened","stig","latest","changed","last","tag"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    try {
      // ---- Public ----
      if (pathname === "/" || pathname === "") {
        return json({
          ok: true,
          endpoints: [
            "/v1/status",
            "/v1/images?page=1&size=200",
            "/v1/search?q=node&size=50",
            "POST /admin/build?steps=5",
            "POST /admin/set-lastpage?value=278",
            "POST /admin/restart-crawl",
            "POST /admin/repair",
            "POST /admin/compact",
            "POST /admin/reset"
          ]
        });
      }

      if (pathname === "/v1/status") {
        const snap = await loadSnapshot(env);
        return json({
          total: snap.items.length,
          cursor: snap.cursor,
          complete: snap.complete,
          lastPage: snap.lastPage ?? null,
          lastUpdated: snap.lastUpdated,
          cronTicks: snap.cronTicks
        });
      }

      if (pathname === "/v1/images") {
        const page = clampInt(searchParams.get("page"), 1, 1e9, 1);
        const size = clampInt(searchParams.get("size"), 1, 1000, 200);
        const snap = await loadSnapshot(env);
        const itemsSorted = sortItems([...snap.items]);
        const start = (page - 1) * size;
        const items = itemsSorted.slice(start, start + size);
        return json({ items });
      }

      if (pathname === "/v1/search") {
        const q = (searchParams.get("q") || "").toLowerCase().trim();
        if (!q) return json({ items: [] });
        const page = clampInt(searchParams.get("page"), 1, 1e9, 1);
        const size = clampInt(searchParams.get("size"), 1, 200, 50);
        const snap = await loadSnapshot(env);
        const matches = snap.items.filter(i => matchSlug(i.name.toLowerCase(), q));
        const itemsSorted = sortItems(matches);
        const start = (page - 1) * size;
        const items = itemsSorted.slice(start, start + size);
        return json({ items });
      }

      // ---- Admin (protected) ----
      if (pathname === "/admin/build") {
        if (request.method !== "POST") return json({ error: "use POST" }, 405);
        if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
        const steps = clampInt(searchParams.get("steps"), 1, 50, BATCH_PAGES_DEFAULT);
        const res = await crawlBatch(env, steps);
        return json(res);
      }

      if (pathname === "/admin/set-lastpage") {
        if (request.method !== "POST") return json({ error: "use POST" }, 405);
        if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
        const n = clampInt(searchParams.get("value"), 1, 100000, null);
        if (!n) return json({ error: "missing or invalid ?value=" }, 400);
        const snap = await loadSnapshot(env);
        snap.lastPage = n;
        if ((snap.cursor || 1) > n) snap.complete = true;
        await saveSnapshot(env, snap);
        return json({ ok: true, lastPage: snap.lastPage, cursor: snap.cursor, complete: snap.complete });
      }

      if (pathname === "/admin/restart-crawl") {
        if (request.method !== "POST") return json({ error: "use POST" }, 405);
        if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
        const snap = await loadSnapshot(env);
        snap.cursor = 1;
        snap.complete = false;
        await saveSnapshot(env, snap);
        return json({ ok: true, cursor: snap.cursor, complete: snap.complete, lastPage: snap.lastPage ?? null });
      }

      if (pathname === "/admin/repair") {
        if (request.method !== "POST") return json({ error: "use POST" }, 405);
        if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
        const snap = await loadSnapshot(env);
        const repaired = repairSnapshot(snap);
        repaired.items = sortItems(repaired.items);
        await saveSnapshot(env, repaired);
        return json({ ok: true, total: repaired.items.length });
      }

      if (pathname === "/admin/compact") {
        if (request.method !== "POST") return json({ error: "use POST" }, 405);
        if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
        const snap = await loadSnapshot(env);
        snap.items = sortItems(snap.items);
        await saveSnapshot(env, snap);
        return json({ ok: true, total: snap.items.length });
      }

      if (pathname === "/admin/reset") {
        if (request.method !== "POST") return json({ error: "use POST" }, 405);
        if (!isAdmin(request, env)) return json({ error: "forbidden" }, 403);
        const fresh = freshSnapshot();
        await saveSnapshot(env, fresh);
        return json({ ok: true, reset: true });
      }

      return json({ error: "route not found" }, 404);
    } catch (e) {
      return json({ error: (e && e.message) ? e.message : String(e) }, 500);
    }
  },

  // Optional cron — keeps things fresh
  async scheduled(event, env, ctx) {
    let snap = await loadSnapshot(env);

    // bump counter
    snap.cronTicks = (snap.cronTicks || 0) + 1;

    // if threshold reached (e.g. ~1440 for daily, or 300 for ~5h)
    if (snap.cronTicks >= 1440) {
      snap.complete = false;
      snap.cursor = 1;
      snap.cronTicks = 0;
      await saveSnapshot(env, snap);
    } else {
      // save counter progress
      await saveSnapshot(env, snap);
    }

    // small crawl batch
    await crawlBatch(env, BATCH_PAGES_DEFAULT);
  },
};

// ---------- Admin auth ----------
function isAdmin(request, env) {
  const k = request.headers.get("x-admin-key");
  return k && env.ADMIN_KEY && k === env.ADMIN_KEY;
}

// ---------- Crawl ----------
async function crawlBatch(env, steps) {
  let snap = await loadSnapshot(env);

  const hardStop = Math.min(snap.lastPage || MAX_PAGES_CAP, MAX_PAGES_CAP);

  if (snap.complete) {
    return { ok: true, crawledPages: 0, addedItems: 0, reachedEnd: true, nextCursor: snap.cursor, total: snap.items.length, lastPage: snap.lastPage ?? null };
  }

  let crawledPages = 0;
  let addedItems = 0;
  let page = Math.max(1, snap.cursor || 1);

  while (crawledPages < steps && page <= hardStop) {
    const items = await fetchDirectoryPage(page);
    crawledPages++;

    if (items.length === 0) {
      if (snap.lastPage && page >= snap.lastPage) {
        snap.complete = true;
        page++;
        break;
      }
      page++;
      continue;
    }

    for (const it of items) {
      const key = it.name;
      if (!snap.seen[key]) {
        snap.seen[key] = true;
        snap.items.push(it);
        addedItems++;
      }
    }

    page++;
  }

  if (snap.lastPage && page > snap.lastPage) snap.complete = true;

  snap.cursor = page;
  snap.items = sortItems(snap.items);
  snap.lastUpdated = epoch();
  await saveSnapshot(env, snap);

  return {
    ok: true,
    crawledPages,
    addedItems,
    reachedEnd: !!snap.complete,
    nextCursor: snap.cursor,
    total: snap.items.length,
    lastPage: snap.lastPage ?? null
  };
}

// Single-shape fetch
async function fetchDirectoryPage(n) {
  const u = `${ORIGIN}${DIR_PATH}/${n}`;
  const res = await fetchWithEdgeCache(u);
  if (!res.ok) return [];
  const html = await res.text();
  return parseCards(html);
}

// ---------- Snapshot ----------
async function loadSnapshot(env) {
  const obj = await env.IMAGES_BUCKET.get(SNAPSHOT_KEY);
  if (obj) {
    const text = await obj.text();
    const snap = JSON.parse(text);

    const items = Array.isArray(snap.items) ? snap.items : [];
    const minimal = [];
    const seen = Object.create(null);

    for (const it of items) {
      const slugFromUrl = extractSlugFromUrl(it && it.url);
      const slugFromName = (it && typeof it.name === "string") ? it.name.toLowerCase() : null;
      const candidate = slugFromUrl || slugFromName;
      if (!candidate || !SLUG_RE.test(candidate) || BAD_SLUGS.has(candidate) || seen[candidate]) continue;
      minimal.push({ name: candidate, url: `${ORIGIN}/directory/image/${encodeURIComponent(candidate)}` });
      seen[candidate] = true;
    }

    snap.items = sortItems(minimal);
    snap.seen = seen;
    snap.cursor = snap.cursor || 1;
    snap.lastPage = snap.lastPage ?? null;
    snap.complete = !!snap.complete;
    snap.lastUpdated = snap.lastUpdated || epoch();
    snap.cronTicks = snap.cronTicks || 0;
    return snap;
  }

  const fresh = freshSnapshot();
  await saveSnapshot(env, fresh);
  return fresh;
}

async function saveSnapshot(env, snap) {
  await env.IMAGES_BUCKET.put(SNAPSHOT_KEY, JSON.stringify(snap), {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });
}

function freshSnapshot() {
  return { items: [], seen: {}, cursor: 1, lastPage: null, complete: false, lastUpdated: epoch(), cronTicks: 0 };
}

// ---------- Parse ----------
function parseCards(html) {
  const out = [];
  const seen = new Set();
  const linkRe = /<a\b[^>]*\bhref="([^"]+)"[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const slug = extractSlugFromHref(m[1]);
    if (!slug || seen.has(slug)) continue;
    out.push({ name: slug, url: `${ORIGIN}/directory/image/${encodeURIComponent(slug)}` });
    seen.add(slug);
  }
  return out;
}

function extractSlugFromHref(href) {
  if (!href) return null;
  const m = /\/directory\/image\/([A-Za-z0-9][A-Za-z0-9._+\-]*)\b/.exec(href);
  if (!m) return null;
  const slug = String(decodeURIComponent(m[1])).toLowerCase();
  return SLUG_RE.test(slug) && !BAD_SLUGS.has(slug) ? slug : null;
}
function extractSlugFromUrl(url) {
  if (!url) return null;
  const m = /\/directory\/image\/([A-Za-z0-9][A-Za-z0-9._+\-]*)\b/.exec(url);
  if (!m) return null;
  const slug = String(decodeURIComponent(m[1])).toLowerCase();
  return SLUG_RE.test(slug) && !BAD_SLUGS.has(slug) ? slug : null;
}

// ---------- Wildcard search ----------
function matchSlug(slug, query) {
  if (query.startsWith("*") && query.endsWith("*")) {
    const term = query.slice(1, -1);
    return slug.includes(term);
  } else if (query.startsWith("*")) {
    const term = query.slice(1);
    return slug.endsWith(term);
  } else if (query.endsWith("*")) {
    const term = query.slice(0, -1);
    return slug.startsWith(term);
  } else {
    return slug === query;
  }
}

// ---------- Utils ----------
function sortItems(items) {
  return items.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}
async function fetchWithEdgeCache(url) {
  const cache = caches.default;
  const req = new Request(url, { headers: { "User-Agent": "images-catalog-builder/r2-slim/1.0" } });
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) {
    const toCache = new Response(res.body, res);
    toCache.headers.set("Cache-Control", `public, max-age=${EDGE_HTML_TTL}`);
    await cache.put(req, toCache.clone());
    return toCache;
  }
  return res;
}
function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v || "", 10);
  if (Number.isFinite(n)) return Math.min(Math.max(n, min), max);
  return fallback;
}
function epoch() { return Math.floor(Date.now() / 1000); }
function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders(), "content-type": "application/json; charset=utf-8" }
  });
}
function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, x-admin-key"
  };
}

