require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
 
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
 
if (!process.env.GEMINI_API_KEY) {
  console.error("\nMissing GEMINI_API_KEY. Create a .env file and add your key (see README).\n");
  process.exit(1);
}
 
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
// If this model name ever stops working, open Google AI Studio, pick a current
// Flash model and put its name in .env as GEMINI_MODEL.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
 
// In-memory session store (data is lost when the server restarts)
const sessions = new Map();
 
const SYSTEM_PROMPT = `You are an expert, friendly-but-rigorous technical interviewer conducting a live interview.
You adapt to the candidate's target role and seniority. You ask ONE question at a time.
Adaptive rules:
- If the previous answer was strong (score >= 8), make the next question harder or go deeper.
- If it was weak (score <= 4), ask a simpler or clarifying question on the same topic, or move to a fundamentals topic.
- If it was average, probe a follow-up on a gap in their answer.
- Never repeat a question already asked. Cover a variety of topics relevant to the role.
- Mix conceptual, practical/problem-solving, and (for relevant roles) short coding or system-design questions.
You must ALWAYS respond with a single valid JSON object only. No markdown fences, no extra text.`;
 
function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("The AI did not return valid JSON. Please try again.");
  return JSON.parse(cleaned.slice(start, end + 1));
}
 
// Optional backup models, tried if the main one is busy (comma-separated in .env)
const FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.5-flash,gemini-3.5-flash-lite")
  .split(",").map((s) => s.trim()).filter(Boolean);
 
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isBusy = (err) => [429, 500, 503, 504].includes(err && (err.status || err.code));
 
// Call one model, retrying a few times when Google says "high demand"
async function generateWithRetry(model, contents, maxTokens) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          maxOutputTokens: maxTokens,
          responseMimeType: "application/json",
        },
      });
    } catch (err) {
      lastErr = err;
      if (!isBusy(err)) throw err;
      console.warn(`${model} busy (attempt ${attempt + 1}/3), retrying...`);
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}
 
// Send the conversation so far + a new message to Gemini and get JSON back
async function askModel(session, userText, maxTokens = 4096) {
  session.messages.push({ role: "user", parts: [{ text: userText }] });
  try {
    let resp;
    let lastErr;
    for (const model of [MODEL, ...FALLBACKS]) {
      try {
        resp = await generateWithRetry(model, session.messages, maxTokens);
        break;
      } catch (err) {
        lastErr = err;
        // Busy -> try the next model. A missing model (404) -> also try the next one.
        if (!isBusy(err) && (err.status || err.code) !== 404) throw err;
        console.warn(`Switching away from ${model}...`);
      }
    }
    if (!resp) throw lastErr;
 
    const text = resp.text || "";
    const parsed = extractJson(text);
    session.messages.push({ role: "model", parts: [{ text }] });
    return parsed;
  } catch (e) {
    session.messages.pop(); // remove the failed turn so the user can retry cleanly
    throw e;
  }
}
 
function friendlyError(err) {
  const status = err && (err.status || err.code);
  const msg = (err && err.message) || "Something went wrong";
  if (status === 503) return "Gemini is very busy right now. Please wait a minute and click again.";
  if (status === 429) return "Gemini rate limit reached. Please wait a minute and try again.";
  if (status === 400 && /API key/i.test(msg)) return "Your Gemini API key looks invalid. Check the .env file.";
  if (status === 403) return "Gemini rejected the request (403). Check that your API key is correct and enabled.";
  if (status === 404) return "Model not found. Set a current model name in GEMINI_MODEL in your .env file.";
  return msg;
}
 
