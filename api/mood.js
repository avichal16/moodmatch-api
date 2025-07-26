import OpenAI from "openai";

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const { moodText, tags } = req.query;

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const prompt = `
      Suggest 6 popular movies, 6 TV series, and 6 books based on:
      Mood: "${moodText}"
      Tags: "${tags}"

      Return ONLY valid JSON, no explanations, in this format:
      {
        "movies": ["Movie1",...],
        "tv": ["Series1",...],
        "books": ["Book1",...]
      }
    `;

    const response = await client.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    });

    const text = response.choices[0].message.content.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON found in AI response");
    const json = match[0];
    const data = JSON.parse(json);

    res.status(200).json(data);
  } catch (error) {
    console.error("OpenAI API Error:", error);
    res.status(500).json({ error: "Failed to generate recommendations", details: error.message });
  }
}
