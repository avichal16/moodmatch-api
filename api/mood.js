import stringSimilarity from "string-similarity";

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TMDB_KEY = process.env.TMDB_API_KEY;
const SPOTIFY_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

const recommendationSchema = {
  type: "ARRAY",
  minItems: 18,
  maxItems: 25,
  items: {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      type: { type: "STRING", enum: ["movie", "tv", "book"] },
      tags: { type: "ARRAY", items: { type: "STRING" } },
      desc: { type: "STRING" },
      reason: { type: "STRING" },
      score: { type: "NUMBER" }
    },
    required: ["title", "type", "tags", "desc", "reason", "score"]
  }
};

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items
    .filter(item => item && ["movie", "tv", "book"].includes(item.type) && item.title)
    .map(item => ({
      ...item,
      title: String(item.title).replace(/\s*\([^)]*\)\s*$/, "").trim(),
      tags: Array.isArray(item.tags) ? item.tags : [],
      desc: String(item.desc || "").trim(),
      reason: String(item.reason || "Matched your mood").trim(),
      score: Math.max(0, Math.min(1, Number(item.score) || 0.5))
    }))
    .filter(item => {
      const key = `${item.type}:${item.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function createPlanTitle(mood, criteria) {
  const text = `${mood} ${criteria}`.toLowerCase();
  const rules = [
    [/cozy|relax|calm|rain|comfort/, "A Cozy Escape"],
    [/funny|laugh|comedy|happy|uplift/, "A Feel-Good Reset"],
    [/romantic|date|love/, "A Romantic Night In"],
    [/thrill|suspense|intense|scary|horror/, "An Edge-of-Your-Seat Night"],
    [/mind|thought|smart|philosoph|sci-fi|science fiction/, "A Mind-Bending Journey"],
    [/emotional|cry|moving|sad/, "A Beautiful Emotional Journey"],
    [/adventure|exciting|energy|travel/, "An Adventure Beyond the Ordinary"],
    [/hidden|niche|underrated/, "A Hidden-Gems Discovery"],
    [/classic/, "A Timeless Story Night"]
  ];
  return rules.find(([pattern]) => pattern.test(text))?.[1] || "Your Personalized Entertainment Plan";
}

async function fetchGeminiPool(mood, criteria, refMeta) {
  if (!GEMINI_KEY) throw new Error("Missing GEMINI_API_KEY");
  const reference = refMeta?.title
    ? `Reference title: ${refMeta.title}. Reference overview: ${refMeta.overview || ""}. Reference genres: ${(refMeta.genres || []).join(", ")}.`
    : "No reference title was selected.";
  const prompt = `You are MoodMatch, an expert cross-media recommendation engine.
User mood or request: ${mood}
Preference: ${criteria || "popular"}
${reference}

Always recommend all three categories in one response: exactly 8 movies, 8 TV shows, and 8 books.
Choose real works that can be found in TMDB or Google Books. Balance strong mood fit with variety. Avoid duplicate franchises and near-identical choices. Include international choices when appropriate. The reason must explain the mood match in one concise sentence. Score each item from 0 to 1 based on fit. Return only schema-valid JSON.`;
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.85, responseMimeType: "application/json", responseSchema: recommendationSchema }
    })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini request failed (${response.status})`);
  const raw = payload?.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("") || "[]";
  return normalizeItems(JSON.parse(raw));
}

async function enrichItem(item) {
  if (item.type === "book") {
    try {
      const data = await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(item.title)}&maxResults=5`).then(r => r.json());
      if (!data.items?.length) return item;
      const titles = data.items.map(book => book.volumeInfo?.title || "");
      const match = data.items[stringSimilarity.findBestMatch(item.title, titles).bestMatchIndex];
      const info = match.volumeInfo || {};
      return { ...item, id: match.id, title: info.title || item.title, desc: info.description || item.desc, image: (info.imageLinks?.thumbnail || "").replace(/^http:/, "https:") };
    } catch (error) {
      console.error("Book enrichment failed", item.title, error);
      return item;
    }
  }
  try {
    if (!TMDB_KEY) return item;
    const cleanTitle = item.title.replace(/\(.*?\)/g, "").trim();
    const data = await fetch(`https://api.themoviedb.org/3/search/${item.type}?api_key=${TMDB_KEY}&query=${encodeURIComponent(cleanTitle)}`).then(r => r.json());
    if (!data.results?.length) return item;
    const titles = data.results.map(result => result.title || result.name || "");
    const match = data.results[stringSimilarity.findBestMatch(cleanTitle, titles).bestMatchIndex];
    return { ...item, id: match.id, title: match.title || match.name || item.title, desc: match.overview || item.desc, image: match.poster_path ? `https://image.tmdb.org/t/p/w500${match.poster_path}` : "" };
  } catch (error) {
    console.error("TMDB enrichment failed", item.title, error);
    return item;
  }
}