// Start an interview
app.post("/api/interview/start", async (req, res) => {
  try {
    const { name = "Candidate", role, level = "Mid-level", numQuestions = 6, focus = "" } = req.body;
    if (!role) return res.status(400).json({ error: "role is required" });
    const total = Math.min(Math.max(parseInt(numQuestions, 10) || 6, 3), 15);
 
    const id = crypto.randomUUID();
    const session = {
      id, name, role, level, focus, total,
      asked: 0, history: [], messages: [], done: false,
    };
 
    const first = await askModel(
      session,
      `Start the interview. Candidate: ${name}. Target role: ${role}. Seniority: ${level}. ${focus ? "Focus areas: " + focus + "." : ""}
Total questions planned: ${total}.
Respond with JSON: {"greeting": "short warm 1-2 sentence welcome", "question": "first question", "topic": "short topic label", "difficulty": "easy|medium|hard"}`
    );
 
    sessions.set(id, session);
    session.asked = 1;
    session.current = { question: first.question, topic: first.topic, difficulty: first.difficulty };
    res.json({
      sessionId: id,
      greeting: first.greeting,
      question: first.question,
      topic: first.topic,
      difficulty: first.difficulty,
      index: 1,
      total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: friendlyError(err) });
  }
});
 
// Submit an answer: evaluate it and get the next adaptive question
app.post("/api/interview/answer", async (req, res) => {
  try {
    const { sessionId, answer } = req.body;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.done) return res.status(400).json({ error: "Interview already finished" });
    if (!answer || !answer.trim()) return res.status(400).json({ error: "Answer is empty" });
 
    const isLast = session.asked >= session.total;
    const prompt = `Candidate's answer to question ${session.asked}/${session.total}:
"""${answer.trim()}"""
 
Evaluate the answer strictly but fairly. ${
      isLast
        ? 'This was the final question, so set "next_question" to null.'
        : "Then ask the next question, adapted per the adaptive rules."
    }
Respond with JSON:
{"score": <integer 0-10>, "feedback": "2-3 sentences: what was good and what was missing", "ideal_answer_hint": "1-2 sentences with key points a strong answer includes", "strengths": ["..."], "gaps": ["..."], "next_question": ${
      isLast ? "null" : '"..."'
    }, "topic": "topic label of next question", "difficulty": "easy|medium|hard"}`;
 
    const result = await askModel(session, prompt);
 
    session.history.push({
      question: session.current.question,
      topic: session.current.topic,
      difficulty: session.current.difficulty,
      answer: answer.trim(),
      score: result.score,
      feedback: result.feedback,
      strengths: result.strengths || [],
      gaps: result.gaps || [],
    });
 
    const evaluation = {
      score: result.score,
      feedback: result.feedback,
      hint: result.ideal_answer_hint,
      strengths: result.strengths,
      gaps: result.gaps,
    };
 
    if (isLast || !result.next_question) {
      session.done = true;
      return res.json({ evaluation, done: true });
    }
 
    session.asked += 1;
    session.current = { question: result.next_question, topic: result.topic, difficulty: result.difficulty };
    res.json({
      evaluation,
      done: false,
      question: result.next_question,
      topic: result.topic,
      difficulty: result.difficulty,
      index: session.asked,
      total: session.total,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: friendlyError(err) });
  }
});
 
// End early and/or get the final report
app.post("/api/interview/report", async (req, res) => {
  try {
    const { sessionId } = req.body;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: "Session not found" });
 
    if (session.history.length === 0) {
      session.done = true;
      return res.json({ report: null, history: [], message: "No answers were submitted." });
    }
 
    const avg = session.history.reduce((s, h) => s + (Number(h.score) || 0), 0) / session.history.length;
 
    const report = await askModel(
      session,
      `The interview is over. Produce the final assessment for the ${session.level} ${session.role} role.
Respond with JSON:
{"overall_score": <number 0-100>, "recommendation": "Strong Hire|Hire|Lean Hire|Lean No Hire|No Hire", "summary": "3-4 sentence overall summary", "strengths": ["..."], "areas_to_improve": ["..."], "topic_scores": [{"topic": "...", "score": <0-10>}], "study_plan": ["3-5 concrete next steps"]}`
    );
 
    session.done = true;
    res.json({ report, averageScore: Math.round(avg * 10) / 10, history: session.history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: friendlyError(err) });
  }
});
 
const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`AI Interviewer running at http://localhost:${PORT}`);
  });
}

module.exports = app;
 
