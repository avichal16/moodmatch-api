import OpenAI from "openai";
import fetch from "node-fetch";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TMDB_KEY = process.env.TMDB_API_KEY;
const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// --- EMBEDDING HELPERS --

// Single string (for mood context )
async function embedText(text) {
  const resp = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });
  return resp.data[0].embedding;
}

// Batch embedding for multiple items (titles, descriptions, tags)
async function embedTexts(texts) {
  const resp = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: texts
  });
  return resp.data.map(r => r.embedding);
}


// --- PARALLEL TMDB ENRICHMENT ---

async function enrichPoolWithMetadata(pool) {
  const results = await Promise.all(pool.map(async (item) => {
    if (item.type === 'book') return item;
    try {
      const query = encodeURIComponent(item.title);
      const url = `https://api.themoviedb.org/3/search/${item.type}?api_key=${TMDB_KEY}&query=${query}`;
      const resp = await fetch(url).then(r => r.json());
      const match = resp.results?.[0];
      return match
        ? { ...item, id: match.id, image: match.poster_path ? `https://image.tmdb.org/t/p/w200${match.poster_path}` : '' }
        : item;
    } catch {
      return item;
    }
  }));
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

  // Prepare all item texts for embedding
  const texts = items.map(i => `${i.title} ${i.desc || ''} ${(Array.isArray(i.tags) ? i.tags.join(' ') : i.tags) || ''}`);
  const embeddings = await embedTexts(texts);

  if (!embeddings || embeddings.length !== items.length) return [];

  const results = items.map((item, idx) => {
    const sim = cosineSimilarity(moodEmbedding, embeddings[idx] || []);
    const keywordScore = keywordOverlap(refKeywords, item.tags || '');
    const genreScore = genreOverlap(refGenres, item.tags || '');
    const score = (0.5 * sim) + (0.3 * keywordScore) + (0.2 * genreScore);
    return { ...item, score, reason: `Matched mood & ${refTitle || 'context'}` };
  });

  return results;
}


// --- FINALIZE RESULTS (SAFE) ---

function finalizeResults(items) {
  if (!Array.isArray(items)) return [];  // Prevents frontend 'slice' crash
  items.sort((a, b) => (b.score || 0) - (a.score || 0));
  return shuffleArray(items.slice(0, 12)).slice(0, 6);
}


// --- HELPER FUNCTIONS (safe for arrays) ---
function keywordOverlap(ref, tags) {
  if (!ref.length || !tags) return 0;
  const tagString = Array.isArray(tags) ? tags.join(' ') : tags;
  const t = tagString.toLowerCase().split(/[\s,]+/);
  return ref.filter(k => t.includes(k.toLowerCase())).length / (ref.length || 1);
}

function genreOverlap(ref, tags) {
  if (!ref.length || !tags) return 0;
  const tagString = Array.isArray(tags) ? tags.join(' ') : tags;
  const t = tagString.toLowerCase().split(/[\s,]+/);
  return ref.filter(g => t.includes(g.toLowerCase())).length / (ref.length || 1);
}

