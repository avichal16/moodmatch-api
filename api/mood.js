import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TMDB_KEY = process.env.TMDB_API_KEY;
const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// --- EMBEDDING HELPERS ---

async function embedText(text) {
  const resp = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });
  return resp.data[0].embedding;
}

async function embedTexts(texts) {
  const resp = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: texts
  });
  return resp.data.map(r => r.embedding);
}

// --- PARALLEL TMDB ENRICHMENT --


import stringSimilarity from "string-similarity"; // Added for approximate title matching

async function enrichPoolWithMetadata(pool) {
  let successes = 0;
  const results = await Promise.all(
    pool.map(async item => {
      if (item.type === "book") {
        try {
          const searchUrl =
            `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
              item.title
            )}&maxResults=5`;
          const searchResp = await fetch(searchUrl).then(r => r.json());
          if (!searchResp.items?.length) {
            return item;
          }
          const titles = searchResp.items.map(b => b.volumeInfo?.title || "");
          const bestIndex = stringSimilarity.findBestMatch(item.title, titles)
            .bestMatchIndex;
          const match = searchResp.items[bestIndex];
          const info = match.volumeInfo || {};
          const enriched = {
            ...item,
            id: match.id,
            title: info.title || item.title,
            desc: info.description || item.desc,
            image: (info.imageLinks?.thumbnail || "").replace(/^http:/, "https:")
          };
          if (
            (!item.image && enriched.image) ||
            (info.description && info.description !== item.desc)
          ) {
            successes++;
          }
          return enriched;
        } catch (err) {
          console.error("Book enrichment failed for:", item.title, err);
          return item;
        }
      }
      try {
        const cleanTitle = item.title.replace(/\(.*?\)/g, "").trim();
        const searchUrl = `https://api.themoviedb.org/3/search/${item.type}?api_key=${TMDB_KEY}&query=${encodeURIComponent(cleanTitle)}`;
        const searchResp = await fetch(searchUrl).then(r => r.json());
        console.log(
          `TMDB search for "${cleanTitle}" -> ${searchResp.results?.length || 0} results`
        );
        if (!searchResp.results?.length) {
          return item;
        }
        const titles = searchResp.results.map(r => r.title || r.name || "");
        const bestIndex =
          stringSimilarity.findBestMatch(cleanTitle, titles).bestMatchIndex;
        const match = searchResp.results[bestIndex];
        const chosenTitle = (match.title || match.name || "").slice(0, 80);
        console.log(`Selected TMDB title: ${chosenTitle}`);
        let posterPath = match.poster_path;
        let description = match.overview || item.desc || "";
        if (!posterPath || !description) {
          const detailUrl = `https://api.themoviedb.org/3/${item.type}/${match.id}?api_key=${TMDB_KEY}&language=en-US`;
          const detailResp = await fetch(detailUrl).then(r => r.json());
          posterPath = detailResp.poster_path || detailResp.backdrop_path || "";
          description = detailResp.overview || description;
        }
        const enriched = {
          ...item,
          id: match.id,
          title: match.title || match.name || item.title,
          desc: description,
          image: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : ""
        };
        if (
          (posterPath && !item.image) ||
          (description && (!item.desc || description !== item.desc))
        ) {
          successes++;
        }
        return enriched;
      } catch (err) {
        console.error("Metadata enrichment failed for:", item.title, err);
        return item;
      }
    })
  );
  console.log(`Metadata enriched ${successes}/${pool.length} items`);
  return results;
}


function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (normA * normB);
}

