# MoodMatch API (Vercel)
This backend powers the MoodMatch app by analyzing mood text via ChatGPT.

## Deploy Steps
1. Upload this folder as a GitHub repo (name: moodmatch-api).
2. On Vercel, import the repo as a new project.
3. Add your OpenAI API key:
   - Project Settings → Environment Variables → Add:
     - Key: OPENAI_API_KEY
     - Value: sk-...
4. Click Redeploy.
5. Test:
   https://<your-project>.vercel.app/api/mood?moodText=I%20felt%20happy
