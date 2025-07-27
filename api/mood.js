import OpenAI from "openai";
import fetch from "node-fetch";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TMDB_KEY = process.env.TMDB_API_KEY || "c5bb9a766bdc90fcc8f7293f6cd9c26a";
const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID; 
const SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

export default async function handler(req, res) {
  const { mood } = req.query;
  if (!mood) return res.status(400).json({ error: "Missing mood" });

  try {
    // Step 1: Get embedding for user mood
    const moodEmbedding = await embedText(mood);

    // Step 2: Fetch candidate content
    const [movies, tv, books, spotify] = await Promise.all([
      fetchTMDB("movie"),
      fetchTMDB("tv"),
      fetchBooks(),
      fetchSpotifyPlaylist(mood)
    ]);

    // Step 3: Score each candidate by cosine similarity
    const scoredMovies = await scoreItems(movies, moodEmbedding);
    const scoredTV = await scoreItems(tv, moodEmbedding);
    const scoredBooks = await scoreItems(books, moodEmbedding);

    // Step 4: Pick top N for each
    const topMovies = scoredMovies.sort((a,b) => b.score - a.score).slice(0,6);
    const topTV = scoredTV.sort((a,b) => b.score - a.score).slice(0,6);
    const topBooks = scoredBooks.sort((a,b) => b.score - a.score).slice(0,6);

    res.status(200).json({
      movies: topMovies,
      tv: topTV,
      books: topBooks,
      spotify: spotify || null
    });
  } catch (e) {
    console.error("Mood API Error:", e);
    res.status(500).json({ error: "Failed to generate recommendations", details: e.message });
  }
}

// --- Helpers ---

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
    const combinedText = `${item.title} ${item.desc || ""} ${item.tags || ""}`;
    const itemEmbed = await embedText(combinedText);
    const score = cosineSimilarity(moodEmbedding, itemEmbed);
    results.push({ ...item, score, reason: `Matched mood by tone, tags, and vibe` });
  }
  return results;
}

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return dot / (normA * normB);
}

async function fetchTMDB(type) {
  const url = `https://api.themoviedb.org/3/${type}/popular?api_key=${TMDB_KEY}&language=en-US&page=1`;
  const resp = await fetch(url);
  const data = await resp.json();
  return (data.results || []).slice(0, 20).map(item => ({
    id: item.id,
    title: type === "movie" ? item.title : item.name,
    type,
    image: item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : "",
    desc: item.overview || "",
    tags: item.genre_ids?.join(", ")
  }));
}

async function fetchBooks() {
  const resp = await fetch(`https://www.googleapis.com/books/v1/volumes?q=subject:fiction&maxResults=20`);
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

async function fetchSpotifyPlaylist(mood) {
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

    const searchResp = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(mood)}&type=playlist&limit=1`, {
      headers: { "Authorization": `Bearer ${access_token}` }
    });
    const searchData = await searchResp.json();
    const playlist = searchData.playlists?.items?.[0];
    return playlist ? `https://open.spotify.com/embed/playlist/${playlist.id}` : null;
  } catch (e) {
    console.error("Spotify fetch failed:", e);
    return null;
  }
}
