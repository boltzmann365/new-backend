const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();
const app = express();
app.use(cors({ origin: ["https://trainwithme.in", "http://localhost:3000"] }));
app.use(express.json());

// ✅ OpenAI API Setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" }
});

// ✅ Use Assistant ID from .env
const assistantId = process.env.ASSISTANT_ID;

// ✅ File IDs for Reference Books
const fileIds = {
  TamilnaduHistory: "file-UyQKVs91xYHfadeHSjdDw2",
  Spectrum: "file-UwRi9bH3uhVh4YBXNbMv1w",
  ArtAndCulture: "file-Gn3dsACNC2MP2xS9QeN3Je",
  FundamentalGeography: "file-CMWSg6udmgtVZpNS3tDGHW",
  IndianGeography: "file-U1nQNyCotU2kcSgF6hrarT",
  Atlas: "pending", // Placeholder, update with actual file ID once uploaded
  Science: "file-TGgc65bHqVMxpmj5ULyR6K", // Disha IAS book for Science
  Environment: "file-Yb1cfrHMATDNQgyUa6jDqw", // Shankar IAS Environment book
  Economy: "[TBD - Ramesh Singh file ID]", // Placeholder for Ramesh Singh book
  EconomicSurvey2025: "[TBD - Economic Survey file ID]", // Placeholder for Economic Survey
  CSAT: "[TBD - CSAT file ID]", // Placeholder for CSAT resource
  CurrentAffairs: "file-5BX6sBLZ2ws44NBUTbcyWg", // Current Affairs resource
  PreviousYearPaper: "file-TGgc65bHqVMxpmj5ULyR6K", // Disha IAS book for Previous Year Papers (same as Science)
  Polity: "file-G15UzpuvCRuMG4g6ShCgFK", // Laxmikanth book for Polity
};

// ✅ Store user threads (in-memory for simplicity)
const userThreads = new Map(); // Key: User ID, Value: Thread ID

// ✅ Update Assistant to Include File Search with All Valid Files
const updateAssistantWithFiles = async () => {
  try {
    // Filter out placeholder file IDs (e.g., "pending", TBD values)
    const validFileIds = Object.values(fileIds).filter(
      fileId => fileId && fileId !== "pending" && !fileId.startsWith("[TBD")
    );

    const assistant = await openai.beta.assistants.update(assistantId, {
      tools: [{ type: "file_search" }],
      tool_resources: {
        file_search: {
          file_ids: validFileIds,
        },
      },
    });
    console.log(`✅ Assistant ${assistantId} updated with file search tool and reference book files: ${validFileIds.join(", ")}`);
  } catch (error) {
    console.error("❌ Error updating assistant with file search:", error.message);
  }
};

