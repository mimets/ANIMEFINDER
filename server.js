// server.js
import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ENV
const PORT = Number(process.env.PORT || 5173);
const YT_API_KEY = process.env.YT_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_LANGUAGE = process.env.TMDB_LANGUAGE || "it-IT";
const TMDB_REGION = process.env.TMDB_REGION || "IT";
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;
const PERPLEXITY_MODEL = process.env.PERPLEXITY_MODEL || "sonar";

app.use(express.static(path.join(__dirname, "public")));

// ---------- utils ----------
function mustHave(v, name) {
  if (!v) {
    const e = new Error(`Missing ${name} in .env`);
    e.status = 500;
    throw e;
  }
}
function cleanText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function clamp(n, a, b) {
  const x = Number(n);
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.status_message || data?.error?.message || data?.error || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.details = data;
    throw err;
  }
  return data;
}

// ---------- TMDB (solo per match / autocomplete) ----------
async function tmdbMultiSearch(query, page = 1) {
  mustHave(TMDB_API_KEY, "TMDB_API_KEY");
  const url = new URL("https://api.themoviedb.org/3/search/multi");
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("query", query);
  url.searchParams.set("language", TMDB_LANGUAGE);
  url.searchParams.set("region", TMDB_REGION);
  url.searchParams.set("include_adult", "false");
  url.searchParams.set("page", String(page));
  return fetchJson(url.toString());
}
function normalizeTmdbResult(x) {
  const type =
    x?.media_type === "tv" ? "tv" :
    x?.media_type === "movie" ? "movie" :
    null;
  if (!type) return null;
  const name = type === "tv" ? x?.name : x?.title;
  return {
    type,
    id: x?.id,
    name: name || "",
    overview: x?.overview || "",
    vote_average: x?.vote_average ?? null,
    poster_path: x?.poster_path || null
  };
}
async function tmdbBestMatch(query) {
  const data = await tmdbMultiSearch(query, 1);
  const results = Array.isArray(data?.results) ? data.results : [];
  const first = results.find(r => r?.media_type === "tv" || r?.media_type === "movie");
  return first ? normalizeTmdbResult(first) : null;
}

// ---------- Perplexity: web reviews ----------
async function perplexityWebReviewSummary({ title, targetLang }) {
  mustHave(PERPLEXITY_API_KEY, "PERPLEXITY_API_KEY");

  const system = `Usa la ricerca web per trovare recensioni/opinioni sul titolo richiesto.
Rispondi SOLO con JSON valido.

Schema:
{
  "summary": "2-4 frasi",
  "pros": ["3-6 punti"],
  "cons": ["3-6 punti"],
  "avg": number,
  "sources": ["https://...", "..."]
}

Regole:
- "sources": 3-10 URL reali (review/discussioni).
- Se trovi poche fonti, sii cauto e includi comunque le URL trovate.
Lingua: ${targetLang}.`;

  const user = `Titolo: ${title}
Cerca sul web recensioni/feedback e sintetizza pro/contro + voto 0-10, includendo URL in sources.`;

  const basePayload = {
    model: PERPLEXITY_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.2,
    web_search_options: {
      search_context_size: "high",
      search_recency_filter: "year",
      user_location: { country: "IT", region: "Trentino-Alto Adige", city: "Trento" }
    }
  };

  const schemaPayload = {
    ...basePayload,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "web_review_summary",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            pros: { type: "array", items: { type: "string" } },
            cons: { type: "array", items: { type: "string" } },
            avg: { type: "number" },
            sources: { type: "array", items: { type: "string" } }
          },
          required: ["summary", "pros", "cons", "avg", "sources"]
        }
      }
    }
  };

  async function doReq(payload) {
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  let resp = await doReq(schemaPayload);
  if (!resp.ok && resp.status === 400) resp = await doReq(basePayload);

  if (!resp.ok) {
    const e = new Error("Perplexity API error");
    e.status = resp.status;
    e.details = resp.data;
    throw e;
  }

  const content = resp.data?.choices?.[0]?.message?.content ?? "";
  let obj = safeJsonParse(content);
  if (!obj) {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) obj = safeJsonParse(m[0]);
  }
  if (!obj || typeof obj !== "object") {
    const e = new Error("AI returned non-JSON");
    e.status = 502;
    e.details = { raw: content };
    throw e;
  }

  let sources = Array.isArray(obj.sources)
    ? obj.sources.map(cleanText).filter(s => /^https?:\/\//i.test(s)).slice(0, 10)
    : [];

  // fallback: citations array può essere presente nella response [web:12]
  if (sources.length === 0 && Array.isArray(resp.data?.citations)) {
    sources = resp.data.citations.filter(s => typeof s === "string").slice(0, 10);
  }

  return {
    summary: cleanText(obj.summary || ""),
    pros: Array.isArray(obj.pros) ? obj.pros.map(cleanText).filter(Boolean).slice(0, 8) : [],
    cons: Array.isArray(obj.cons) ? obj.cons.map(cleanText).filter(Boolean).slice(0, 8) : [],
    avg: clamp(obj.avg ?? 0, 0, 10),
    sources
  };
}

// ---------- API ----------
app.get("/api/yt/search", async (req, res, next) => {
  try {
    mustHave(YT_API_KEY, "YT_API_KEY");
    const q = cleanText(req.query.q);
    if (!q) return res.status(400).json({ error: "Missing q" });

    // YouTube Data API search.list [web:18]
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", "1");
    url.searchParams.set("q", q);
    url.searchParams.set("key", YT_API_KEY);

    const data = await fetchJson(url.toString());
    const item = data?.items?.[0];
    if (!item?.id?.videoId) return res.json({ videoId: null, snippet: null });

    res.json({ videoId: item.id.videoId, snippet: item.snippet || null });
  } catch (e) {
    next(e);
  }
});

app.get("/api/tmdb/search", async (req, res, next) => {
  try {
    const q = cleanText(req.query.q);
    if (!q) return res.status(400).json({ error: "Missing q" });
    const match = await tmdbBestMatch(q);
    res.json(match || { match: null });
  } catch (e) {
    next(e);
  }
});

app.get("/api/tmdb/autocomplete", async (req, res, next) => {
  try {
    const q = cleanText(req.query.q);
    if (!q) return res.status(400).json({ error: "Missing q" });

    const data = await tmdbMultiSearch(q, 1);
    const results = Array.isArray(data?.results) ? data.results : [];
    const items = results
      .filter(r => r?.media_type === "tv" || r?.media_type === "movie")
      .slice(0, 6)
      .map(normalizeTmdbResult)
      .filter(Boolean);

    res.json({ items });
  } catch (e) {
    next(e);
  }
});

app.post("/api/reviews/ai", async (req, res) => {
  try {
    const title = cleanText(req.body?.title);
    const targetLang = cleanText(req.body?.targetLang || "it");
    if (!title) return res.status(400).json({ error: "Missing title" });

    const out = await perplexityWebReviewSummary({ title, targetLang });

    if (!out.sources.length) {
      return res.json({
        ...out,
        summary: out.summary || "Non sono riuscito a ottenere fonti web citabili. Riprova tra poco o cambia query.",
        avg: out.avg ?? 0
      });
    }

    res.json(out);
  } catch (e) {
    res.status(e?.status || 500).json({ error: e.message || "AI error", details: e.details });
  }
});

// Error handler
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

app.listen(PORT, () => {
  console.log(`Anime Hub running on http://localhost:${PORT}`);
});