export default async function handler(req, res) {
  console.log("Mood API start", req.query);

  // Always set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "https://mymoodmatch.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    console.log("CORS preflight handled");
    return res.status(200).end();
  }

  try {
    const { mood, criteria, refId, refType } = req.query;

    console.log("Fetching recommendations", { mood, criteria, refId, refType });

    // Replace with your recommendation logic (GPT/TMDB/Spotify/etc.)
    const results = await getRecommendations({ mood, criteria, refId, refType });

    console.log("Results ready", results);
    res.status(200).json(results);
  } catch (error) {
    console.error("API error:", error);

    // Ensure CORS is set even on errors
    res.setHeader("Access-Control-Allow-Origin", "https://mymoodmatch.com");
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
}


  // Handle /api/searh
  if (query) {
    try {
      const tmdbMovieUrl = `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}`;
      const tmdbTvUrl = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}`;
      const bookUrl = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}`;
      const [movieRes, tvRes, bookRes] = await Promise.all([
        fetch(tmdbMovieUrl).then(r => r.json()),
        fetch(tmdbTvUrl).then(r => r.json()),
        fetch(bookUrl).then(r => r.json())
      ]);
      const movies = (movieRes.results || []).map(m => ({ id: m.id, title: m.title, type: 'movie', image: m.poster_path ? `https://image.tmdb.org/t/p/w200${m.poster_path}` : '' }));
      const tv = (tvRes.results || []).map(t => ({ id: t.id, title: t.name, type: 'tv', image: t.poster_path ? `https://image.tmdb.org/t/p/w200${t.poster_path}` : '' }));
      const books = (bookRes.items || []).map(b => ({ id: b.id, title: b.volumeInfo?.title, type: 'book', image: b.volumeInfo?.imageLinks?.thumbnail || '' }));
      console.log("Step 5: Ready to send results");
  return res.status(200).json([...movies.slice(0, 5), ...tv.slice(0, 5), ...books.slice(0, 5)]);
    } catch (e) {
  console.error("Mood API failed", e);
  return res.status(500).json({ error: "Recommendation failed", details: e.message });
};
    }
  }

  // Handle /api/mood
  if (!mood) return res.status(400).json({ error: "Missing mood input" });
  try {
    const refMeta = refId && refType ? await fetchReferenceData(refId, refType) : { keywords: [], genres: [], title: "", overview: "" };
    const pool = await fetchOpenAIPool(mood, criteria);
    const enrichedPool = await enrichPoolWithMetadata(pool);
    const moodEmbedding = await embedText(`Mood: ${mood}\nReference: ${refMeta.title}\nOverview: ${refMeta.overview}\nGenres: ${refMeta.genres.join(', ')}`);
    const [movies, tv, books] = await Promise.all([
      hybridScore(enrichedPool.filter(i => i.type === 'movie'), moodEmbedding, refMeta.keywords, refMeta.genres, refMeta.title),
      hybridScore(enrichedPool.filter(i => i.type === 'tv'), moodEmbedding, refMeta.keywords, refMeta.genres, refMeta.title),
      hybridScore(enrichedPool.filter(i => i.type === 'book'), moodEmbedding, refMeta.keywords, refMeta.genres, refMeta.title)
    ]);
    const spotify = await fetchSpotifyPlaylist(`${criteria} ${mood}`);
    res.status(200).json({ movies: finalizeResults(movies), tv: finalizeResults(tv), books: finalizeResults(books), spotify });
  } catch (e) {
  console.error("Mood API failed", e);
  return res.status(500).json({ error: "Recommendation failed", details: e.message });
});
  }
}

async function fetchReferenceData(id, type) {
  try {
    if (type === "book") {
      const resp = await fetch(`https://www.googleapis.com/books/v1/volumes/${id}`);
      const data = await resp.json();
      return { title: data.volumeInfo?.title || "Unknown Book", overview: data.volumeInfo?.description || "", keywords: data.volumeInfo?.categories || [], genres: data.volumeInfo?.categories || [] };
    } else {
      const details = await fetch(`https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&language=en-US`).then(r=>r.json());
      const keywordsResp = await fetch(`https://api.themoviedb.org/3/${type}/${id}/keywords?api_key=${TMDB_KEY}`).then(r=>r.json());
      return { title: details.title || details.name || "Unknown", overview: details.overview || "", keywords: (keywordsResp.keywords || []).map(k => k.name), genres: (details.genres || []).map(g => g.name) };
    }
  } catch {
    return { title: "Unknown", overview: "", keywords: [], genres: [] };
  }
}

async function fetchOpenAIPool(mood, criteria) {
  const prompt = `Return a JSON array (no extra text) of 20 recommendations for Mood: ${mood}, Style: ${criteria}.
  Each object must have: title (string), type ("movie"|"tv"|"book"), desc (string), genre (string[]), tags (string[]).`;
  
  const resp = await client.chat.completions.create({
  model: "gpt-4o-mini",  // faster alternative
  messages: [{ role: "user", content: prompt }],
  temperature: 0.7
});
  
  let raw = resp.choices[0]?.message?.content || "[]";
  try {
    // Strip Markdown fences if GPT adds ```json
    raw = raw.replace(/```json|```/g, "");
    return JSON.parse(raw);
  } catch (e) {
  console.error("Mood API failed", e);
  return res.status(500).json({ error: "Recommendation failed", details: e.message });
}
}
async function fetchSpotifyPlaylist(query) {
  try {
    const tokenResp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${Buffer.from(`${SPOTIFY_ID}:${SPOTIFY_SECRET}`).toString("base64")}`
      },
      body: "grant_type=client_credentials"
    });
    const { access_token } = await tokenResp.json();

    const searchResp = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=playlist&limit=5`,
      { headers: { "Authorization": `Bearer ${access_token}` } }
    );
    const data = await searchResp.json();
    const playlists = data.playlists?.items || [];
    if (!playlists.length) return null;

    const pick = playlists[Math.floor(Math.random() * playlists.length)];
    return `https://open.spotify.com/embed/playlist/${pick.id}`;
  } catch (e) {
  console.error("Mood API failed", e);
  return res.status(500).json({ error: "Recommendation failed", details: e.message });
}
}

console.log("OPENAI_API_KEY in runtime:", process.env.OPENAI_API_KEY);
