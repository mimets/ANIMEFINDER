const el = (id) => document.getElementById(id);

const state = {
  current: null,
  selectedSeason: 1
};
const LAST_QUERY_KEY = "last_query";

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}
function setStatus(msg){ el("status").textContent = msg || ""; }

function tmdbImg(p){ return p ? `https://image.tmdb.org/t/p/w500${p}` : null; }
function tmdbStill(p){ return p ? `https://image.tmdb.org/t/p/w500${p}` : null; }

async function apiGet(url){
  const r = await fetch(url);
  const data = await r.json().catch(()=> ({}));
  if(!r.ok){
    const msg =
      data?.error ||
      data?.status_message ||
      (typeof data === "string" ? data : null) ||
      ("HTTP " + r.status);

    const err = new Error(msg);
    err.status = r.status;
    err.details = data?.details || data;
    throw err;
  }
  return data;
}
function fmtNum(n){
  const x = Number(n);
  if (!Number.isFinite(x)) return "—";
  return x.toLocaleString("it-IT");
}

/* FX toggle */
const fxToggle = el("fx");
function setFx(on){
  document.documentElement.dataset.fx = on ? "on" : "off";
  localStorage.setItem("fx", on ? "1" : "0");
}
if (fxToggle){
  const saved = localStorage.getItem("fx");
  const on = saved == null ? true : saved === "1";
  fxToggle.checked = on;
  setFx(on);
  fxToggle.addEventListener("change", () => setFx(fxToggle.checked));
}

/* 3D tilt */
const posterEl = el("poster");
if (posterEl){
  posterEl.addEventListener("mousemove", (e) => {
    if(document.documentElement.dataset.fx === "off") return;
    const r = posterEl.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width;
    const py = (e.clientY - r.top) / r.height;
    const rx = (py - 0.5) * -10;
    const ry = (px - 0.5) * 10;
    posterEl.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
  });
  posterEl.addEventListener("mouseleave", () => { posterEl.style.transform = ""; });
}

/* suggestions */
const suggestBox = el("suggest");
let suggestTimer = null;

function showSuggestions(items){
  if(!items?.length){
    suggestBox.style.display = "none";
    suggestBox.innerHTML = "";
    return;
  }
  suggestBox.style.display = "block";
  suggestBox.innerHTML = items.map((it, idx) => {
    const img = tmdbImg(it.poster_path);
    return `
      <div class="item" data-idx="${idx}">
        <div class="mini">
          ${img ? `<img class="miniPoster" src="${img}" alt="">` : `<div class="miniPoster"></div>`}
          <div style="min-width:0">
            <div style="font-weight:950; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(it.name)}</div>
            <div style="font-size:12px; color:rgba(255,255,255,.62); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc((it.overview || "Nessuna descrizione.").slice(0, 90))}</div>
          </div>
        </div>
        <div class="tag">${it.type === "tv" ? "TV" : it.type === "movie" ? "Film" : esc(it.type)}</div>
      </div>
    `;
  }).join("");

  [...suggestBox.querySelectorAll(".item")].forEach(node => {
    node.addEventListener("click", async () => {
      const picked = items[Number(node.dataset.idx)];
      suggestBox.style.display = "none";
      el("q").value = picked.name;
      await runFullSearch(picked.name);
    });
  });
}

el("q").addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = el("q").value.trim();
  if(q.length < 2){ showSuggestions([]); return; }
  suggestTimer = setTimeout(async () => {
    try{
      const j = await apiGet(`/api/tmdb/autocomplete?q=${encodeURIComponent(q)}`);
      showSuggestions(j.items || []);
    }catch{
      showSuggestions([]);
    }
  }, 160);
});
document.addEventListener("click", (e) => {
  if(!suggestBox.contains(e.target) && e.target !== el("q")) showSuggestions([]);
});

