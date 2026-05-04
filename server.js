import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 5173);

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TMDB_LANGUAGE = process.env.TMDB_LANGUAGE || "it-IT";
const TMDB_REGION = process.env.TMDB_REGION || "IT";
const YT_API_KEY = process.env.YT_API_KEY || "";
const OMDB_API_KEY = process.env.OMDB_API_KEY || "";

// ---- boot log (IMPORTANT) ----
console.log("[BOOT] cwd:", process.cwd());
console.log("[BOOT] __dirname:", __dirname);
console.log("[BOOT] public path:", path.join(__dirname, "public"));
console.log("[BOOT] TMDB key:", TMDB_API_KEY ? "OK" : "MISSING");
console.log("[BOOT] YT key:", YT_API_KEY ? "OK" : "MISSING");
console.log("[BOOT] OMDb key:", OMDB_API_KEY ? "OK" : "MISSING (rating IMDb episodi non disponibili)");

// serve frontend [web:291]
app.use(express.static(path.join(__dirname, "public")));

// utils
function mustHave(v, name) {
  if (!v) {
    const e = new Error(`Missing ${name} in .env`);
    e.status = 500;
    throw e;
  }
}
function cleanText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}
async function fetchJson(url) {
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.status_message || data?.error || `HTTP ${r.status}`;
    const err = new Error(msg);
    err.status = r.status;
    err.details = data;
    throw err;
  }
  return data;
}

// health + env debug
app.get("/health", (req, res) => res.json({ ok: true, node: process.version }));
app.get("/api/tmdb/ping", async (req, res) => {
  try {
    mustHave(TMDB_API_KEY, "TMDB_API_KEY");
    const url = new URL("https://api.themoviedb.org/3/configuration");
    url.searchParams.set("api_key", TMDB_API_KEY);
    await fetchJson(url.toString());
    res.json({ ok: true });
  } catch (e) {
    res.status(e?.status || 500).json({ ok: false, error: e.message, details: e.details || null });
  }
});
app.get("/debug/env", (req, res) => {
  res.json({
    TMDB_API_KEY: TMDB_API_KEY ? "OK" : "MISSING",
    YT_API_KEY: YT_API_KEY ? "OK" : "MISSING",
    OMDB_API_KEY: OMDB_API_KEY ? "OK" : "MISSING",
    TMDB_LANGUAGE,
    TMDB_REGION
  });
});