function finalize(items, type) {
  return items.filter(item => item.type === type).sort((a, b) => b.score - a.score).slice(0, 6);
}

async function fetchReferenceData(id, type) {
  try {
    if (type === "book") {
      const data = await fetch(`https://www.googleapis.com/books/v1/volumes/${id}`).then(r => r.json());
      return { title: data.volumeInfo?.title || "", overview: data.volumeInfo?.description || "", genres: data.volumeInfo?.categories || [] };
    }
    if (!TMDB_KEY) return { title: "", overview: "", genres: [] };
    const data = await fetch(`https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_KEY}&language=en-US`).then(r => r.json());
    return { title: data.title || data.name || "", overview: data.overview || "", genres: (data.genres || []).map(genre => genre.name) };
  } catch {
    return { title: "", overview: "", genres: [] };
  }
}

async function fetchSpotifyPlaylist(query) {
  try {
    if (!SPOTIFY_ID || !SPOTIFY_SECRET) return null;
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${SPOTIFY_ID}:${SPOTIFY_SECRET}`).toString("base64")}` },
      body: "grant_type=client_credentials"
    });
    if (!tokenResponse.ok) return null;
    const { access_token } = await tokenResponse.json();
    const data = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=playlist&limit=5`, { headers: { Authorization: `Bearer ${access_token}` } }).then(r => r.json());
    const playlists = (data.playlists?.items || []).filter(Boolean);
    if (!playlists.length) return null;
    const pick = playlists[Math.floor(Math.random() * playlists.length)];
    return `https://open.spotify.com/embed/playlist/${pick.id}`;
  } catch (error) {
    console.error("Spotify fetch failed", error);
    return null;
  }
}

async function searchCatalog(query) {
  const [movieData, tvData, bookData] = await Promise.all([
    fetch(`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}`).then(r => r.json()),
    fetch(`https://api.themoviedb.org/3/search/tv?api_key=${TMDB_KEY}&query=${encodeURIComponent(query)}`).then(r => r.json()),
    fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}`).then(r => r.json())
  ]);
  return [
    ...(movieData.results || []).slice(0, 5).map(item => ({ id: item.id, title: item.title, type: "movie", image: item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : "" })),
    ...(tvData.results || []).slice(0, 5).map(item => ({ id: item.id, title: item.name, type: "tv", image: item.poster_path ? `https://image.tmdb.org/t/p/w200${item.poster_path}` : "" })),
    ...(bookData.items || []).slice(0, 5).map(item => ({ id: item.id, title: item.volumeInfo?.title, type: "book", image: item.volumeInfo?.imageLinks?.thumbnail || "" }))
  ];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://mymoodmatch.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  const { query, mood, criteria = "popular", refId, refType } = req.query;
  try {
    if (query) return res.status(200).json(await searchCatalog(query));
    if (!mood) return res.status(400).json({ error: "Missing mood input" });
    const refMeta = refId && refType ? await fetchReferenceData(refId, refType) : null;
    const generated = await fetchGeminiPool(mood, criteria, refMeta);
    const enriched = await Promise.all(generated.map(enrichItem));
    const spotify = await fetchSpotifyPlaylist(`${criteria} ${mood}`);
    return res.status(200).json({
      planTitle: createPlanTitle(mood, criteria),
      mood,
      criteria,
      movies: finalize(enriched, "movie"),
      tv: finalize(enriched, "tv"),
      books: finalize(enriched, "book"),
      spotify
    });
  } catch (error) {
    console.error("Mood API failed", error);
    return res.status(500).json({ error: "Recommendation failed", details: error.message });
  }
}
