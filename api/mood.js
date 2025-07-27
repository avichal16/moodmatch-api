import OpenAI from "openai";
import fetch from "node-fetch";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TMDB_KEY = process.env.TMDB_API_KEY || "c5bb9a766bdc90fcc8f7293f6cd9c26a";
const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

export default async function handler(req, res) {
  // --- CORS: Only allow your frontend ---
  res.setHeader("Access-Control-Allow-Origin", "https://mymoodmatch.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.status(200).end(); // Preflight check
  }

  const { mood, refId, refType } = req.query;
  if (!mood) return res.status(400).json({ error: "Missing mood input" });

  try {
    // Step 1: Build context string
    let refKeywords = "";
    let refGenres = "";
    let refTitle = "";

    if (refId && refType) {
      const refData = await fetchReferenceData(refId, refType);
      refKeywords = refData.keywords.join(", ");
      refGenres = refData.genres.join(", ");
      refTitle = refData.title;
    }

    const context = `Mood: ${mood}, Reference: ${refTitle}, Keywords: ${refKeywords}, Genres: ${refGenres}`;
    const moodEmbedding = await embedText(context);

    // Step 2: Fetch candidates (dynamic pool)
    const [movies, tv, books, spotify] = await Promise.all([
      fetchDiscover("movie", refGenres, refKeywords),
      fetchDiscover("tv", refGenres, refKeywords),
      fetchBooks(refKeywords || refGenres || mood),
      fetchSpotifyPlaylist(`${mood} ${refTitle}`)
    ]);

    // Step 3: Score candidates by embeddings
    const scoredMovies = await scoreItems(movies, moodEmbedding);
    const scoredTV = await scoreItems(tv, moodEmbedding);
    const scoredBooks = await scoreItems(books, moodEmbedding);

    // Step 4: Return top picks
    res.status(200).json({
      movies: scoredMovies.sort((a, b) => b.score - a.score).slice(0, 6),
      tv: scoredTV.sort((a, b) => b.score - a.score).slice(0, 6),
      books: scoredBooks.sort((a, b) => b.score - a.score).slice(0, 6),
      spotify: spotify || null
    });
  } catch (e) {
    console.error("Mood API Error:", e);
    res.status(500).json({ error: "Failed to fetch recommendations", details: e.message });
  }
}

// ---- Helpers ----

async function embedText(text) {
  const resp = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });
  return resp.data[0].embedding;
}

async function scoreItems(items, moodEmbedding) {
  const results = [];
  for (const item of items) {
    const text = `${item.title} ${item.desc || ""} ${item.tags || ""}`;
    const itemEmbed = await embedText(text);
    const score = cosineSimilarity(moodEmbedding, itemEmbed);
    results.push({ ...item, score, reason: `Matched your mood and reference vibe.` });
  }
  return results;
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (normA * normB);
}

async function fetchReferenceData(id, type) {
  try {
    if (type === "book") {
      const resp = await fetch(`https://www.googleapis.com/books/v1/volumes/${id}`);
      const data = await resp.json();
      return {
        title: data.volumeInfo?.title || "Unknown Book",
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
        keywords: (keyData.keywords || []).map(k => k.name),
        genres: (detData.genres || []).map(g => g.name)
      };
    }
  } catch {
    return { title: "Unknown", keywords: [], genres: [] };
  }
}

async function fetchDiscover(type, genres, keywords) {
  const page = Math.floor(Math.random() * 10) + 1;
  const genreParam = genres ? `&with_genres=${encodeURIComponent(genres)}` : "";
  const keywordParam = keywords ? `&with_keywords=${encodeURIComponent(keywords)}` : "";
  const url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_KEY}&language=en-US&page=${page}${genreParam}${keywordParam}&vote_count.gte=50`;
  const resp = await fetch(url);
  const data = await resp.json();
  return (data.results || []).map(item => ({
    id: item.id,
    title: type === "movie" ? item.title : item.name,
    type,
    image: item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : "",
    desc: item.overview || "",
    tags: (item.genre_ids || []).join(", ")
  }));
}

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
