import OpenAI from "openai";
import fetch from "node-fetch";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TMDB_KEY = process.env.TMDB_API_KEY;
const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { mood, criteria, refId, refType } = req.query;
  if (!mood) return res.status(400).json({ error: "Missing mood input" });

  try {
    const pool = await fetchOpenAIPool(mood, criteria);
    const enrichedPool = await enrichPoolWithMetadata(pool);
    const moodEmbedding = await embedText(`Mood: ${mood}`);

    const [movies, tv, books] = await Promise.all([
      hybridScore(enrichedPool.filter(i=>i.type==='movie'), moodEmbedding, [], [], ""),
      hybridScore(enrichedPool.filter(i=>i.type==='tv'), moodEmbedding, [], [], ""),
      hybridScore(enrichedPool.filter(i=>i.type==='book'), moodEmbedding, [], [], "")
    ]);

    const spotify = await fetchSpotifyPlaylist(`${criteria} ${mood}`);
    res.status(200).json({ movies: finalizeResults(movies), tv: finalizeResults(tv), books: finalizeResults(books), spotify });
  } catch (e) {
    res.status(500).json({ error: "Recommendation failed", details: e.message });
  }
}

async function fetchOpenAIPool(mood, criteria) {
  const prompt = `Suggest 200 items: movies, TV series, and books for Mood: ${mood}, Style: ${criteria}. Return JSON with title, type (movie|tv|book), description, genre, tags.`;
  const resp = await client.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: prompt }], temperature: 0.7 });
  try { return JSON.parse(resp.choices[0].message.content); } catch { return []; }
}

async function enrichPoolWithMetadata(pool) {
  const results = [];
  for (const item of pool) {
    if (item.type === 'book') {
      results.push(item);
    } else {
      const query = encodeURIComponent(item.title);
      const url = `https://api.themoviedb.org/3/search/${item.type}?api_key=${TMDB_KEY}&query=${query}`;
      const resp = await fetch(url);
      const data = await resp.json();
      const match = data.results?.[0];
      if (match) {
        results.push({ ...item, id: match.id, image: match.poster_path ? `https://image.tmdb.org/t/p/w200${match.poster_path}` : "" });
      }
    }
  }
  return results;
}

async function embedText(text) {
  const resp = await client.embeddings.create({ model: "text-embedding-3-small", input: text });
  return resp.data[0].embedding;
}

async function hybridScore(items, moodEmbedding, refKeywords, refGenres, refTitle = "") {
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

function finalizeResults(items) {
  items.sort((a, b) => b.score - a.score);
  const top = items.slice(0, 12);
  return shuffleArray(top).slice(0, 6);
}

function shuffleArray(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

async function fetchSpotifyPlaylist(query) {
  try {
    const tokenResp = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": `Basic ${Buffer.from(`${SPOTIFY_ID}:${SPOTIFY_SECRET}`).toString("base64")}` },
      body: "grant_type=client_credentials"
    });
    const { access_token } = await tokenResp.json();
    const searchResp = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=playlist&limit=5`, { headers: { "Authorization": `Bearer ${access_token}` } });
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