function shuffleArray(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

// --- BATCHED HYBRID SCORING ---

async function hybridScore(items, moodEmbedding, refKeywords, refGenres, refTitle = "") {
  if (!items || !items.length) return [];

  const texts = items.map(i => `${i.title} ${i.desc || ""} ${(Array.isArray(i.tags) ? i.tags.join(" ") : i.tags) || ""}`);
  const embeddings = await embedTexts(texts);
  if (!embeddings || embeddings.length !== items.length) return [];

  const results = items.map((item, idx) => {
    const sim = cosineSimilarity(moodEmbedding, embeddings[idx] || []);
    const keywordScore = keywordOverlap(refKeywords, item.tags || "");
    const genreScore = genreOverlap(refGenres, item.tags || "");
    const score = 0.5 * sim + 0.3 * keywordScore + 0.2 * genreScore;
    return { ...item, score, reason: `Matched mood & ${refTitle || "context"}` };
  });

  return results;
}

// --- FINALIZE RESULTS (SAFE) ---

function finalizeResults(items) {
  if (!Array.isArray(items)) return [];
  items.sort((a, b) => (b.score || 0) - (a.score || 0));
  return shuffleArray(items.slice(0, 12)).slice(0, 6);
}

// --- HELPER FUNCTIONS ---

function keywordOverlap(ref, tags) {
  if (!ref.length || !tags) return 0;
  const tagString = Array.isArray(tags) ? tags.join(" ") : tags;
  const t = tagString.toLowerCase().split(/[\s,]+/);
  return ref.filter(k => t.includes(k.toLowerCase())).length / (ref.length || 1);
}

function genreOverlap(ref, tags) {
  if (!ref.length || !tags) return 0;
  const tagString = Array.isArray(tags) ? tags.join(" ") : tags;
  const t = tagString.toLowerCase().split(/[\s,]+/);
  return ref.filter(g => t.includes(g.toLowerCase())).length / (ref.length || 1);
}

export default async function handler(req, res) {
  console.log("Mood API start", req.query);

  res.setHeader("Access-Control-Allow-Origin", "https://mymoodmatch.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    console.log("CORS preflight handled");
    return res.status(200).end();
  }

  const { query, mood, criteria = "popular", refId, refType } = req.query;

  try {
    if (query) {
      const tmdbMovieUrl = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}`;
      const tmdbTvUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}`;
      const bookUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}`;
      const [movieRes, tvRes, bookRes] = await Promise.all([
        fetch(tmdbMovieUrl).then(r => r.json()),
        fetch(tmdbTvUrl).then(r => r.json()),
        fetch(bookUrl).then(r => r.json())
      ]);
      const movies = (movieRes.results || []).map(m => ({
        id: m.id,
        title: m.title,
        type: "movie",
        image: m.poster_path ? `https://image.tmdb.org/t/p/w200${m.poster_path}` : ""
      }));
      const tv = (tvRes.results || []).map(t => ({
        id: t.id,
        title: t.name,
        type: "tv",
        image: t.poster_path ? `https://image.tmdb.org/t/p/w200${t.poster_path}` : ""
      }));
      const books = (bookRes.items || []).map(b => ({
        id: b.id,
        title: b.volumeInfo?.title,
        type: "book",
        image: b.volumeInfo?.imageLinks?.thumbnail || ""
      }));
      return res.status(200).json([
        ...movies.slice(0, 5),
        ...tv.slice(0, 5),
        ...books.slice(0, 5)
      ]);
    }

    if (!mood) {
      return res.status(400).json({ error: "Missing mood input" });
    }

    const refMeta =
      refId && refType
        ? await fetchReferenceData(refId, refType)
        : { keywords: [], genres: [], title: "", overview: "" };
    let pool = await fetchOpenAIPool(mood, criteria);
    
