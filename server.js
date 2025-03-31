const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();
const app = express();
app.use(cors({ origin: ["https://trainwithme.in", "http://localhost:3000"] }));
app.use(express.json());

// OpenAI API Setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" }
});

// Use Assistant ID from .env
const assistantId = process.env.ASSISTANT_ID;

// File IDs for Reference Books
const fileIds = {
  TamilnaduHistory: "file-UyQKVs91xYHfadeHSjdDw2",
  Spectrum: "file-UwRi9bH3uhVh4YBXNbMv1w",
  ArtAndCulture: "file-Gn3dsACNC2MP2xS9QeN3Je",
  FundamentalGeography: "file-CMWSg6udmgtVZpNS3tDGHW",
  IndianGeography: "file-U1nQNyCotU2kcSgF6hrarT",
  Atlas: "pending",
  Science: "file-TGgc65bHqVMxpmj5ULyR6K",
  Environment: "file-Yb1cfrHMATDNQgyUa6jDqw",
  Economy: "file-TJ5Djap1uv4fZeyM5c6sKU",
  EconomicSurvey2025: "[TBD - Economic Survey file ID]",
  CSAT: "file-TGgc65bHqVMxpmj5ULyR6K",
  CurrentAffairs: "file-5BX6sBLZ2ws44NBUTbcyWg",
  PreviousYearPaper: "file-TGgc65bHqVMxpmj5ULyR6K",
  Polity: "file-G15UzpuvCRuMG4g6ShCgFK",
};

// Store user threads (in-memory for simplicity)
const userThreads = new Map();

// Update Assistant to Include File Search with Vector Store
const updateAssistantWithFiles = async () => {
  try {
    const validFileIds = Object.values(fileIds).filter(
      fileId => fileId && fileId !== "pending" && !fileId.startsWith("[TBD")
    );

    for (const fileId of validFileIds) {
      try {
        const file = await openai.files.retrieve(fileId);
        console.log(`File ${fileId} verified: ${file.filename}`);
      } catch (error) {
        console.error(`Error verifying file ${fileId}:`, error.message);
        const index = validFileIds.indexOf(fileId);
        if (index !== -1) {
          validFileIds.splice(index, 1);
        }
      }
    }

    const vectorStore = await openai.beta.vectorStores.create({
      name: "UPSC Books Vector Store",
      file_ids: validFileIds
    });

    const assistant = await openai.beta.assistants.update(assistantId, {
      tools: [{ type: "file_search" }],
      tool_resources: {
        file_search: {
          vector_store_ids: [vectorStore.id]
        }
      }
    });
    console.log(`✅ Assistant ${assistantId} updated with file search tool and vector store ID: ${vectorStore.id}`);
  } catch (error) {
    console.error("❌ Error updating assistant with file search:", error.message);
  }
};

// Call this function when the server starts
updateAssistantWithFiles();

