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
      - The MCQ MUST follow ONE of the 7 UPSC-style formats listed below. RANDOMLY SELECT a different format for each request to ensure variety (e.g., cycle through all 7 formats before repeating any):  
        1. Statement-Based (multiple statements, ask how many are correct)  
        2. Assertion-Reason (A and R with explanation)  
        3. Matching (list items to match with options)  
        4. Correct/Incorrect Statements (identify which are correct)  
        5. Chronological Order (arrange events)  
        6. Correctly Matched Pairs (identify correct pairs)  
        7. Single Correct Answer (one correct option)  

      **Examples for Each Format (Follow These Structures):**  

      Example 1 (Statement-Based):  
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

      Example 2 (Assertion-Reason):  
      Question: Assertion (A): Fundamental Rights can be suspended during a National Emergency.  
      Reason (R): Article 359 allows the President to suspend the right to move courts for enforcement of Fundamental Rights.  
      Options:  
      (a) Both A and R are true, and R is the correct explanation of A  
      (b) Both A and R are true, but R is NOT the correct explanation of A  
      (c) A is true, but R is false  
      (d) A is false, but R is true  
      Correct Answer: (a)  
      Explanation: Both A and R are true, and R correctly explains A because Article 359 empowers the President to suspend judicial enforcement of Fundamental Rights during an emergency.

      Example 3 (Matching):  
      Question: Match the following Fundamental Rights with their corresponding Articles:  
      Right              Article  
      (A) Right to Equality    (1) Article 19  
      (B) Right to Freedom     (2) Article 14  
      (C) Right to Constitutional Remedies (3) Article 32  
      Select the correct answer using the codes:  
      Options:  
      (a) A-2, B-1, C-3  
      (b) A-1, B-2, C-3  
      (c) A-2, B-3, C-1  
      (d) A-3, B-1, C-2  
      Correct Answer: (a)  
      Explanation: Right to Equality is under Article 14, Right to Freedom under Article 19, and Right to Constitutional Remedies under Article 32.

      Example 4 (Correct/Incorrect Statements):  
      Question: With reference to Fundamental Rights, consider the following statements:  
      1. The Right to Education is a Fundamental Right under Article 21A.  
      2. The Right to Property is a Fundamental Right under Article 31.  
      3. Fundamental Rights are enforceable only against the State.  
      Which of the statements given above is/are correct?  
      Options:  
      (a) 1 only  
      (b) 1 and 3 only  
      (c) 2 and 3 only  
      (d) 1, 2, and 3  
      Correct Answer: (b)  
      Explanation: Statement 1 is correct (Article 21A). Statement 2 is incorrect (Right to Property is a legal right under Article 300A). Statement 3 is correct as Fundamental Rights are primarily enforceable against the State.

      Example 5 (Chronological Order):  
      Question: Arrange the following constitutional amendments related to Fundamental Rights in chronological order:  
      1. 1st Amendment (1951)  
      2. 44th Amendment (1978)  
      3. 86th Amendment (2002)  
      Select the correct order:  
      Options:  
      (a) 1-2-3  
      (b) 2-1-3  
      (c) 3-2-1  
      (d) 1-3-2  
      Correct Answer: (a)  
      Explanation: 1st Amendment (1951) added restrictions to free speech, 44th Amendment (1978) removed Right to Property as a Fundamental Right, and 86th Amendment (2002) added Right to Education.

      Example 6 (Correctly Matched Pairs):  
      Question: Consider the following pairs:  
      Fundamental Right    Article  
      (A) Right to Equality    Article 14  
      (B) Right to Freedom     Article 21  
      (C) Right Against Exploitation    Article 23  
      Which of the pairs are correctly matched?  
      Options:  
      (a) A and B only  
      (b) B and C only  
      (c) A and C only  
      (d) A, B, and C  
      Correct Answer: (c)  
      Explanation: Right to Equality is under Article 14 (A is correct), Right to Freedom includes Article 19 not 21 (B is incorrect), Right Against Exploitation is under Article 23 (C is correct).

      Example 7 (Single Correct Answer):  
      Question: Which one of the following is NOT a Fundamental Right under the Constitution of India?  
      Options:  
      (a) Right to Equality  
      (b) Right to Freedom  
      (c) Right to Property  
      (d) Right Against Exploitation  
      Correct Answer: (c)  
      Explanation: Right to Property was removed as a Fundamental Right by the 44th Amendment and is now a legal right under Article 300A.

      **Response Structure for MCQs:**  
      - Use this EXACT structure for the response with PLAIN TEXT headers (no bold markers like **):  
        Question: [Full question text including statements, assertion-reason, or matching pairs if applicable]  
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