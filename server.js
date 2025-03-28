const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();
const app = express();
app.use(cors({ origin: "https://www.trainwithme.in" }));
app.use(express.json());

// ✅ OpenAI API Setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" }
});

// ✅ Use Assistant ID from .env
const assistantId = process.env.ASSISTANT_ID;

// ✅ Store user threads (in-memory for simplicity)
const userThreads = new Map(); // Key: User ID, Value: Thread ID

app.post("/ask", async (req, res) => {
  try {
    const { query, category, userId } = req.body;
    console.log(`🔹 Received Query from User ${userId}: ${query}`);

    // ✅ Step 1: Check if the user already has a thread
    let threadId = userThreads.get(userId);

    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      userThreads.set(userId, threadId);
      console.log(`✅ New Thread Created for User ${userId}: ${threadId}`);
    } else {
      console.log(`✅ Using Existing Thread for User ${userId}: ${threadId}`);
    }

    // ✅ Step 2: Send User Query
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: `
      You are an AI **trained exclusively** on UPSC Books.  

      📚 **Reference Books Available:**  
      - Laxmikanth (Polity)  
      - Fundamentals of Geography  
      - Indian Geography  
      - Tamil Nadu History Book  
      - Nitin Singhania (Art & Culture)  
      - Spectrum (Modern History)  
      - Vision IAS Current Affairs  
      - Previous Year Question Papers  

      **Your Instructions:**  
      - 🎯 **Answer ONLY from the requested book and chapter.**  
      - ✨ **Make responses engaging with emojis, highlights, and structured formatting.**  
      - 🔍 **DO NOT use markdown symbols like #, *, or - (convert them to bold or normal text).**  
      - 📖 **If the user asks for MCQs, generate them from the requested book ONLY.**
      - ✨ _Use **underscores (_ _)** for important points instead of markdown (** **)._  
      - 🔍 _DO NOT use markdown symbols like **, #, or - (convert them to underscores or normal text)._    
      - 🔥 **Ensure MCQs are difficult (but do not mention this to the user).**  
      - 📝 **If user asks for notes, provide concise, factual notes (1/3 of chapter length).**  

      **Now, generate a response based on the book: "${category}":**  
      "${query}"
      `
    });

    console.log("✅ Query Sent to AI");

    // ✅ Step 3: Run the Assistant
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId
    });

    if (!run || !run.id) {
      throw new Error("❌ Failed to create AI Run. Check OpenAI request.");
    }
    console.log(`🔄 AI is processing query (Run ID: ${run.id})`);

    // ✅ Step 4: Wait for AI to Complete Processing
    let responseText = "";
    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      console.log(`⏳ AI Status: ${runStatus.status}`);

      if (runStatus.status === "completed") {
        const messages = await openai.beta.threads.messages.list(threadId);

        // ✅ Step 5: Extract ONLY the latest response (to prevent duplicate questions)
        const latestMessage = messages.data.find(m => m.role === "assistant");
        responseText = latestMessage?.content[0]?.text?.value || "No response available.";

        // ✅ Fix Formatting Issues
        responseText = responseText
          .replace(/^Te\b/, "The")
          .replace(/\bTe\b/g, "The")
          .replace(/\bundefined\b/g, "")
          .replace(/\n{2,}/g, "\n")
          .trim();

        // ✅ Prevent Duplicate MCQs
        if (responseText.includes(query)) {
          responseText = responseText.replace(query, "").trim();
        }

        break;
      }

      if (runStatus.status === "failed") {
        throw new Error("❌ AI request failed.");
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // ✅ Step 6: Send AI Response to Frontend
    res.json({ answer: responseText });
    console.log("✅ AI Response Sent!");

  } catch (error) {
    console.error("❌ Error from OpenAI:", error);
    res.status(500).json({ error: "AI service error", details: error.message });
  }
});

// ✅ Start Express Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Backend running on port ${PORT}`));