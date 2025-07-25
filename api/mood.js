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
      Analyze the following description and combine it with these optional tags: ${tags || "None"}.
      Extract 3-5 mood tags and 1-2 genres (Drama, Action, Comedy, etc.) most relevant for recommendations.
      Return only valid JSON in this format: {"tags":["tag1","tag2"],"genres":["genre1","genre2"]}

      Mood description: "${moodText}"
    `;

    const response = await client.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const text = response.choices[0].message.content.trim();
    const data = JSON.parse(text);

    res.status(200).json(data);
  } catch (error) {
    console.error("OpenAI API Error:", error);
    res.status(500).json({ 
      error: "Failed to analyze mood", 
      details: error.message 
    });
  }
}
