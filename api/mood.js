import OpenAI from "openai";

export default async function handler(req, res) {
  const { moodText, tags } = req.query;

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ 
      error: "Missing OPENAI_API_KEY in environment variables." 
    });
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  try {
    const prompt = `
      Based on the following mood and descriptive tags:
      Mood: "${moodText}"
      Tags: "${tags}"

      Suggest 6 popular, widely recognized movies and 6 books that match this mood and these tags.
      Prioritize titles that are known and generally well-rated, but match the emotional tone.
      Return only valid JSON, with no explanations, in this format:
      {
        "movies": ["Movie Title 1","Movie Title 2",...],
        "books": ["Book Title 1","Book Title 2",...]
      }
    `;

    const response = await client.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
    });

    const text = response.choices[0].message.content.trim();

    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      console.error("Invalid JSON from ChatGPT:", text);
      return res.status(500).json({ error: "Invalid AI response", raw: text });
    }

    res.status(200).json(data);
  } catch (error) {
    console.error("OpenAI API Error:", error);
    res.status(500).json({ 
      error: "Failed to generate recommendations", 
      details: error.message 
    });
  }
}