// TMDB
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
function normalizeTmdbResult(r) {
  const type = r?.media_type === "tv" ? "tv" : r?.media_type === "movie" ? "movie" : null;
  if (!type) return null;
  const name = type === "tv" ? r?.name : r?.title;
  return {
    type,
    id: r?.id,
    name: name || "",
    overview: r?.overview || "",
    poster_path: r?.poster_path || null,
    vote_average: r?.vote_average ?? null
  };
}
async function tmdbBestMatch(query) {
  const data = await tmdbMultiSearch(query, 1);
  const results = Array.isArray(data?.results) ? data.results : [];
  const first = results.find(x => x?.media_type === "tv" || x?.media_type === "movie");
  return first ? normalizeTmdbResult(first) : null;
}
function yearFromDate(s) {
  const d = cleanText(s);
  return d && d.length >= 4 ? d.slice(0, 4) : "";
}
async function tmdbDetails(id, type) {
  mustHave(TMDB_API_KEY, "TMDB_API_KEY");
  const mediaType = type === "tv" ? "tv" : "movie";
  const url = new URL(`https://api.themoviedb.org/3/${mediaType}/${encodeURIComponent(id)}`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", TMDB_LANGUAGE);
  const data = await fetchJson(url.toString());

  return {
    id: data?.id,
    type: mediaType,
    vote_average: data?.vote_average ?? null,
    vote_count: data?.vote_count ?? null,
    popularity: data?.popularity ?? null,
    genres: Array.isArray(data?.genres) ? data.genres.map(g => g?.name).filter(Boolean) : [],
    runtime: mediaType === "movie" ? (data?.runtime ?? null) : null,
    number_of_seasons: mediaType === "tv" ? (data?.number_of_seasons ?? null) : null,
    number_of_episodes: mediaType === "tv" ? (data?.number_of_episodes ?? null) : null,
    year: mediaType === "tv" ? yearFromDate(data?.first_air_date) : yearFromDate(data?.release_date),
    imdb_id: cleanText(data?.external_ids?.imdb_id || data?.imdb_id || "")
  };
}
async function tmdbImdbId(id, type) {
  mustHave(TMDB_API_KEY, "TMDB_API_KEY");
  const mediaType = type === "tv" ? "tv" : "movie";
  const url = new URL(`https://api.themoviedb.org/3/${mediaType}/${encodeURIComponent(id)}/external_ids`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  const data = await fetchJson(url.toString());
  return cleanText(data?.imdb_id || "");
}

// OMDb: rating IMDb generale del titolo
async function omdbTitleRating(imdbId) {
  if (!OMDB_API_KEY || !imdbId) return null;
  const sid = cleanText(imdbId);
  if (!/^tt\d+$/.test(sid)) return null;
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", OMDB_API_KEY);
  url.searchParams.set("i", sid);
  url.searchParams.set("plot", "none");
  const data = await fetchJson(url.toString());
  const rating = data?.imdbRating;
  const votes = data?.imdbVotes;
  if (!rating || rating === "N/A") return null;
  return { imdb_rating: Number(rating), imdb_votes: cleanText(votes || "") };
}

// OMDb: rating IMDb reali per episodio
async function omdbSeasonRatings(imdbId, season) {
  mustHave(OMDB_API_KEY, "OMDB_API_KEY");
  const sid = cleanText(imdbId);
  if (!/^tt\d+$/.test(sid)) {
    const e = new Error("Invalid imdbId");
    e.status = 400;
    throw e;
  }
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", OMDB_API_KEY);
  url.searchParams.set("i", sid);
  url.searchParams.set("Season", String(season));
  const data = await fetchJson(url.toString());

  const ratings = {};
  const episodes = Array.isArray(data?.Episodes) ? data.Episodes : [];
  for (const ep of episodes) {
    const num = Number(ep?.Episode);
    const raw = ep?.imdbRating;
    if (Number.isFinite(num) && raw && raw !== "N/A") {
      ratings[String(num)] = Number(raw).toFixed(1);
    }
  }
  return { season: Number(season), ratings };
}

// episodes endpoint: /tv/{id}/season/{season} [web:193]
async function tmdbSeasonEpisodes(tvId, seasonNumber = 1) {
  mustHave(TMDB_API_KEY, "TMDB_API_KEY");
  const url = new URL(`https://api.themoviedb.org/3/tv/${encodeURIComponent(tvId)}/season/${encodeURIComponent(seasonNumber)}`);
  url.searchParams.set("api_key", TMDB_API_KEY);
  url.searchParams.set("language", TMDB_LANGUAGE);

  const data = await fetchJson(url.toString());
  const eps = Array.isArray(data?.episodes) ? data.episodes : [];
  return eps.map(ep => ({
    id: ep.id,
    episode_number: ep.episode_number,
    season_number: ep.season_number,
    name: ep.name || `Episodio ${ep.episode_number}`,
    overview: ep.overview || "",
    still_path: ep.still_path || null,
    vote_average: ep.vote_average ?? null
  }));
}

// YouTube trailer search.list [web:18]
async function ytSearchOne(q) {
  mustHave(YT_API_KEY, "YT_API_KEY");
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("q", q);
  url.searchParams.set("key", YT_API_KEY);

  const data = await fetchJson(url.toString());
  const item = data?.items?.[0];
  return item?.id?.videoId ? { videoId: item.id.videoId, snippet: item.snippet || null } : { videoId: null, snippet: null };
}

// API routes
app.get("/api/tmdb/search", async (req, res) => {
  try {
    const q = cleanText(req.query.q);
    if (!q) return res.status(400).json({ error: "Missing q" });
    const match = await tmdbBestMatch(q);
    res.json(match || { match: null });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e.message, details: e.details || null });
  }
});

app.get("/api/tmdb/autocomplete", async (req, res) => {
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
    res.status(e?.status || 500).json({ error: e.message, details: e.details || null });
  }
});

app.get("/api/tmdb/episodes", async (req, res) => {
  try {
    const id = cleanText(req.query.id);
    const season = Number(req.query.season || 1);
    if (!id) return res.status(400).json({ error: "Missing id" });
    const episodes = await tmdbSeasonEpisodes(id, season || 1);
    res.json({ episodes });
  } catch (e) {
    res.status(e?.status || 500).json({ error: e.message, details: e.details || null });
  }
});
app.get("/api/tmdb/details", async (req, res) => {
  try {
    const id = cleanText(req.query.id);
    const type = cleanText(req.query.type);
    if (!id) return res.status(400).json({ error: "Missing id" });
    if (type !== "tv" && type !== "movie") return res.status(400).json({ error: "Invalid type" });
    const details = await tmdbDetails(id, type);
    if (!details.imdb_id) {
      details.imdb_id = await tmdbImdbId(id, type);
    }
    if (details.imdb_id) {
      const omdb = await omdbTitleRating(details.imdb_id).catch(() => null);
      if (omdb) {
        details.imdb_rating = omdb.imdb_rating;
        details.imdb_votes = omdb.imdb_votes;
      }
    }
    res.json(details);
  } catch (e) {
    res.status(e?.status || 500).json({ error: e.message, details: e.details || null });
  }
});

app.get("/api/omdb/season-ratings", async (req, res) => {
  try {
    const imdbId = cleanText(req.query.imdbId);
    const season = Number(req.query.season || 1);
    if (!imdbId) return res.status(400).json({ error: "Missing imdbId" });
    const out = await omdbSeasonRatings(imdbId, season);
    res.json(out);
  } catch (e) {
    res.status(e?.status || 500).json({ error: e.message, details: e.details || null });
  }
});

app.get("/api/yt/search", async (req, res) => {
  try {
    const q = cleanText(req.query.q);
    if (!q) return res.status(400).json({ error: "Missing q" });
    const out = await ytSearchOne(q);
    res.json(out);
  } catch (e) {
    res.status(e?.status || 500).json({ error: e.message, details: e.details || null });
  }
});

app.listen(PORT, () => console.log(`RUNNING http://localhost:${PORT}`));
