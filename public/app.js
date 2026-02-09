const JIKAN_BASE = "https://api.jikan.moe/v4"; // [web:366]

const elQ = document.getElementById("q");
const elLimit = document.getElementById("limit");
const elSfw = document.getElementById("sfw");
const elGrid = document.getElementById("grid");
const elStatus = document.getElementById("status");
const elMetaLine = document.getElementById("metaLine");
document.getElementById("srv").textContent = location.origin;

const dlg = document.getElementById("dlg");
const dlgTitle = document.getElementById("dlgTitle");
const dlgBody = document.getElementById("dlgBody");
document.getElementById("dlgClose").addEventListener("click", () => dlg.close());

const cacheDetails = new Map();

function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function setStatus(msg, bad=false){
  elStatus.textContent = msg || "";
  elStatus.classList.toggle("bad", !!bad);
}

function pickTitle(d){ return d?.title_english || d?.title || d?.titles?.[0]?.title || "Senza titolo"; }
function pickImage(d){
  return d?.images?.jpg?.large_image_url || d?.images?.jpg?.image_url ||
         d?.images?.webp?.large_image_url || d?.images?.webp?.image_url || "";
}

async function fetchJson(url, opts){
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(j?.error || ("HTTP " + r.status));
  return j;
}

async function jikanSearch(q, limit, sfw){
  const p = new URLSearchParams({ q, limit: String(limit) });
  if (sfw) p.set("sfw","true");
  return fetchJson(JIKAN_BASE + "/anime?" + p.toString());
}

async function jikanFull(malId){
  if (cacheDetails.has(malId)) return cacheDetails.get(malId);
  const j = await fetchJson(`${JIKAN_BASE}/anime/${encodeURIComponent(malId)}/full`);
  cacheDetails.set(malId, j?.data);
  return j?.data;
}

async function jikanReviews(malId, page=1){
  const url = `${JIKAN_BASE}/anime/${encodeURIComponent(malId)}/reviews?` +
    new URLSearchParams({ page: String(page) }).toString();
  return fetchJson(url);
}

async function ytEmbedForTitle(title){
  const j = await fetchJson("/api/yt/search?" + new URLSearchParams({ q: `${title} official trailer` }).toString());
  const vid = j?.videoId ?? null;
  return vid ? `https://www.youtube.com/embed/${encodeURIComponent(vid)}` : null;
}

async function aiReviews(reviews){
  return fetchJson("/api/reviews/ai", {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({ reviews, targetLang: "it" })
  });
}

function metaPills(a){
  const pills = [];
  if (a?.type) pills.push(`<span class="pill">${esc(a.type)}</span>`);
  const year = a?.year || a?.aired?.prop?.from?.year;
  if (year) pills.push(`<span class="pill">${esc(year)}</span>`);
  if (a?.score != null) pills.push(`<span class="pill good">★ ${esc(a.score)}</span>`);
  return pills.join("");
}

function makeCard(a){
  const div = document.createElement("div");
  div.className = "card";
  div.innerHTML = `
    <img class="poster" src="${esc(pickImage(a))}" alt="">
    <div class="cardBody">
      <div class="cardTitle">${esc(pickTitle(a))}</div>
      <div class="cardMeta">${metaPills(a)}</div>
      <button class="btn primary">Dettagli</button>
    </div>
  `;
  div.querySelector("button").addEventListener("click", () => openDetails(a.mal_id));
  return div;
}

async function runSearch(){
  const q = elQ.value.trim();
  if(!q){ setStatus("Scrivi una query.", true); return; }

  setStatus("Caricamento…");
  elGrid.innerHTML = "";
  elMetaLine.textContent = "";

  try{
    const limit = Number(elLimit.value);
    const sfw = (elSfw.value === "true");
    const j = await jikanSearch(q, limit, sfw);
    const list = j?.data || [];
    list.forEach(a => elGrid.appendChild(makeCard(a)));

    setStatus(list.length ? "Ok." : "Nessun risultato.");
    elMetaLine.textContent = `Risultati: ${list.length}`;
  }catch(e){
    setStatus("Errore: " + e.message, true);
  }
}