app.post("/ask", async (req, res) => {
  try {
    const { query, category, userId } = req.body;
    console.log(`🔹 Received Query from User ${userId}: ${query}`);

    let threadId = userThreads.get(userId);
    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      userThreads.set(userId, threadId);
      console.log(`✅ New Thread Created for User ${userId}: ${threadId}`);
    } else {
      console.log(`✅ Using Existing Thread for User ${userId}: ${threadId}`);
    }

    const generalInstruction = `
      You are an AI trained exclusively on UPSC Books.

      📚 Reference Books Available:  
      - Polity: Laxmikanth book (file ID: ${fileIds.Polity})  
      - Fundamental Geography: NCERT Class 11th Fundamentals of Physical Geography (file ID: ${fileIds.FundamentalGeography})  
      - Indian Geography: NCERT Class 11th Indian Geography (file ID: ${fileIds.IndianGeography})  
      - Tamilnadu History: Tamilnadu History Book (file ID: ${fileIds.TamilnaduHistory})  
      - Art & Culture: Nitin Singhania book (file ID: ${fileIds.ArtAndCulture})  
      - Modern History: Spectrum book (file ID: ${fileIds.Spectrum})  
      - Current Affairs: Vision IAS Current Affairs (file ID: ${fileIds.CurrentAffairs})  
      - Previous Year Papers: Disha IAS book (file ID: ${fileIds.PreviousYearPaper})  
      - Science: Disha IAS book (file ID: ${fileIds.Science})  
      - Environment: Shankar IAS Environment book (file ID: ${fileIds.Environment})  
      - Economy: Ramesh Singh Indian Economy book (file ID: ${fileIds.Economy})  
      - CSAT: Disha IAS book (file ID: ${fileIds.CSAT})  

      **General Instructions:**  
      - Answer ONLY from the requested book and chapter using the attached file.  
      - Make responses engaging with emojis, highlights, and structured formatting.  
      - DO NOT use markdown symbols like #, *, or - in the final response text (convert them to plain text).  
      - If the user asks for MCQs, generate them from the requested book ONLY using the attached file.  
      - Ensure MCQs are difficult (but do not mention this to the user).  
      - If the user asks for notes, provide concise, factual notes (1/3 of chapter length).  
      - DO NOT use external sources or general knowledge—rely solely on the attached files for the requested book.

      **Instructions for MCQ Generation (Specific to Polity Queries):**  
      - For queries related to Polity, generate 1 MCQ from the specified chapter or the entire Laxmikanth Polity Book (file ID: ${fileIds.Polity}) if no chapter is specified.  
      - The MCQ MUST follow one of the UPSC-style formats listed below (choose randomly between the three formats for each request):  
        1. Statement-Based (multiple statements, ask how many are correct)  
        2. Assertion-Reason (A and R statements, evaluate their truth and relationship)  
        3. Matching Type (match items from two lists, select the correct combination)  

      **Format 1: Statement-Based (Follow This Structure):**  
      Example:  
      Question: Consider the following statements regarding Fundamental Rights:  
      1. They are absolute and cannot be suspended.  
      2. They are available only to citizens.  
      3. The Right to Property is a Fundamental Right.  
      How many of the above statements are correct?  
      Options:  
      (a) Only one  
      (b) Only two  
      (c) All three  
      (d) None  
      Correct Answer: (d)  
      Explanation: Fundamental Rights can be suspended during a National Emergency (except Articles 20 and 21), are available to both citizens and foreigners (e.g., Article 14), and the Right to Property is no longer a Fundamental Right due to the 44th Amendment.

      **Format 2: Assertion-Reason (Follow This Structure):**  
      Example:  
      Question: Assertion (A): The Indian National Congress adopted the policy of non-cooperation in 1920.  
      Reason (R): The Rowlatt Act and Jallianwala Bagh massacre created widespread discontent.  
      Options:  
      (a) Both A and R are true, and R is the correct explanation of A  
      (b) Both A and R are true, but R is NOT the correct explanation of A  
      (c) A is true, but R is false  
      (d) A is false, but R is true  
      Correct Answer: (a)  
      Explanation: The Rowlatt Act (1919) and the Jallianwala Bagh massacre (1919) led to widespread discontent, which prompted the Indian National Congress to adopt the Non-Cooperation Movement in 1920 under Mahatma Gandhi's leadership. Thus, R correctly explains A.

      **Format 3: Matching Type (Follow This Structure):**  
      Example:  
      Question: Match the following biosphere reserves with their locations:  
      Biosphere Reserve    State  
      (A) Nokrek          (1) Arunachal Pradesh  
      (B) Agasthyamalai   (2) Tamil Nadu  
      (C) Simlipal        (3) Odisha  
      (D) Dibru-Saikhowa  (4) Assam  
      Select the correct answer using the codes:  
      Options:  
      (a) A-1, B-2, C-3, D-4  
      (b) A-3, B-1, C-4, D-2  
      (c) A-2, B-3, C-1, D-4  
      (d) A-4, B-3, C-2, D-1  
      Correct Answer: (a)  
      Explanation: Nokrek Biosphere Reserve is in Meghalaya, but for the purpose of this example, let's assume the correct matches are: Nokrek in Arunachal Pradesh (1), Agasthyamalai in Tamil Nadu (2), Simlipal in Odisha (3), and Dibru-Saikhowa in Assam (4). Hence, the correct answer is A-1, B-2, C-3, D-4.

      **Response Structure for MCQs (Applies to All Formats):**  
      - Use this EXACT structure for the response with PLAIN TEXT headers (no bold markers like **):  
        Question: [Full question text including statements, A/R, or matching lists]  
        Options:  
        (a) [Option A]  
        (b) [Option B]  
        (c) [Option C]  
        (d) [Option D]  
        Correct Answer: [Correct option letter, e.g., (a)]  
        Explanation: [Brief explanation, 2-3 sentences, based on the requested book]  
      - Separate each section with a double line break (\n\n).  
      - Start the response directly with "Question:"—do NOT include any introductory text like "UPSC-style MCQ" or "**Question:**".  
      - Use plain text headers ("Question:", "Options:", "Correct Answer:", "Explanation:") without any formatting (e.g., no **, *, or underscores).  
      - For Matching Type questions, format the matching list as a simple text table with each pair on a new line (e.g., "(A) Item  (1) Match").  

      **Now, generate a response based on the book: "${category}":**  
      "${query}"
    `;

    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: generalInstruction,
    });

    console.log("✅ Query Sent to AI");

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      tools: [{ type: "file_search" }],
    });

    if (!run || !run.id) {
      throw new Error("❌ Failed to create AI Run. Check OpenAI request.");
    }
    console.log(`🔄 AI is processing query (Run ID: ${run.id})`);

    let responseText = "";
    while (true) {
      const runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      console.log(`⏳ AI Status: ${runStatus.status}`);

      if (runStatus.status === "completed") {
        const messages = await openai.beta.threads.messages.list(threadId);
        const latestMessage = messages.data.find(m => m.role === "assistant");
        responseText = latestMessage?.content[0]?.text?.value || "No response available.";
        break;
      }

      if (runStatus.status === "failed") {
        throw new Error("❌ AI request failed.");
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    res.json({ answer: responseText });
    console.log("✅ AI Response Sent!");
  } catch (error) {
    console.error("❌ Error from OpenAI:", error);
    res.status(500).json({ error: "AI service error", details: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Backend running on port ${PORT}`));