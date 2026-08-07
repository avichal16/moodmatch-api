const TMDB_KEY = process.env.TMDB_API_KEY;

const MOVEMENTS = [
  "French New Wave","Italian Neorealism","German Expressionism","New Hollywood","Dogme 95","Slow Cinema","Iranian New Wave","Korean New Wave","Hong Kong New Wave","Japanese New Wave","British New Wave","Czechoslovak New Wave","Parallel Cinema","Cinema Novo","Taiwan New Wave","American Independent Cinema"
];

const COUNTRIES = [
  ["United States","US"],["United Kingdom","GB"],["France","FR"],["Italy","IT"],["Germany","DE"],["Japan","JP"],["South Korea","KR"],["India","IN"],["China","CN"],["Hong Kong","HK"],["Iran","IR"],["Spain","ES"],["Mexico","MX"],["Brazil","BR"],["Argentina","AR"],["Sweden","SE"],["Denmark","DK"],["Australia","AU"],["Canada","CA"],["Taiwan","TW"]
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (["https://mymoodmatch.com", "https://www.mymoodmatch.com"].includes(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    return protocol === "https:" && (hostname === "moodmatch-frontend.vercel.app" || (hostname.endsWith(".vercel.app") && hostname.includes("moodmatch-frontend")));
  } catch { return false; }
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

function decadeFromQuery(query) {
  const m = query.match(/\b(19|20)\d0s\b/i) || query.match(/\b(19|20)\d0\b/);
  if (!m) return null;
  const year = Number(m[0].replace(/s$/i, ""));
  return Number.isFinite(year) ? year : null;
}

async function searchEverything(query) {
  const [multi, genres, keywords, companies] = await Promise.all([
    tmdb(`/search/multi?query=${encodeURIComponent(query)}&include_adult=false`),
    tmdb(`/genre/movie/list`),
    tmdb(`/search/keyword?query=${encodeURIComponent(query)}`),
    tmdb(`/search/company?query=${encodeURIComponent(query)}`)
  ]);
  const q = query.toLowerCase().trim();
  const genreResults = (genres.genres || []).filter(g => g.name.toLowerCase().includes(q)).map(g => ({ type: "genre", id: g.id, name: g.name, subtitle: "Genre" }));
  const movementResults = MOVEMENTS.filter(name => name.toLowerCase().includes(q) || q.includes(name.toLowerCase())).map(name => ({ type: "movement", id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, subtitle: "Cinema movement" }));
  const countryResults = COUNTRIES.filter(([name]) => name.toLowerCase().includes(q) || q.includes(name.toLowerCase())).map(([name, code]) => ({ type: "country", id: code, name, subtitle: "National cinema" }));
  const decade = decadeFromQuery(query);
  const decadeResults = decade ? [{ type: "decade", id: String(decade), name: `${decade}s`, subtitle: "Cinema by decade" }] : [];
  const companyResults = (companies.results || []).slice(0, 4).map(c => ({ type: "company", id: c.id, name: c.name, subtitle: "Studio / production company", image: c.logo_path }));
  const entityResults = (multi.results || []).filter(item => item.media_type === "movie" || item.media_type === "person").slice(0, 10).map(item => item.media_type === "movie"
    ? { type: "movie", id: item.id, name: item.title, subtitle: item.release_date?.slice(0, 4) || "Movie", image: item.poster_path }
    : { type: "person", id: item.id, name: item.name, subtitle: item.known_for_department || "Filmmaker / performer", image: item.profile_path });
  const styleResults = (keywords.results || []).slice(0, 6).map(k => ({ type: "style", id: k.id, name: k.name, subtitle: "Theme / style / subject" }));
  return [...movementResults, ...genreResults, ...countryResults, ...decadeResults, ...entityResults, ...companyResults, ...styleResults].slice(0, 20);
}

async function keywordBranch(name) {
  const keywordSearch = await tmdb(`/search/keyword?query=${encodeURIComponent(name)}`);
  const exact = (keywordSearch.results || []).find(k => k.name.toLowerCase() === name.toLowerCase()) || keywordSearch.results?.[0];
  if (!exact) return { keyword: { id: name, name }, movies: [] };
  const movies = await tmdb(`/discover/movie?with_keywords=${exact.id}&sort_by=vote_count.desc&include_adult=false`);
  return { keyword: exact, movies: uniqueMovies(movies.results).slice(0, 20) };
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { query, id, random, personId, genreId, keywordId, movement, country, decade, companyId } = req.query;

    if (query) {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
      return res.status(200).json(await searchEverything(query));
    }

    if (random) {
      res.setHeader("Cache-Control", "no-store");
      const page = Math.floor(Math.random() * 15) + 1;
      const data = await tmdb(`/movie/top_rated?page=${page}`);
      const pool = uniqueMovies(data.results);
      return res.status(200).json(pool[Math.floor(Math.random() * pool.length)] || null);
    }

    if (personId) {
      const [person, credits] = await Promise.all([tmdb(`/person/${personId}`), tmdb(`/person/${personId}/movie_credits`)]);
      const directed = uniqueMovies((credits.crew || []).filter(item => item.job === "Director"));
      const crew = uniqueMovies(credits.crew || []);
      const acted = uniqueMovies(credits.cast || []);
      const department = person.known_for_department || "Cinema";
      const role = department === "Acting" ? "actor" : department === "Directing" ? "director" : "person";
      const movies = uniqueMovies([...directed, ...crew, ...acted]).slice(0, 20);
      return res.status(200).json({ type: role, person, movies, directed: directed.slice(0, 12), acted: acted.slice(0, 12), department });
    }

    if (genreId) {
      const [genres, movies] = await Promise.all([tmdb(`/genre/movie/list`), tmdb(`/discover/movie?with_genres=${encodeURIComponent(genreId)}&sort_by=vote_count.desc&include_adult=false`)]);
      const genre = (genres.genres || []).find(item => item.id === Number(genreId)) || { id: Number(genreId), name: "Genre" };
      return res.status(200).json({ type: "genre", genre, movies: uniqueMovies(movies.results).slice(0, 20) });
    }

    if (keywordId) {
      const [keyword, movies] = await Promise.all([tmdb(`/keyword/${keywordId}`), tmdb(`/discover/movie?with_keywords=${encodeURIComponent(keywordId)}&sort_by=vote_count.desc&include_adult=false`)]);
      return res.status(200).json({ type: "style", style: keyword, movies: uniqueMovies(movies.results).slice(0, 20) });
    }

    if (movement) {
      const branch = await keywordBranch(movement);
      return res.status(200).json({ type: "movement", movement: { id: movement.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: movement }, movies: branch.movies });
    }

    if (country) {
      const label = COUNTRIES.find(([, code]) => code === country)?.[0] || country;
      const movies = await tmdb(`/discover/movie?with_origin_country=${encodeURIComponent(country)}&sort_by=vote_count.desc&include_adult=false`);
      return res.status(200).json({ type: "country", country: { id: country, name: label }, movies: uniqueMovies(movies.results).slice(0, 20) });
    }

    if (decade) {
      const start = Number(decade);
      const movies = await tmdb(`/discover/movie?primary_release_date.gte=${start}-01-01&primary_release_date.lte=${start + 9}-12-31&sort_by=vote_count.desc&include_adult=false`);
      return res.status(200).json({ type: "decade", decade: { id: String(start), name: `${start}s` }, movies: uniqueMovies(movies.results).slice(0, 20) });
    }

    if (companyId) {
      const [company, movies] = await Promise.all([tmdb(`/company/${companyId}`), tmdb(`/discover/movie?with_companies=${encodeURIComponent(companyId)}&sort_by=vote_count.desc&include_adult=false`)]);
      return res.status(200).json({ type: "company", company, movies: uniqueMovies(movies.results).slice(0, 20) });
    }

    if (!id) return res.status(400).json({ error: "Provide a CineMap entity" });

    const [details, credits, similar, recommendations, keywords] = await Promise.all([
      tmdb(`/movie/${id}`), tmdb(`/movie/${id}/credits`), tmdb(`/movie/${id}/similar`), tmdb(`/movie/${id}/recommendations`), tmdb(`/movie/${id}/keywords`)
    ]);
    const director = (credits.crew || []).find(person => person.job === "Director") || null;
    const cast = (credits.cast || []).slice(0, 5);
    const notableCrew = (credits.crew || []).filter(p => ["Director of Photography","Original Music Composer","Screenplay","Writer"].includes(p.job)).filter((p, i, a) => a.findIndex(x => x.id === p.id && x.job === p.job) === i).slice(0, 6);
    const styles = (keywords.keywords || []).slice(0, 6);
    const related = uniqueMovies([...(recommendations.results || []), ...(similar.results || [])], id).slice(0, 14);
    return res.status(200).json({ type: "movie", movie: details, director, cast, crew: notableCrew, genres: details.genres || [], styles, keywords: styles, related, companies: (details.production_companies || []).slice(0, 4), countries: (details.production_countries || []).slice(0, 3) });
  } catch (error) {
    console.error("CineMap request failed", error);
    return res.status(500).json({ error: "CineMap request failed", details: error.message });
  }
}