async function openDetails(malId){
  dlgTitle.textContent = "Dettagli";
  dlgBody.innerHTML = `<div class="meta">Caricamento…</div>`;
  dlg.showModal();

  try{
    const d = await jikanFull(malId);
    const title = pickTitle(d);
    const img = pickImage(d);
    const synopsis = (d?.synopsis || "").trim();

    let trailerEmbed = d?.trailer?.embed_url || null;
    let trailerNote = trailerEmbed ? "Trailer da Jikan." : "Cerco trailer (YouTube API)…";
    if(!trailerEmbed){
      trailerEmbed = await ytEmbedForTitle(title);
      trailerNote = trailerEmbed ? "Trailer trovato." : "Trailer non trovato.";
    }

    dlgTitle.textContent = title;
    dlgBody.innerHTML = `
      <div>
        <img class="sideImg" src="${esc(img)}" alt="">
        <div class="meta" style="margin-top:10px;">${esc(trailerNote)}</div>
      </div>

      <div>
        <h2 class="hTitle">${esc(title)}</h2>

        ${trailerEmbed
          ? `<iframe class="yt" src="${esc(trailerEmbed)}"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen></iframe>`
          : `<div class="meta">Nessun trailer disponibile.</div>`
        }

        <div class="syn">${esc(synopsis || "Sinossi non disponibile.")}</div>

        <div class="section">
          <div class="sectionHead">
            <div style="font-weight:850;">Recensioni</div>
            <div class="row">
              <button id="btnMore" class="btn">Carica altre</button>
              <button id="btnAI" class="btn primary">AI: Pro/Contro + Riassunto</button>
            </div>
          </div>

          <div id="aiHost"></div>

          <div class="meta" id="revStatus" style="margin-top:10px;">Caricamento…</div>
          <div id="revList"></div>
        </div>
      </div>
    `;

    let page = 1;
    let loaded = []; // [{score, text}]
    const revStatus = document.getElementById("revStatus");
    const revList = document.getElementById("revList");
    const btnMore = document.getElementById("btnMore");
    const btnAI = document.getElementById("btnAI");
    const aiHost = document.getElementById("aiHost");

    function renderReview(r){
      const user = r?.user?.username || "utente";
      const score = (r?.score === 0 || r?.score) ? Number(r.score) : null;
      const date = r?.date || "";
      const content = (r?.review || r?.content || "").toString().trim();

      const div = document.createElement("div");
      div.className = "review";
      div.innerHTML = `
        <div class="reviewHead">
          <div><b>${esc(user)}</b></div>
          <div class="reviewMeta">
            ${score != null ? `<span class="badgeScore">★ ${esc(score)}</span>` : ``}
            <span>${esc(date)}</span>
          </div>
        </div>
        <div class="meta" style="margin-top:8px; color:#d8dcef;">${esc(content || "Testo non disponibile.")}</div>
      `;
      revList.appendChild(div);

      if (content) loaded.push({ score, text: content });
    }

    async function loadReviews(p){
      revStatus.textContent = "Caricamento…";
      try{
        const j = await jikanReviews(malId, p);
        const list = j?.data || [];

        if (p === 1){
          revList.innerHTML = "";
          loaded = [];
          aiHost.innerHTML = "";
        }

        if (!list.length){
          revStatus.textContent = (p === 1) ? "Nessuna recensione." : "Fine recensioni.";
          btnMore.disabled = true;
          return;
        }

        revStatus.textContent = `Pagina ${p} • ${list.length} recensioni`;
        list.forEach(renderReview);
        btnMore.disabled = !j?.pagination?.has_next_page;
      }catch(e){
        revStatus.textContent = "Errore recensioni: " + e.message;
      }
    }

    btnMore.addEventListener("click", async () => {
      page += 1;
      await loadReviews(page);
    });

    btnAI.addEventListener("click", async () => {
      try{
        btnAI.disabled = true;
        aiHost.innerHTML = `
          <div class="aiCard">
            <div class="aiRow">
              <div class="aiH">Riassunto recensioni</div>
              <div class="aiBadges">
                <span class="badge">Loading…</span>
              </div>
            </div>
            <div class="aiP">Elaborazione AI…</div>
          </div>
        `;

        if (!loaded.length){
          aiHost.querySelector(".aiP").textContent = "Non ci sono recensioni da analizzare.";
          return;
        }

        const out = await aiReviews(loaded.slice(0, 35));
        const summary = String(out?.summary || "").trim();
        const pros = Array.isArray(out?.pros) ? out.pros.map(String) : [];
        const cons = Array.isArray(out?.cons) ? out.cons.map(String) : [];
        const avg = (typeof out?.avg === "number") ? out.avg : null;

        aiHost.innerHTML = `
          <div class="aiGrid">
            <div class="aiCard">
              <div class="aiRow">
                <div class="aiH">Riassunto recensioni</div>
                <div class="aiBadges">
                  ${avg != null ? `<span class="badge good">Media review: ${avg.toFixed(2)}</span>` : ``}
                  <span class="badge">Reviews usate: ${Math.min(loaded.length, 35)}</span>
                </div>
              </div>
              <div class="aiP">${esc(summary || "Nessun riassunto.")}</div>
            </div>

            ${(pros.length || cons.length) ? `
              <div class="aiCard">
                <div class="aiRow">
                  <div class="aiH">Pro / Contro (super corto)</div>
                </div>

                <div class="cols">
                  <div>
                    <div class="khead">Pro</div>
                    ${pros.length ? `<ul class="klist">${pros.slice(0,6).map(x=>`<li>${esc(x)}</li>`).join("")}</ul>` : `<div class="meta">Nessuno.</div>`}
                  </div>

                  <div>
                    <div class="khead">Contro</div>
                    ${cons.length ? `<ul class="klist">${cons.slice(0,6).map(x=>`<li>${esc(x)}</li>`).join("")}</ul>` : `<div class="meta">Nessuno.</div>`}
                  </div>
                </div>
              </div>
            ` : ``}
          </div>
        `;

        aiHost.scrollIntoView({ behavior: "smooth", block: "start" });
      }catch(e){
        aiHost.innerHTML = `<div class="aiCard"><div class="aiH">AI</div><div class="aiP">Errore: ${esc(e.message)}</div></div>`;
      }finally{
        btnAI.disabled = false;
      }
    });

    await loadReviews(1);

  }catch(e){
    dlgBody.innerHTML = `<div class="meta">Errore: ${esc(e.message)}</div>`;
  }
}

// wiring
document.getElementById("btnSearch").addEventListener("click", runSearch);
document.getElementById("btnClear").addEventListener("click", () => {
  elQ.value = "";
  elGrid.innerHTML = "";
  setStatus("Pronto.");
  elMetaLine.textContent = "";
});

let t = null;
elQ.addEventListener("input", () => {
  clearTimeout(t);
  t = setTimeout(() => { if (elQ.value.trim().length >= 3) runSearch(); }, 350);
});
elQ.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
