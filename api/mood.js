import OpenAI from "openai";
import fetch from "node-fetch";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TMDB_KEY = process.env.TMDB_API_KEY || "c5bb9a766bdc90fcc8f7293f6cd9c26a";
const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

export default async function handler(req, res) {
  // --- CORS for frontend ---
  res.setHeader("Access-Control-Allow-Origin", "https://mymoodmatch.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { mood, refId, refType } = req.query;
  if (!mood) return res.status(400).json({ error: "Missing mood input" });

  try {
    // Step 1: Get reference title keywords, genres, and summary
    let refKeywords = [];
    let refGenres = [];
    let refTitle = "";
    let refOverview = "";

    if (refId && refType) {
      const refData = await fetchReferenceData(refId, refType);
      refKeywords = refData.keywords;
      refGenres = refData.genres;
      refTitle = refData.title;
      refOverview = refData.overview || "";
    }

    // Build a strong context string
    const context = `Mood Context:
    Mood: ${mood}
    Reference Title: ${refTitle}
    Overview: ${refOverview}
    Keywords: ${refKeywords.join(", ")}
    Genres: ${refGenres.join(", ")}`;

    const moodEmbedding = await embedText(context);

    // Step 2: Fetch a big candidate pool (200+ titles)
    const [moviesPool, tvPool, booksPool, spotify] = await Promise.all([
      fetchExpandedPool("movie", refGenres, refKeywords),
      fetchExpandedPool("tv", refGenres, refKeywords),
      fetchBooks(refKeywords.join(" ") || refGenres.join(" ") || mood),
      fetchSpotifyPlaylist(`${mood} ${refTitle}`)
    ]);

    // Step 3: Score with hybrid method
    const scoredMovies = await hybridScore(moviesPool, moodEmbedding, refKeywords, refGenres);
    const scoredTV = await hybridScore(tvPool, moodEmbedding, refKeywords, refGenres);
    const scoredBooks = await hybridScore(booksPool, moodEmbedding, refKeywords, refGenres);

    // Step 4: Sort, shuffle near ties, return top 6 each
    res.status(200).json({
      movies: finalizeResults(scoredMovies),
      tv: finalizeResults(scoredTV),
      books: finalizeResults(scoredBooks),
      spotify: spotify || null
    });
  } catch (e) {
    console.error("Mood API Error:", e);
    res.status(500).json({ error: "Failed to fetch recommendations", details: e.message });
  }
}

// --------------------
// Embeddings & Scoring
// --------------------
async function embedText(text) {
  const resp = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });
  return resp.data[0].embedding;
}

async function hybridScore(items, moodEmbedding, refKeywords, refGenres) {
  const results = [];
  for (const item of items) {
    const text = `${item.title} ${item.desc || ""} ${item.tags || ""}`;
    const itemEmbed = await embedText(text);
    const sim = cosineSimilarity(moodEmbedding, itemEmbed);
    const keywordScore = keywordOverlap(refKeywords, item.tags || "");
    const genreScore = genreOverlap(refGenres, item.tags || "");
    const finalScore = (0.5 * sim) + (0.3 * keywordScore) + (0.2 * genreScore);
    results.push({ ...item, score: finalScore, reason: `Matched mood & ${refTitle || "context"}` });
  }
  return results;
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (normA * normB);
}

function keywordOverlap(refKeywords, tags) {
  if (!refKeywords.length || !tags) return 0;
  const tagList = tags.toLowerCase().split(/[\s,]+/);
  const matches = refKeywords.filter(k => tagList.includes(k.toLowerCase()));
  return matches.length / (refKeywords.length || 1);
}

function genreOverlap(refGenres, tags) {
  if (!refGenres.length || !tags) return 0;
  const tagList = tags.toLowerCase().split(/[\s,]+/);
  const matches = refGenres.filter(g => tagList.includes(g.toLowerCase()));
  return matches.length / (refGenres.length || 1);
}

// Shuffle similar-score ties and select top 6
function finalizeResults(items) {
  items.sort((a, b) => b.score - a.score);
  const top = items.slice(0, 12); // take more before randomizing
  return shuffleArray(top).slice(0, 6);
}
function shuffleArray(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

// --------------------
// Data Fetch Functions
// --------------------
async function fetchReferenceData(id, type) {
  try {
    if (type === "book") {
      const resp = await fetch(`https://www.googleapis.com/books/v1/volumes/${id}`);
      const data = await resp.json();
      return {
        title: data.volumeInfo?.title || "Unknown Book",
        overview: data.volumeInfo?.description || "",
        keywords: (data.volumeInfo?.categories || []),
        genres: (data.volumeInfo?.categories || [])
      };
    } else {
      const details = await fetch(`https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&language=en-US`);
      const detData = await details.json();
      const keywordsResp = await fetch(`https://api.themoviedb.org/3/${type}/${id}/keywords?api_key=${TMDB_KEY}`);
      const keyData = await keywordsResp.json();
      return {
        title: detData.title || detData.name || "Unknown",
        overview: detData.overview || "",
        keywords: (keyData.keywords || []).map(k => k.name),
        genres: (detData.genres || []).map(g => g.name)
      };
    }
  } catch {
    return { title: "Unknown", overview: "", keywords: [], genres: [] };
  }
}

// Pulls 200+ candidates from multiple TMDB sources
async function fetchExpandedPool(type, genres, keywords) {
  const endpoints = [
    `discover/${type}?with_genres=${encodeURIComponent(genres || "")}&with_keywords=${encodeURIComponent(keywords || "")}`,
    `discover/${type}?sort_by=vote_average.desc`,
    `${type}/top_rated`,
    `${type}/now_playing`
  ];

  const allResults = [];
  for (const ep of endpoints) {
    for (let p = 1; p <= 5; p++) {
      const url = `https://api.themoviedb.org/3/${ep}&api_key=${TMDB_KEY}&language=en-US&page=${p}`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.results) allResults.push(...data.results);
    }
  }

  // Deduplicate by ID
  const unique = new Map();
  for (const item of allResults) {
    if (!unique.has(item.id)) {
      unique.set(item.id, {
        id: item.id,
        title: type === "movie" ? item.title : item.name,
        type,
        image: item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : "",
        desc: item.overview || "",
        tags: (item.genre_ids || []).join(", ")
      });
    }
  }
  return Array.from(unique.values());
}

// Books & Spotify remain unchanged
async function fetchBooks(query) {
  const q = encodeURIComponent(query || "fiction");
  const start = Math.floor(Math.random() * 5) * 20;
  const resp = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=20&startIndex=${start}`);
  const data = await resp.json();
  return (data.items || []).map(b => ({
    id: b.id,
    title: b.volumeInfo?.title,
    type: "book",
    image: b.volumeInfo?.imageLinks?.thumbnail || "",
    desc: b.volumeInfo?.description || "",
    tags: (b.volumeInfo?.categories || []).join(", ")
  }));
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

    const searchResp = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=playlist&limit=5`, {
      headers: { "Authorization": `Bearer ${access_token}` }
    });
    const searchData = await searchResp.json();
    const playlists = searchData.playlists?.items || [];
    if (!playlists.length) return null;
    const pick = playlists[Math.floor(Math.random() * playlists.length)];
    return `https://open.spotify.com/embed/playlist/${pick.id}`;
  } catch (e) {
    console.error("Spotify fetch failed:", e);
    return null;
  }
}