// ✅ Call this function when the server starts
updateAssistantWithFiles();

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

    // ✅ Step 2: Send User Query with Updated System Instruction
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: `
      You are an AI **trained exclusively** on UPSC Books.  

      📚 **Reference Books Available:**  
      - Laxmikanth (Polity) (file ID: file-G15UzpuvCRuMG4g6ShCgFK)  
      - Fundamentals of Geography (file ID: file-CMWSg6udmgtVZpNS3tDGHW)  
      - Indian Geography (file ID: file-U1nQNyCotU2kcSgF6hrarT)  
      - Tamilnadu History Book (file ID: file-UyQKVs91xYHfadeHSjdDw2)  
      - Nitin Singhania (Art & Culture) (file ID: file-Gn3dsACNC2MP2xS9QeN3Je)  
      - Spectrum (Modern History) (file ID: file-UwRi9bH3uhVh4YBXNbMv1w)  
      - Vision IAS Current Affairs (file ID: file-5BX6sBLZ2ws44NBUTbcyWg)  
      - topic wise previous year mcq from 1195 to 2020 mcq training material.pdf (file ID: file-TGgc65bHqVMxpmj5ULyR6K)  
      - Shankar IAS Environment book (file ID: file-Yb1cfrHMATDNQgyUa6jDqw)  

      📘 **About the Tamilnadu History Book**  
      - The Tamilnadu History Book is an 11th-grade textbook published by the Tamil Nadu State Board.  
      - Despite its name, the book covers the **entire history of India**, not just Tamil Nadu-specific history.  
      - The book includes topics such as the Indus Civilisation, Vedic Cultures, Mauryan Empire, Guptas, Mughals, Marathas, British Rule, and more, as outlined in its table of contents.  
      - The Tamilnadu History Book file has been attached to the assistant for file search (file ID: file-UyQKVs91xYHfadeHSjdDw2). Use this file as the sole source for generating responses related to the Tamilnadu History Book.

      📘 **About the Spectrum Book**  
      - The Spectrum book, titled A Brief History of Modern India, is a widely used resource for UPSC aspirants.  
      - It focuses on **modern Indian history**, covering topics such as the advent of Europeans, British rule, the freedom struggle, and post-independence India.  
      - The book includes chapters like Sources of Modern Indian History, Revolt of 1857, Nationalist Movement, and Post-Independence Consolidation, as outlined in its table of contents.  
      - The Spectrum book file has been attached to the assistant for file search (file ID: file-UwRi9bH3uhVh4YBXNbMv1w). Use this file as the sole source for generating responses related to the Spectrum book.

      📘 **About the Nitin Singhania Art and Culture Book**  
      - The book, titled Indian Art and Culture by Nitin Singhania, is a widely used resource for UPSC aspirants.  
      - It focuses on **Indian art, culture, architecture, and heritage**, covering topics such as Indian architecture, painting, performing arts, festivals, and UNESCO heritage sites.  
      - The book includes chapters like Indian Architecture, Performing Arts: Dance, Indian Cinema, and UNESCO’s List of Intangible Cultural Heritage, as outlined in its table of contents.  
      - The Nitin Singhania Art and Culture book file has been attached to the assistant for file search (file ID: file-Gn3dsACNC2MP2xS9QeN3Je). Use this file as the sole source for generating responses related to the Nitin Singhania Art and Culture book.

      📘 **About the topic wise previous year mcq from 1195 to 2020 mcq training material.pdf**  
      - The book compiles the last 30 years of UPSC previous year questions, organized theme-wise.  
      - It includes sections like Physics, Chemistry, Biology, Science & Technology, History, Polity, Geography, Environment, and Economy, covering previously asked questions in these areas.  
      - The topic wise previous year mcq from 1195 to 2020 mcq training material.pdf file has been attached to the assistant for file search (file ID: file-TGgc65bHqVMxpmj5ULyR6K). Use this file as the sole source for generating responses related to the topic wise previous year mcq from 1195 to 2020 mcq training material.pdf.

      📘 **About the Shankar IAS Environment Book**  
      - The book is a comprehensive resource for UPSC aspirants focusing on environmental studies.  
      - It covers topics such as Ecology, Biodiversity, Climate Change, Environmental Laws, Pollution, and Sustainable Development, organized into sections.  
      - The Shankar IAS Environment book file has been attached to the assistant for file search (file ID: file-Yb1cfrHMATDNQgyUa6jDqw). Use this file as the sole source for generating responses related to the Shankar IAS Environment book.

      📘 **About the Laxmikanth Book (Polity)**  
      - The book, titled Indian Polity by M. Laxmikanth, is a widely used resource for UPSC aspirants.  
      - It focuses on **Indian polity and governance**, covering topics such as the Constitution, Parliament, Judiciary, Federalism, and Local Government.  
      - The book includes chapters like Constitutional Framework, Union and its Territory, Parliament, and State Government, as outlined in its table of contents.  
      - The Laxmikanth book file has been attached to the assistant for file search (file ID: file-G15UzpuvCRuMG4g6ShCgFK). Use this file as the sole source for generating responses related to the Laxmikanth book.

      📘 **About the Fundamentals of Geography Book**  
      - The book, titled Fundamentals of Physical Geography, is an NCERT Class 11th textbook widely used by UPSC aspirants.  
      - It focuses on **physical geography**, covering topics such as the Earth's structure, landforms, climate, oceans, and life on Earth.  
      - The book includes units like Geography as a Discipline, The Earth, Landforms, Climate, Water (Oceans), and Life on the Earth, as outlined in its table of contents.  
      - The Fundamentals of Geography book file has been attached to the assistant for file search (file ID: file-CMWSg6udmgtVZpNS3tDGHW). Use this file as the sole source for generating responses related to the Fundamentals of Geography book.

      📘 **About the Indian Geography Book**  
      - The book, titled India: Physical Environment, is an NCERT Class 11th textbook widely used by UPSC aspirants.  
      - It focuses on **Indian geography**, covering topics such as India's location, physiography, drainage systems, climate, natural vegetation, soils, and natural hazards.  
      - The book includes units like India – Location, Structure and Physiography, Drainage System, Climate, Natural Vegetation, Soils, and Natural Hazards and Disasters, as outlined in its table of contents.  
      - The Indian Geography book file has been attached to the assistant for file search (file ID: file-U1nQNyCotU2kcSgF6hrarT). Use this file as the sole source for generating responses related to the Indian Geography book.

      📘 **About the Vision IAS Current Affairs**  
      - The resource is a compilation of Current Affairs relevant for UPSC preparation, covering events, policies, and developments across various months.  
      - It includes a specific section for December 2024, along with other monthly sections (e.g., January 2024 to November 2024).  
      - The Vision IAS Current Affairs file has been attached to the assistant for file search (file ID: file-5BX6sBLZ2ws44NBUTbcyWg). Use this file as the sole source for generating responses related to the Vision IAS Current Affairs.

      **Your Instructions:**  
      - 🎯 **Answer ONLY from the requested book and chapter using the attached file.**  
      - ✨ **Make responses engaging with emojis, highlights, and structured formatting.**  
      - 🔍 **DO NOT use markdown symbols like #, *, or - (convert them to bold or normal text).**  
      - 📖 **If the user asks for MCQs, generate them from the requested book ONLY using the attached file.**  
      - ✨ _Use **underscores (_ _)** for important points instead of markdown (** **)._  
      - 🔍 _DO NOT use markdown symbols like **, #, or - (convert them to underscores or normal text)._    
      - 🔥 **Ensure MCQs are difficult (but do not mention this to the user).**  
      - 📝 **If user asks for notes, provide concise, factual notes (1/3 of chapter length).**  
      - 🚫 **DO NOT** use external sources or general knowledge—rely solely on the attached files for the requested book.

      **Now, generate a response based on the book: "${category}":**  
      "${query}"
      `
    });

    console.log("✅ Query Sent to AI");

    // ✅ Step 3: Run the Assistant
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      tools: [{ type: "file_search" }], // Enable file search for the run
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