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

    // Explicitly select the MCQ structure using random number
    const structureIndex = Math.floor(Math.random() * 7) + 1; // Random number between 1 and 7
    let selectedStructure;
    switch (structureIndex) {
      case 1:
        selectedStructure = "Statement-Based";
        break;
      case 2:
        selectedStructure = "Assertion-Reason";
        break;
      case 3:
        selectedStructure = "Matching Type";
        break;
      case 4:
        selectedStructure = "Multiple Statements with Specific Combinations";
        break;
      case 5:
        selectedStructure = "Chronological Order";
        break;
      case 6:
        selectedStructure = "Correctly Matched Pairs";
        break;
      case 7:
        selectedStructure = "Direct Question with Single Correct Answer";
        break;
      default:
        selectedStructure = "Statement-Based"; // Fallback
    }
    console.log(`🔸 Selected MCQ Structure: ${selectedStructure}`);

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
      - The MCQ MUST follow the UPSC-style format specified below. Use the following structure: ${selectedStructure}

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
      Question: Match the following parliamentary committees with their functions:  
      Parliamentary Committee    Function  
      (A) Estimates Committee       (1) Reviews and reports on the accounts of the government  
      (B) Public Accounts Committee (2) Examines the demands for grants  
      (C) Committee on Public Undertakings (3) Investigates the working of public sector undertakings  
      (D) Committee on Delegated Legislation (4) Oversees the rules framed by the government  
      Select the correct answer using the codes:  
      Options:  
      (a) A-2, B-1, C-3, D-4  
      (b) A-1, B-2, C-4, D-3  
      (c) A-3, B-2, C-1, D-4  
      (d) A-4, B-3, C-2, D-1  
      Correct Answer: (a)  
      Explanation: The Estimates Committee examines the demands for grants (A-2), the Public Accounts Committee reviews the accounts of the government (B-1), the Committee on Public Undertakings investigates the working of public sector undertakings (C-3), and the Committee on Delegated Legislation oversees the rules framed by the government (D-4).

      **Format 4: Multiple Statements with Specific Combinations (Follow This Structure):**  
      Example:  
      Question: With reference to agricultural soils, consider the following statements:  
      1. A high content of organic matter in soil drastically reduces its water-holding capacity.  
      2. Soil does not play any role in the nitrogen cycle.  
      3. Irrigation over a long period of time can contribute to soil salinity.  
      Which of the statements given above is/are correct?  
      Options:  
      (a) 1 and 2 only  
      (b) 3 only  
      (c) 1 and 3 only  
      (d) 1, 2, and 3  
      Correct Answer: (b)  
      Explanation: Statement 1 is incorrect because a high content of organic matter increases the water-holding capacity of soil. Statement 2 is incorrect as soil plays a significant role in the nitrogen cycle through processes like nitrogen fixation. Statement 3 is correct because long-term irrigation can lead to soil salinity due to the accumulation of salts.

      **Format 5: Chronological Order (Follow This Structure):**  
      Example:  
      Question: Arrange the following events in chronological order:  
      1. Battle of Plassey  
      2. Third Battle of Panipat  
      3. Regulating Act of 1773  
      4. Treaty of Bassein  
      Select the correct order:  
      Options:  
      (a) 1-2-3-4  
      (b) 2-1-3-4  
      (c) 1-3-2-4  
      (d) 3-2-1-4  
      Correct Answer: (a)  
      Explanation: The Battle of Plassey occurred in 1757, the Third Battle of Panipat in 1761, the Regulating Act was passed in 1773, and the Treaty of Bassein was signed in 1802. Thus, the correct chronological order is 1-2-3-4.

      **Format 6: Correctly Matched Pairs (Follow This Structure):**  
      Example:  
      Question: Consider the following pairs:  
      Festival    State  
      (A) Chapchar Kut    Nagaland  
      (B) Wangala    Meghalaya  
      (C) Losar    Arunachal Pradesh  
      Which of the pairs are correctly matched?  
      Options:  
      (a) A and B only  
      (b) B and C only  
      (c) A and C only  
      (d) A, B, and C  
      Correct Answer: (b)  
      Explanation: Chapchar Kut is a festival of Mizoram, not Nagaland, so (A) is incorrect. Wangala is correctly matched with Meghalaya, and Losar is correctly matched with Arunachal Pradesh. Thus, only B and C are correctly matched.

      **Format 7: Direct Question with Single Correct Answer (Follow This Structure):**  
      Example:  
      Question: Which one of the following is a tributary of the Brahmaputra?  
      Options:  
      (a) Gandak  
      (b) Kosi  
      (c) Subansiri  
      (d) Yamuna  
      Correct Answer: (c)  
      Explanation: The Subansiri is a major tributary of the Brahmaputra, joining it in Assam. The Gandak and Kosi are tributaries of the Ganga, and the Yamuna is a tributary of the Ganga as well.

      **Response Structure for MCQs (Applies to All Formats):**  
      - Use this EXACT structure for the response with PLAIN TEXT headers (no bold markers like **):  
        Question: [Full question text including statements, A/R, matching lists, etc.]  
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
      - For Matching Type and Correctly Matched Pairs questions, format the list as a simple text table with each pair on a new line (e.g., "(A) Item  (1) Match").  

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