const TMDB_KEY = process.env.TMDB_API_KEY;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === "https://mymoodmatch.com" || origin === "https://www.mymoodmatch.com") return true;
  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === "https:" && (
      hostname === "moodmatch-frontend.vercel.app" ||
      (hostname.endsWith(".vercel.app") && hostname.includes("moodmatch-frontend"))
    );
  } catch {
    return false;
  }
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function tmdb(path) {
  if (!TMDB_KEY) throw new Error("Missing TMDB_API_KEY");
  const joiner = path.includes("?") ? "&" : "?";
  const response = await fetch(`https://api.themoviedb.org/3${path}${joiner}api_key=${TMDB_KEY}&language=en-US`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.status_message || `TMDB request failed (${response.status})`);
  return data;
}

function uniqueMovies(items, excludeId) {
  return (items || [])
    .filter(item => item?.id && item.id !== Number(excludeId) && item.poster_path)
    .filter((item, index, list) => list.findIndex(other => other.id === item.id) === index)
    .sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { query, id, random, personId, genreId } = req.query;

    if (query) {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
      const data = await tmdb(`/search/movie?query=${encodeURIComponent(query)}&include_adult=false`);
      return res.status(200).json(uniqueMovies(data.results).slice(0, 10));
    }

    if (random) {
      res.setHeader("Cache-Control", "no-store");
      const page = Math.floor(Math.random() * 15) + 1;
      const data = await tmdb(`/movie/top_rated?page=${page}`);
      const pool = uniqueMovies(data.results);
      return res.status(200).json(pool[Math.floor(Math.random() * pool.length)] || null);
    }

    if (personId) {
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      const [person, credits] = await Promise.all([
        tmdb(`/person/${personId}`),
        tmdb(`/person/${personId}/movie_credits`)
      ]);
      const directed = uniqueMovies((credits.crew || []).filter(item => item.job === "Director")).slice(0, 18);
      return res.status(200).json({ type: "director", person, movies: directed });
    }

    if (genreId) {
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      const [genres, movies] = await Promise.all([
        tmdb(`/genre/movie/list`),
        tmdb(`/discover/movie?with_genres=${encodeURIComponent(genreId)}&sort_by=vote_count.desc&include_adult=false`)
      ]);
      const genre = (genres.genres || []).find(item => item.id === Number(genreId)) || { id: Number(genreId), name: "Genre" };
      return res.status(200).json({ type: "genre", genre, movies: uniqueMovies(movies.results).slice(0, 18) });
    }

    if (!id) return res.status(400).json({ error: "Provide query, id, random, personId, or genreId" });

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    const [details, credits, similar, recommendations, keywords] = await Promise.all([
      tmdb(`/movie/${id}`),
      tmdb(`/movie/${id}/credits`),
      tmdb(`/movie/${id}/similar`),
      tmdb(`/movie/${id}/recommendations`),
      tmdb(`/movie/${id}/keywords`)
    ]);

    const director = (credits.crew || []).find(person => person.job === "Director") || null;
    const related = uniqueMovies([...(recommendations.results || []), ...(similar.results || [])], id).slice(0, 14);

    return res.status(200).json({
      type: "movie",
      movie: details,
      director,
      genres: details.genres || [],
      keywords: (keywords.keywords || []).slice(0, 10),
      related
    });
  } catch (error) {
    console.error("CineMap request failed", error);
    return res.status(500).json({ error: "CineMap request failed", details: error.message });
  }
}
