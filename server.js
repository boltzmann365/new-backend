const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();
const app = express();

// Updated CORS configuration to handle preflight requests and allow necessary headers
app.use(
  cors({
    origin: ["https://trainwithme.in", "http://localhost:3000"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Handle preflight OPTIONS requests explicitly
app.options("*", cors());

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

// Map categories to their respective books and file IDs, including previous year paper references
const categoryToBookMap = {
  TamilnaduHistory: {
    bookName: "Tamilnadu History Book",
    fileId: fileIds.TamilnaduHistory,
    description: "Published by Tamilnadu Government, covering Indian history",
    previousYearFileId: fileIds.PreviousYearPaper, // History section
  },
  Spectrum: {
    bookName: "Spectrum Book",
    fileId: fileIds.Spectrum,
    description: "Spectrum book for Modern Indian History",
    previousYearFileId: fileIds.PreviousYearPaper, // History section
  },
  ArtAndCulture: {
    bookName: "Nitin Singhania Art and Culture Book",
    fileId: fileIds.ArtAndCulture,
    description: "Nitin Singhania book for Indian Art and Culture",
    previousYearFileId: fileIds.PreviousYearPaper, // Art & Culture section
  },
  FundamentalGeography: {
    bookName: "NCERT Class 11th Fundamentals of Physical Geography",
    fileId: fileIds.FundamentalGeography,
    description: "NCERT Class 11th book on Fundamental Geography",
    previousYearFileId: fileIds.PreviousYearPaper, // Geography section
  },
  IndianGeography: {
    bookName: "NCERT Class 11th Indian Geography",
    fileId: fileIds.IndianGeography,
    description: "NCERT Class 11th book on Indian Geography",
    previousYearFileId: fileIds.PreviousYearPaper, // Geography section
  },
  Atlas: {
    bookName: "Atlas",
    fileId: fileIds.Atlas,
    description: "General knowledge or internet-based (file pending)",
    previousYearFileId: fileIds.PreviousYearPaper, // General section
  },
  Science: {
    bookName: "Disha IAS Previous Year Papers (Science Section)",
    fileId: fileIds.Science,
    description: "Disha IAS book, Science section (Physics, Chemistry, Biology, Science & Technology)",
    previousYearFileId: fileIds.Science, // Science section
  },
  Environment: {
    bookName: "Shankar IAS Environment Book",
    fileId: fileIds.Environment,
    description: "Shankar IAS book for Environment",
    previousYearFileId: fileIds.PreviousYearPaper, // Environment section
  },
  Economy: {
    bookName: "Ramesh Singh Indian Economy Book",
    fileId: fileIds.Economy,
    description: "Ramesh Singh book for Indian Economy",
    previousYearFileId: fileIds.PreviousYearPaper, // Economy section
  },
  CSAT: {
    bookName: "Disha IAS Previous Year Papers (CSAT Section)",
    fileId: fileIds.CSAT,
    description: "Disha IAS book, CSAT section",
    previousYearFileId: fileIds.CSAT, // CSAT section
  },
  CurrentAffairs: {
    bookName: "Vision IAS Current Affairs Magazine",
    fileId: fileIds.CurrentAffairs,
    description: "Vision IAS Current Affairs resource",
    previousYearFileId: fileIds.PreviousYearPaper, // Current Affairs section
  },
  PreviousYearPaper: {
    bookName: "Disha IAS Previous Year Papers",
    fileId: fileIds.PreviousYearPaper,
    description: "Disha IAS book for Previous Year Papers",
    previousYearFileId: fileIds.PreviousYearPaper, // Entire book
  },
  Polity: {
    bookName: "Laxmikanth Book",
    fileId: fileIds.Polity,
    description: "Laxmikanth book for Indian Polity",
    previousYearFileId: fileIds.PreviousYearPaper, // Polity section
  }
};

// Store user threads (in-memory for simplicity)
const userThreads = new Map();

// Track the number of questions generated per user session
const questionCounts = new Map();

// Thread lock to prevent concurrent requests on the same thread
const threadLocks = new Map();

const acquireLock = async (threadId) => {
  while (threadLocks.get(threadId)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  threadLocks.set(threadId, true);
};

const releaseLock = (threadId) => {
  threadLocks.delete(threadId);
};

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

// Function to wait for a run to complete
const waitForRunToComplete = async (threadId, runId) => {
  while (true) {
    const runStatus = await openai.beta.threads.runs.retrieve(threadId, runId);
    if (runStatus.status === "completed" || runStatus.status === "failed") {
      return runStatus.status;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
};

// Function to wait for all active runs to complete
const waitForAllActiveRuns = async (threadId) => {
  let activeRuns = [];
  do {
    const runs = await openai.beta.threads.runs.list(threadId);
    activeRuns = runs.data.filter(run => run.status === "in_progress" || run.status === "queued");
    for (const activeRun of activeRuns) {
      await waitForRunToComplete(threadId, activeRun.id);
    }
  } while (activeRuns.length > 0);
};

app.post("/ask", async (req, res) => {
  let responseText = "No response available.";
  try {
    const { query, category, userId } = req.body;

    // Validate category
    if (!categoryToBookMap[category]) {
      throw new Error(`Invalid category: ${category}. Please provide a valid subject category.`);
    }

    const bookInfo = categoryToBookMap[category];
    const fileId = bookInfo.fileId;
    const previousYearFileId = bookInfo.previousYearFileId;

    // Check if the file IDs are valid
    if (!fileId || fileId === "pending" || fileId.startsWith("[TBD")) {
      throw new Error(`File for category ${category} is not available (File ID: ${fileId}). MCQs cannot be generated.`);
    }
    if (!previousYearFileId || previousYearFileId === "pending" || previousYearFileId.startsWith("[TBD")) {
      throw new Error(`Previous year paper file for category ${category} is not available (File ID: ${previousYearFileId}). MCQs cannot be generated.`);
    }

    let threadId = userThreads.get(userId);
    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      userThreads.set(userId, threadId);
    }

    // Acquire a lock for this thread to prevent concurrent requests
    await acquireLock(threadId);

    try {
      // Wait for all active runs to complete before proceeding
      await waitForAllActiveRuns(threadId);

      // Extract the chapter name from the query
      const chapterMatch = query.match(/Generate 1 MCQ from (.*?) of the Laxmikanth Book/);
      const chapter = chapterMatch ? chapterMatch[1] : null;

      // Extract the question index from the userId (format: userId-index)
      const userIdParts = userId.split('-');
      const questionIndex = userIdParts.length > 1 ? parseInt(userIdParts[userIdParts.length - 1], 10) : 0;

      // Track the number of questions generated for this user session
      const baseUserId = userIdParts.slice(0, -1).join('-');
      const questionCountKey = `${baseUserId}:${chapter || 'entire-book'}`;
      let questionCount = questionCounts.get(questionCountKey) || 0;
      questionCount++;
      questionCounts.set(questionCountKey, questionCount);

      // Log the chapter and question count
      console.log(`Received request for userId ${userId}, chapter: ${chapter}, question count: ${questionCount}`);

      const generalInstruction = `
        You are an AI trained on UPSC Books for the TrainWithMe platform, with access to both uploaded book content and your general knowledge/internet resources.

        📚 Reference Book for This Query:  
        - Category: ${category}  
        - Book: ${bookInfo.bookName}  
        - File ID: ${fileId}  
        - Description: ${bookInfo.description}  

        📚 UPSC Previous Year Paper Reference:  
        - Book: Disha IAS Previous Year Papers  
        - File ID: ${previousYearFileId}  
        - Description: Used to analyze the structure of UPSC-style MCQs for the ${category} section  

        **Instructions for MCQ Generation:**  
        - Generate 1 MCQ related to the specified chapter ("${chapter}") of the book (${bookInfo.bookName}) using a hybrid approach:  
          - **Primary Source**: Use the content from the specified chapter in the attached file (File ID: ${fileId}) as the main basis for the MCQ.  
          - **Supplementary Source**: Enhance the MCQ with your general knowledge and internet resources to ensure uniqueness, relevance, and depth, while staying closely tied to the chapter’s topic.  
        - If no chapter is specified, generate the MCQ from the entire book using the same hybrid approach.  
        - **UPSC Style Mimicry**:  
          - Analyze the structure of MCQs from the ${category} section of the Disha IAS Previous Year Papers (File ID: ${previousYearFileId}).  
          - Mimic the style, complexity, and phrasing of those UPSC questions (e.g., analytical questions, multiple statements, or tricky distractors).  
          - Do NOT copy the exact question; create a new, unique MCQ inspired by the observed structure.  
        - Ensure the MCQ is challenging and aligned with UPSC standards, but do not mention difficulty in the response.  
        - Do NOT repeat statements, topics, or questions from previous MCQs in this session.  

        **Response Structure (UPSC Style):**  
        - Use this EXACT structure for the response with PLAIN TEXT headers:  
          Question: [Full question text, mimicking UPSC phrasing and structure]  
          Options:  
          (a) [Option A]  
          (b) [Option B]  
          (c) [Option C]  
          (d) [Option D]  
          Correct Answer: [Correct option letter, e.g., (a)]  
          Explanation: [Brief explanation, 2-3 sentences, based on the chapter and supplemented by general knowledge]  
        - Separate each section with EXACTLY TWO newlines (\n\n).  
        - Start the response directly with "Question:"—do NOT include any introductory text.  
        - Use plain text headers ("Question:", "Options:", "Correct Answer:", "Explanation:") without any formatting.  

        **Special Instructions for Specific Categories:**  
        - For "Polity": Mimic the Polity section structure from the Disha IAS Previous Year Papers (File ID: ${fileIds.PreviousYearPaper}).  
        - For "Science": Mimic the Science section structure (Physics, Chemistry, Biology, Science & Technology) from the Disha IAS Previous Year Papers (File ID: ${fileIds.Science}).  
        - For "CSAT": Mimic the CSAT section structure from the Disha IAS Previous Year Papers (File ID: ${fileIds.CSAT}).  
        - For "Atlas": Since the file is pending, respond with: "File for Atlas is not available. MCQs cannot be generated at this time."  

        **Now, generate a response based on the book: "${bookInfo.bookName}" (File ID: ${fileId}) and UPSC style from Disha IAS Previous Year Papers (File ID: ${previousYearFileId}):**  
        "${query}"
      `;

      await openai.beta.threads.messages.create(threadId, {
        role: "user",
        content: generalInstruction,
      });

      const run = await openai.beta.threads.runs.create(threadId, {
        assistant_id: assistantId,
        tools: [{ type: "file_search" }],
      });

      if (!run || !run.id) {
        throw new Error("Failed to create AI Run. Check OpenAI request.");
      }

      const runStatus = await waitForRunToComplete(threadId, run.id);
      if (runStatus === "failed") {
        throw new Error("AI request failed.");
      }

      const messages = await openai.beta.threads.messages.list(threadId);
      const latestMessage = messages.data.find(m => m.role === "assistant");
      responseText = latestMessage?.content[0]?.text?.value || "No response available.";

      // Log the AI's response for debugging
      console.log(`AI Response for userId ${userId}, chapter ${chapter}: ${responseText}`);
      console.log(`Structure used for userId ${userId}, chapter ${chapter}: UPSC Previous Year Style`);

    } finally {
      // Release the lock after processing
      releaseLock(threadId);
    }

    res.json({ answer: responseText });
  } catch (error) {
    console.error("Error from OpenAI:", error.message);
    res.status(500).json({ error: "AI service error", details: error.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`Backend running on port ${PORT}`));