if (!pool.length) {
  const trendingResp = await fetch(`https://api.themoviedb.org/3/trending/movie/week?api_key=${TMDB_KEY}`).then(r => r.json());
  pool = (trendingResp.results || []).slice(0, 15).map(m => ({
    title: m.title,
    type: "movie",
    tags: [],
    desc: m.overview || "Trending movie",
    id: m.id,
    image: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : ""
  }));
}
const enrichedPool = await enrichPoolWithMetadata(pool);
    const bookDebug = enrichedPool
      .filter(i => i.type === "book")
      .map(b => ({
        title: b.title,
        hasImage: !!b.image,
        hasDesc: !!b.desc
      }));
    console.log("Book items after enrichment:", JSON.stringify(bookDebug));

    const moodEmbedding = await embedText(
      `Mood: ${mood}\nReference: ${refMeta.title}\nOverview: ${refMeta.overview}\nGenres: ${refMeta.genres.join(", ")}`
    );
    const [movies, tv, books] = await Promise.all([
      hybridScore(
        enrichedPool.filter(i => i.type === "movie"),
        moodEmbedding,
        refMeta.keywords,
        refMeta.genres,
        refMeta.title
      ),
      hybridScore(
        enrichedPool.filter(i => i.type === "tv"),
        moodEmbedding,
        refMeta.keywords,
        refMeta.genres,
        refMeta.title
      ),
      hybridScore(
        enrichedPool.filter(i => i.type === "book"),
        moodEmbedding,
        refMeta.keywords,
        refMeta.genres,
        refMeta.title
      )
    ]);
    const spotify = await fetchSpotifyPlaylist(`${criteria} ${mood}`);
    const finalMovies = finalizeResults(movies);
    const finalTv = finalizeResults(tv);
    const finalBooks = finalizeResults(books);
    console.log(
      "Final books payload:",
      finalBooks.map(b => ({
        title: b.title,
        image: !!b.image,
        hasDesc: !!b.desc
      }))
    );
    res.status(200).json({
      movies: finalMovies,
      tv: finalTv,
      books: finalBooks,
      spotify
    });
  } catch (e) {
    console.error("Mood API failed", e);
    res.status(500).json({ error: "Recommendation failed", details: e.message });
  }
}

async function fetchReferenceData(id, type) {
  try {
    if (type === "book") {
      const resp = await fetch(`https://www.googleapis.com/books/v1/volumes/${id}`);
      const data = await resp.json();
      return {
        title: data.volumeInfo?.title || "Unknown Book",
        overview: data.volumeInfo?.description || "",
        keywords: data.volumeInfo?.categories || [],
        genres: data.volumeInfo?.categories || []
      };
    }
    const details = await fetch(
      `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&language=en-US`
    ).then(r => r.json());
    const keywordsResp = await fetch(
      `https://api.themoviedb.org/3/${type}/${id}/keywords?api_key=${TMDB_KEY}`
    ).then(r => r.json());
    return {
      title: details.title || details.name || "Unknown",
      overview: details.overview || "",
      keywords: (keywordsResp.keywords || []).map(k => k.name),
      genres: (details.genres || []).map(g => g.name)
    };
  } catch {
    return { title: "Unknown", overview: "", keywords: [], genres: [] };
  }
}


async function fetchOpenAIPool(mood, criteria) {
  const prompt = `
  Recommend 12 movies, 8 TV shows, and 5 books that match this mood:
  Mood: ${mood}.
  Criteria: ${criteria} (focus on popular, widely available content).

  Output a JSON array ONLY with:
  - "title" (no year, emojis, or extra characters),
  - "type" ("movie", "tv", or "book"),
  - "tags" (array of genres),
  - "desc" (1-sentence mood-matched summary).
  `;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7
  });

  let raw = resp.choices[0]?.message?.content || "[]";
  raw = raw.trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\n/, "").replace(/\n```$/, "");
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const truncated = raw.length > 500 ? raw.slice(0, 500) + "..." : raw;
    console.error("Invalid GPT response:", truncated, err);
    return [];
  }
}

async function fetchSpotifyPlaylist(query) {
  try {
    const tokenResp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${SPOTIFY_ID}:${SPOTIFY_SECRET}`).toString("base64")}`
      },
      body: "grant_type=client_credentials"
    });
    const { access_token } = await tokenResp.json();

    const searchResp = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=playlist&limit=5`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );
    const data = await searchResp.json();
    const playlists = data.playlists?.items || [];
    if (!playlists.length) return null;

    const pick = playlists[Math.floor(Math.random() * playlists.length)];
    return `https://open.spotify.com/embed/playlist/${pick.id}`;
  } catch (e) {
    console.error("Spotify fetch failed", e);
    return null;
  }
}