/* Crunchyroll */
function crKeyForTitle(title){ return "cr_link:" + title.toLowerCase().trim(); }
const LAST_KEY = "last_watch";
function openCrunchyroll(title){
  const saved = localStorage.getItem(crKeyForTitle(title));
  const url = saved && saved.startsWith("http")
    ? saved
    : `https://www.crunchyroll.com/search?from=&q=${encodeURIComponent(title)}`;
  window.open(url, "_blank", "noopener,noreferrer");
  localStorage.setItem(LAST_KEY, JSON.stringify({ title, url, ts: Date.now() }));
}
el("btnCR").addEventListener("click", () => {
  const title = state.current?.name || el("q").value.trim();
  if(!title) return setStatus("Cerca prima un titolo.");
  openCrunchyroll(title);
  setStatus("Aperto Crunchyroll.");
});
el("btnSetCR").addEventListener("click", () => {
  const title = state.current?.name || el("q").value.trim();
  if(!title) return setStatus("Cerca prima un titolo.");
  const cur = localStorage.getItem(crKeyForTitle(title)) || "";
  const url = prompt(`Incolla l'URL Crunchyroll serie (/series/...) per:\n${title}`, cur);
  if(!url) return;
  localStorage.setItem(crKeyForTitle(title), url.trim());
  setStatus("Link Crunchyroll salvato.");
});
el("btnContinue").addEventListener("click", () => {
  const last = localStorage.getItem(LAST_KEY);
  if(!last) return setStatus("Nessun 'continua a guardare' salvato.");
  try{
    const obj = JSON.parse(last);
    if(obj?.url) window.open(obj.url, "_blank", "noopener,noreferrer");
    else if(obj?.title) runFullSearch(obj.title);
    else setStatus("Dato salvato non valido.");
  }catch{
    setStatus("Dato salvato non valido.");
  }
});

function resetStats(){
  el("tmdbScore").textContent = "—";
  el("ringSource").textContent = "/10";
  el("statsRating").innerHTML = "";
  el("statsMeta").innerHTML = "";
  el("year").textContent = "—";
  document.querySelector(".ring")?.style.setProperty("--score-pct", "0%");
  document.querySelector(".ring")?.style.removeProperty("--ring-color");
}
function renderStats(details){
  const imdbRating = Number(details?.imdb_rating);
  const tmdbScore = Number(details?.vote_average);
  const hasImdb = Number.isFinite(imdbRating) && imdbRating > 0;
  const score = hasImdb ? imdbRating : tmdbScore;

  el("tmdbScore").textContent = Number.isFinite(score) && score > 0 ? score.toFixed(1) : "—";
  el("year").textContent = esc(details?.year || "—");

  const ringEl = document.querySelector(".ratingRing");
  if (ringEl) ringEl.title = hasImdb ? "Voto IMDb" : "Voto TMDB";
  el("ringSource").textContent = hasImdb ? "IMDb" : "/10";

  const pct = Number.isFinite(score) && score > 0 ? (score / 10 * 100).toFixed(1) + "%" : "0%";
  const ringColor = score >= 7.5 ? "#39c98a" : score >= 6.0 ? "#f5c518" : score > 0 ? "#d35656" : "var(--accent)";
  document.querySelector(".ring")?.style.setProperty("--score-pct", pct);
  document.querySelector(".ring")?.style.setProperty("--ring-color", ringColor);

  const ratingItems = hasImdb ? [
    `Rating IMDb: ${imdbRating.toFixed(1)} / 10`,
    `Voti IMDb: ${esc(details.imdb_votes || "—")}`,
    `Popolarità TMDB: ${fmtNum(details?.popularity)}`
  ] : [
    `Voto TMDB: ${Number.isFinite(tmdbScore) && tmdbScore > 0 ? tmdbScore.toFixed(1) + " / 10" : "—"}`,
    `Numero voti: ${fmtNum(details?.vote_count)}`,
    `Popolarità: ${fmtNum(details?.popularity)}`
  ];

  const metaItems = [
    `Generi: ${details?.genres?.length ? details.genres.join(", ") : "—"}`,
    details?.type === "tv"
      ? `Stagioni: ${fmtNum(details?.number_of_seasons)} · Episodi: ${fmtNum(details?.number_of_episodes)}`
      : `Durata: ${details?.runtime ? `${fmtNum(details.runtime)} min` : "—"}`
  ];

  el("statsRating").innerHTML = ratingItems.map(x => `<li>${esc(x)}</li>`).join("");
  el("statsMeta").innerHTML = metaItems.map(x => `<li>${esc(x)}</li>`).join("");
}
function renderSeasonTabs(totalSeasons){
  const box = el("seasonTabs");
  if(!box) return;
  if(!Number.isFinite(totalSeasons) || totalSeasons < 1){
    box.innerHTML = "";
    return;
  }
  const max = Math.min(totalSeasons, 20);
  const html = Array.from({ length: max }, (_, i) => i + 1).map(s => {
    const cls = s === state.selectedSeason ? "seasonBtn active" : "seasonBtn";
    return `<button class="${cls}" data-season="${s}">S${s}</button>`;
  }).join("");
  box.innerHTML = html;
  [...box.querySelectorAll(".seasonBtn")].forEach(node => {
    node.addEventListener("click", () => {
      const season = Number(node.dataset.season || 1);
      if (!state.current?.id || !state.current?.type || state.current.type !== "tv") return;
      if (season === state.selectedSeason) return;
      state.selectedSeason = season;
      renderSeasonTabs(totalSeasons);
      loadSeasonEpisodes(state.current.id, season);
    });
  });
}

