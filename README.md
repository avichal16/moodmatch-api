# MoodMatch API (Vercel)

This backend powers MoodMatch with Gemini-generated recommendations across movies, TV shows, and books, then enriches them with TMDB, Google Books, and Spotify.

## Environment variables

Add these in Vercel under **Project Settings → Environment Variables**:

- `GEMINI_API_KEY`
- `TMDB_API_KEY`
- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `GEMINI_MODEL` (optional; defaults to `gemini-2.5-flash`)

`OPENAI_API_KEY` is no longer used.

## Deploy

1. Import this repository into Vercel or connect the existing Vercel project.
2. Add the environment variables above for Production.
3. Redeploy the latest commit.
4. Test the endpoint:

```text
https://<your-project>.vercel.app/api/mood?mood=I%20want%20something%20uplifting
```

A successful response contains `movies`, `tv`, `books`, and `spotify`.
