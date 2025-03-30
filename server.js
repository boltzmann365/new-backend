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
  Atlas: "pending", // Placeholder, update with actual file ID once uploaded
  Science: "file-TGgc65bHqVMxpmj5ULyR6K", // Disha IAS book for Science
  Environment: "file-Yb1cfrHMATDNQgyUa6jDqw", // Shankar IAS Environment book
  Economy: "file-TJ5Djap1uv4fZeyM5c6sKU", // Ramesh Singh book
  EconomicSurvey2025: "[TBD - Economic Survey file ID]", // Placeholder for Economic Survey
  CSAT: "file-TGgc65bHqVMxpmj5ULyR6K", // Disha IAS book for CSAT (same as Science and PreviousYearPaper)
  CurrentAffairs: "file-5BX6sBLZ2ws44NBUTbcyWg", // Current Affairs resource
  PreviousYearPaper: "file-TGgc65bHqVMxpmj5ULyR6K", // Disha IAS book for Previous Year Papers (same as Science)
  Polity: "file-G15UzpuvCRuMG4g6ShCgFK", // Laxmikanth book for Polity
};

// Store user threads (in-memory for simplicity)
const userThreads = new Map(); // Key: User ID, Value: Thread ID

// Update Assistant to Include File Search with All Valid Files
const updateAssistantWithFiles = async () => {
  try {
    // Filter out placeholder file IDs (e.g., "pending", TBD values)
    const validFileIds = Object.values(fileIds).filter(
      fileId => fileId && fileId !== "pending" && !fileId.startsWith("[TBD")
    );

    // Verify each file ID exists in OpenAI file storage
    for (const fileId of validFileIds) {
      try {
        const file = await openai.files.retrieve(fileId);
        console.log(`File ${fileId} verified: ${file.filename}`);
      } catch (error) {
        console.error(`Error verifying file ${fileId}:`, error.message);
        // Remove invalid file ID from the list
        const index = validFileIds.indexOf(fileId);
        if (index !== -1) {
          validFileIds.splice(index, 1);
        }
      }
    }

    // Update the assistant with the valid file IDs
    const assistant = await openai.beta.assistants.update(assistantId, {
      tools: [{ type: "file_search" }],
      tool_resources: {
        file_search: {
          file_ids: validFileIds,
        },
      },
    });
    console.log(`✅ Assistant ${assistantId} updated with file search tool and reference book files: ${validFileIds.join(", ")}`);
    console.log("Updated assistant tool resources:", assistant.tool_resources);
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

    // Step 1: Check if the user already has a thread
    let threadId = userThreads.get(userId);

    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      userThreads.set(userId, threadId);
      console.log(`✅ New Thread Created for User ${userId}: ${threadId}`);
    } else {
      console.log(`✅ Using Existing Thread for User ${userId}: ${threadId}`);
    }

    // Step 2: Define Comprehensive Instruction with UPSC-Style MCQ Examples
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

      📘 About the Tamilnadu History Book:  
      - The Tamilnadu History Book is an 11th-grade textbook published by the Tamil Nadu State Board.  
      - Despite its name, the book covers the entire history of India, not just Tamil Nadu-specific history.  
      - The book includes topics such as the Indus Civilisation, Vedic Cultures, Mauryan Empire, Guptas, Mughals, Marathas, British Rule, and more, as outlined in its table of contents.  
      - The Tamilnadu History Book file has been attached to the assistant for file search (file ID: ${fileIds.TamilnaduHistory}). Use this file as the sole source for generating responses related to the Tamilnadu History Book.

      📘 About the Spectrum Book:  
      - The Spectrum book, titled A Brief History of Modern India, is a widely used resource for UPSC aspirants.  
      - It focuses on modern Indian history, covering topics such as the advent of Europeans, British rule, the freedom struggle, and post-independence India.  
      - The book includes chapters like Sources of Modern Indian History, Revolt of 1857, Nationalist Movement, and Post-Independence Consolidation, as outlined in its table of contents.  
      - The Spectrum book file has been attached to the assistant for file search (file ID: ${fileIds.Spectrum}). Use this file as the sole source for generating responses related to the Spectrum book.

      📘 About the Nitin Singhania Art and Culture Book:  
      - The book, titled Indian Art and Culture by Nitin Singhania, is a widely used resource for UPSC aspirants.  
      - It focuses on Indian art, culture, architecture, and heritage, covering topics such as Indian architecture, painting, performing arts, festivals, and UNESCO heritage sites.  
      - The book includes chapters like Indian Architecture, Performing Arts: Dance, Indian Cinema, and UNESCO’s List of Intangible Cultural Heritage, as outlined in its table of contents.  
      - The Nitin Singhania Art and Culture book file has been attached to the assistant for file search (file ID: ${fileIds.ArtAndCulture}). Use this file as the sole source for generating responses related to the Nitin Singhania Art and Culture book.

      📘 About the topic wise previous year mcq from 1195 to 2020 mcq training material.pdf:  
      - The book compiles the last 30 years of UPSC previous year questions, organized theme-wise.  
      - It includes sections like Physics, Chemistry, Biology, Science & Technology, History, Polity, Geography, Environment, Economy, and CSAT, covering previously asked questions in these areas.  
      - The topic wise previous year mcq from 1195 to 2020 mcq training material.pdf file has been attached to the assistant for file search (file ID: ${fileIds.PreviousYearPaper}). Use this file as the sole source for generating responses related to the topic wise previous year mcq from 1195 to 2020 mcq training material.pdf.

      📘 About the Shankar IAS Environment Book:  
      - The book is a comprehensive resource for UPSC aspirants focusing on environmental studies.  
      - It covers topics such as Ecology, Biodiversity, Climate Change, Environmental Laws, Pollution, and Sustainable Development, organized into sections.  
      - The Shankar IAS Environment book file has been attached to the assistant for file search (file ID: ${fileIds.Environment}). Use this file as the sole source for generating responses related to the Shankar IAS Environment book.

      📘 About the Laxmikanth Book (Polity):  
      - The book, titled Indian Polity by M. Laxmikanth, is a widely used resource for UPSC aspirants.  
      - It focuses on Indian polity and governance, covering topics such as the Constitution, Parliament, Judiciary, Federalism, and Local Government.  
      - The book includes chapters like Constitutional Framework, Union and its Territory, Parliament, and State Government, as outlined in its table of contents.  
      - The Laxmikanth book file has been attached to the assistant for file search (file ID: ${fileIds.Polity}). Use this file as the sole source for generating responses related to the Laxmikanth book.

      📘 About the Fundamentals of Geography Book:  
      - The book, titled Fundamentals of Physical Geography, is an NCERT Class 11th textbook widely used by UPSC aspirants.  
      - It focuses on physical geography, covering topics such as the Earth's structure, landforms, climate, oceans, and life on Earth.  
      - The book includes units like Geography as a Discipline, The Earth, Landforms, Climate, Water (Oceans), and Life on the Earth, as outlined in its table of contents.  
      - The Fundamentals of Geography book file has been attached to the assistant for file search (file ID: ${fileIds.FundamentalGeography}). Use this file as the sole source for generating responses related to the Fundamentals of Geography book.

      📘 About the Indian Geography Book:  
      - The book, titled India: Physical Environment, is an NCERT Class 11th textbook widely used by UPSC aspirants.  
      - It focuses on Indian geography, covering topics such as India's location, physiography, drainage systems, climate, natural vegetation, soils, and natural hazards.  
      - The book includes units like India – Location, Structure and Physiography, Drainage System, Climate, Natural Vegetation, Soils, and Natural Hazards and Disasters, as outlined in its table of contents.  
      - The Indian Geography book file has been attached to the assistant for file search (file ID: ${fileIds.IndianGeography}). Use this file as the sole source for generating responses related to the Indian Geography book.

      📘 About the Vision IAS Current Affairs:  
      - The resource is a compilation of Current Affairs relevant for UPSC preparation, covering events, policies, and developments across various months.  
      - It includes a specific section for December 2024, along with other monthly sections (e.g., January 2024 to November 2024).  
      - The Vision IAS Current Affairs file has been attached to the assistant for file search (file ID: ${fileIds.CurrentAffairs}). Use this file as the sole source for generating responses related to the Vision IAS Current Affairs.

      📘 About the Ramesh Singh Indian Economy Book:  
      - The book, titled Indian Economy by Ramesh Singh, is a widely used resource for UPSC aspirants.  
      - It focuses on the Indian economy, covering topics such as economic planning, national income, fiscal policy, monetary policy, banking, agriculture, industry, foreign trade, and economic reforms.  
      - The book includes chapters like Introduction to Indian Economy, Economic Planning in India, National Income and Economic Growth, Poverty and Unemployment, Inflation, Fiscal Policy, Monetary Policy, Banking and Financial Institutions, Public Finance, Agriculture, Industry, Services Sector, Infrastructure, Foreign Trade, International Economic Organizations, Economic Reforms, Human Development, Sustainable Development and Climate Change, and Current Economic Issues, as outlined in its table of contents.  
      - The Ramesh Singh Indian Economy book file has been attached to the assistant for file search (file ID: ${fileIds.Economy}). Use this file as the sole source for generating responses related to the Ramesh Singh Indian Economy book.

      **General Instructions:**  
      - 🎯 Answer ONLY from the requested book and chapter using the attached file.  
      - ✨ Make responses engaging with emojis, highlights, and structured formatting.  
      - 🔍 DO NOT use markdown symbols like #, *, or - (convert them to bold or normal text).  
      - 📖 If the user asks for MCQs, generate them from the requested book ONLY using the attached file.  
      - ✨ _Use underscores (_ _) for important points instead of markdown._  
      - 🔍 _DO NOT use markdown symbols like **, #, or - (convert them to underscores or normal text)._  
      - 🔥 Ensure MCQs are difficult (but do not mention this to the user).  
      - 📝 If user asks for notes, provide concise, factual notes (1/3 of chapter length).  
      - 🚫 DO NOT use external sources or general knowledge—rely solely on the attached files for the requested book.

      **Instructions for MCQ Generation (Specific to Polity Queries):**  
      - For queries related to Polity, generate 1 MCQ from the specified chapter or the entire Laxmikanth Polity Book (file ID: ${fileIds.Polity}) if no chapter is specified.  
      - The MCQ must follow UPSC-style formats (e.g., statement-based, assertion-reason, matching, chronological order, single correct answer).  
      - Mimic the structure and complexity of the following UPSC-style examples:  

      **Example 1 (Statement-Based):**  
      Question: Consider the following statements regarding the Goods and Services Tax (GST):  
      1. GST is a destination-based tax.  
      2. It is levied on the value addition at each stage of the supply chain.  
      3. Alcoholic beverages are under the GST regime.  
      4. The GST Council is chaired by the Prime Minister of India.  
      How many of the above statements are correct?  
      Options:  
      (a) Only one  
      (b) Only two  
      (c) Only three  
      (d) All four  
      Correct Answer: (b)  
      Explanation: GST is a destination-based tax and is levied on value addition, making statements 1 and 2 correct. Alcoholic beverages are excluded from GST, and the GST Council is chaired by the Finance Minister, not the Prime Minister, making statements 3 and 4 incorrect.

      **Example 2 (Assertion-Reason):**  
      Question: Assertion (A): The Indian National Congress adopted the policy of non-cooperation in 1920.  
      Reason (R): The Rowlatt Act and Jallianwala Bagh massacre created widespread discontent.  
      Options:  
      (a) Both A and R are true, and R is the correct explanation of A  
      (b) Both A and R are true, but R is NOT the correct explanation of A  
      (c) A is true, but R is false  
      (d) A is false, but R is true  
      Correct Answer: (a)  
      Explanation: The non-cooperation movement was launched in 1920 due to widespread discontent caused by the Rowlatt Act and Jallianwala Bagh massacre, making both A and R true, with R explaining A.

      **Example 3 (Matching):**  
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
      Explanation: Nokrek is in Meghalaya (not listed, but assume correct pairing), Agasthyamalai in Tamil Nadu, Simlipal in Odisha, and Dibru-Saikhowa in Assam, though this is adjusted to fit the example options.

      **Example 4 (Correct/Incorrect Statements):**  
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
      Explanation: Organic matter increases water-holding capacity, and soil is crucial to the nitrogen cycle, making statements 1 and 2 incorrect. Long-term irrigation can lead to soil salinity, making statement 3 correct.

      **Example 5 (Chronological Order):**  
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
      Explanation: Battle of Plassey (1757), Third Battle of Panipat (1761), Regulating Act (1773), and Treaty of Bassein (1802) follow this order.

      **Example 6 (Correctly Matched Pairs):**  
      Question: Consider the following pairs:  
      Festival    State  
      (A) Chapchar Kut    Nagaland  
      (B) Wangala         Meghalaya  
      (C) Losar           Arunachal Pradesh  
      Which of the pairs are correctly matched?  
      Options:  
      (a) A and B only  
      (b) B and C only  
      (c) A and C only  
      (d) A, B, and C  
      Correct Answer: (b)  
      Explanation: Chapchar Kut is from Mizoram, not Nagaland (A is incorrect). Wangala is from Meghalaya (B is correct), and Losar is from Arunachal Pradesh (C is correct).

      **Example 7 (Single Correct Answer):**  
      Question: Which one of the following is a tributary of the Brahmaputra?  
      Options:  
      (a) Gandak  
      (b) Kosi  
      (c) Subansiri  
      (d) Yamuna  
      Correct Answer: (c)  
      Explanation: Subansiri is a tributary of the Brahmaputra, while Gandak, Kosi, and Yamuna are tributaries of the Ganga.

      **Response Structure for MCQs:**  
      - Use the following structure for the response:  
        Question: [Full question text including statements, assertion-reason, or matching pairs if applicable]  
        Options:  
        (a) [Option A]  
        (b) [Option B]  
        (c) [Option C]  
        (d) [Option D]  
        Correct Answer: [Correct option letter, e.g., (a)]  
        Explanation: [Brief explanation, 2-3 sentences, based on the requested book]  
      - Separate each section with a double line break (\n\n).  
      - Ensure the MCQ is relevant to UPSC preparation and sourced only from the requested book file.

      **Now, generate a response based on the book: "${category}":**  
      "${query}"
    `;

    // Step 3: Send User Query with Instruction
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: generalInstruction,
    });

    console.log("✅ Query Sent to AI");

    // Step 4: Run the Assistant
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      tools: [{ type: "file_search" }],
    });

    if (!run || !run.id) {
      throw new Error("❌ Failed to create AI Run. Check OpenAI request.");
    }
    console.log(`🔄 AI is processing query (Run ID: ${run.id})`);

    // Step 5: Wait for AI to Complete Processing
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

    // Step 6: Send AI Response to Frontend
    res.json({ answer: responseText });
    console.log("✅ AI Response Sent!");

  } catch (error) {
    console.error("❌ Error from OpenAI:", error);
    res.status(500).json({ error: "AI service error", details: error.message });
  }
});

// Start Express Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ Backend running on port ${PORT}`));