async function loadSeasonEpisodes(tvId, season){
  try{
    setStatus(`Carico episodi S${season}...`);
    const epRes = await apiGet(`/api/tmdb/episodes?id=${encodeURIComponent(tvId)}&season=${encodeURIComponent(season)}`);

    let imdbRatings = {};
    const imdbId = state.current?.imdb_id;
    if (imdbId) {
      try {
        const omdb = await apiGet(`/api/omdb/season-ratings?imdbId=${encodeURIComponent(imdbId)}&season=${encodeURIComponent(season)}`);
        imdbRatings = omdb?.ratings || {};
      } catch {
        imdbRatings = {};
      }
    }

    renderEpisodes(epRes.episodes || [], "Nessun episodio trovato.", imdbRatings);
    setStatus("Pronto.");
  }catch(e){
    const d = e.details || {};
    const tmdbMsg = d?.status_message || d?.details?.status_message;
    renderEpisodes([], `Episodi: ${tmdbMsg || (e.message + " (HTTP " + (e.status || "?") + ")")}`);
  }
}

/* Episodi */
function renderEpisodes(list, msg, imdbRatings = {}){
  const box = el("episodesGrid");
  if(!box) return;
  if(!list?.length){
    box.innerHTML = msg ? `<div class="status" style="margin-top:6px">${esc(msg)}</div>` : "";
    return;
  }
  box.innerHTML = list.map(ep => {
    const img = tmdbStill(ep.still_path);
    const imdbScore = imdbRatings[String(ep.episode_number)] || null;
    const tmdbScore = ep.vote_average != null && Number(ep.vote_average) > 0 ? Number(ep.vote_average).toFixed(1) : null;
    const score = imdbScore || tmdbScore || "—";
    const scoreClass = imdbScore ? "epScore imdb" : "epScore";
    const scoreSource = imdbScore ? "IMDb" : (tmdbScore ? "TMDB" : "");
    const name = ep.name || `Ep ${ep.episode_number}`;
    const raw = ep.overview || "Nessun riassunto disponibile.";
    const ov = raw.length > 220 ? raw.slice(0,220) + "…" : raw;
    return `
      <article class="epCard">
        ${img ? `<img class="epImg" src="${esc(img)}" alt="">` : `<div class="epImg"></div>`}
        <div class="epBody">
          <div class="epMeta">
            <div class="epNum">S${ep.season_number} · E${ep.episode_number}</div>
            <div class="${scoreClass}">${esc(score)}${score !== "—" ? " / 10" : ""} <span class="epScoreSource">${esc(scoreSource)}</span></div>
          </div>
          <div class="epName">${esc(name)}</div>
          <div class="epOverview">${esc(ov)}</div>
        </div>
      </article>
    `;
  }).join("");
}

