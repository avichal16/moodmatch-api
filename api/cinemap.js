const TMDB_KEY = process.env.TMDB_API_KEY;

async function tmdb(path) {
  if (!TMDB_KEY) throw new Error("Missing TMDB_API_KEY");
  const joiner = path.includes("?") ? "&" : "?";
  const response = await fetch(`https://api.themoviedb.org/3${path}${joiner}api_key=${TMDB_KEY}&language=en-US`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.status_message || `TMDB request failed (${response.status})`);
  return data;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://mymoodmatch.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { query, id, random } = req.query;
    if (query) {
      const data = await tmdb(`/search/movie?query=${encodeURIComponent(query)}&include_adult=false`);
      return res.status(200).json((data.results || []).slice(0, 10));
    }

    if (random) {
      const page = Math.floor(Math.random() * 8) + 1;
      const data = await tmdb(`/movie/popular?page=${page}`);
      const pool = data.results || [];
      return res.status(200).json(pool[Math.floor(Math.random() * pool.length)] || null);
    }

    if (!id) return res.status(400).json({ error: "Provide query, id, or random" });
    const [details, credits, similar, recommendations, keywords] = await Promise.all([
      tmdb(`/movie/${id}`),
      tmdb(`/movie/${id}/credits`),
      tmdb(`/movie/${id}/similar`),
      tmdb(`/movie/${id}/recommendations`),
      tmdb(`/movie/${id}/keywords`)
    ]);

    const director = (credits.crew || []).find(person => person.job === "Director") || null;
    const related = [...(recommendations.results || []), ...(similar.results || [])]
      .filter((item, index, list) => item.id !== Number(id) && list.findIndex(other => other.id === item.id) === index)
      .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0))
      .slice(0, 12);

    return res.status(200).json({
      movie: details,
      director,
      genres: details.genres || [],
      keywords: (keywords.keywords || []).slice(0, 8),
      related
    });
  } catch (error) {
    return res.status(500).json({ error: "CineMap request failed", details: error.message });
  }
}