/* main search */
async function runFullSearch(query){
  query = (query || "").trim();
  if(!query) return setStatus("Scrivi un titolo.");
  localStorage.setItem(LAST_QUERY_KEY, query);

  setStatus("Carico dettagli...");
  el("btnCR").disabled = true;
  el("btnSetCR").disabled = true;
  el("btnTMDB").disabled = true;

  el("title").textContent = "—";
  el("overview").textContent = "—";
  el("type").textContent = "—";
  el("year").textContent = "—";
  posterEl.innerHTML = `<div class="posterPh">Caricamento...</div>`;

  el("videoBox").style.display = "none";
  el("ytFrame").src = "";

  resetStats();
  renderEpisodes([], "");
  renderSeasonTabs(0);

  try{
    const tmdb = await apiGet(`/api/tmdb/search?q=${encodeURIComponent(query)}`);
    if(!tmdb || !tmdb.id){
      setStatus("Nessun risultato TMDB.");
      posterEl.innerHTML = `<div class="posterPh">Nessun risultato.</div>`;
      resetStats();
      renderEpisodes([], "");
      return;
    }

    state.current = tmdb;
    const title = tmdb.name || query;

    el("title").textContent = title;
    el("overview").textContent = tmdb.overview || "Nessuna overview disponibile.";
    el("type").textContent = tmdb.type === "tv" ? "TV" : tmdb.type === "movie" ? "Film" : (tmdb.type || "—");
    el("btnTMDB").disabled = false;

    const img = tmdbImg(tmdb.poster_path);
    posterEl.innerHTML = img ? `<img src="${img}" alt="Poster">` : `<div class="posterPh">Poster non disponibile.</div>`;

    el("btnCR").disabled = false;
    el("btnSetCR").disabled = false;

    try {
      const details = await apiGet(`/api/tmdb/details?id=${encodeURIComponent(tmdb.id)}&type=${encodeURIComponent(tmdb.type)}`);
      state.current = { ...state.current, imdb_id: details?.imdb_id || "" };
      renderStats(details);
      if (tmdb.type === "tv") {
        state.selectedSeason = 1;
        renderSeasonTabs(Number(details?.number_of_seasons) || 1);
      } else {
        renderSeasonTabs(0);
      }
    } catch {
      resetStats();
      renderSeasonTabs(0);
    }

    if (tmdb.type === "tv"){
      await loadSeasonEpisodes(tmdb.id, state.selectedSeason);
    } else {
      renderSeasonTabs(0);
      renderEpisodes([], "Episodi disponibili solo per serie TV.");
    }

    setStatus("Carico trailer...");
    const yt = await apiGet(`/api/yt/search?q=${encodeURIComponent(title + " trailer")}`);
    if(yt?.videoId){
      el("videoBox").style.display = "block";
      el("ytFrame").src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt.videoId)}`;
    }

    setStatus("Pronto.");
  }catch(e){
    setStatus("Errore: " + (e.message || e));
    el("btnTMDB").disabled = true;
    posterEl.innerHTML = `<div class="posterPh">Errore.</div>`;
    resetStats();
    renderEpisodes([], "");
  }
}

el("btnSearch").addEventListener("click", () => runFullSearch(el("q").value.trim()));
el("btnTMDB").addEventListener("click", () => {
  if (!state.current?.id || !state.current?.type) return;
  const url = `https://www.themoviedb.org/${state.current.type}/${state.current.id}`;
  window.open(url, "_blank", "noopener,noreferrer");
});
el("q").addEventListener("keydown", (e) => {
  if(e.key === "Enter"){
    e.preventDefault();
    showSuggestions([]);
    runFullSearch(el("q").value.trim());
  }
});

/* TMDB ping: se fallisce sai subito che è chiave/permessi [web:230][web:233] */
(async () => {
  try{
    const ping = await apiGet("/api/tmdb/ping");
    if (!ping?.ok) throw new Error("TMDB ping failed");
  }catch(e){
    const msg = e?.details?.status_message || e?.message || "TMDB non raggiungibile";
    setStatus("TMDB: " + msg);
  }
})();

const lastQuery = localStorage.getItem(LAST_QUERY_KEY);
if (lastQuery) {
  el("q").value = lastQuery;
  runFullSearch(lastQuery);
}

resetStats();
renderEpisodes([], "");
