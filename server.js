const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();
const app = express();

app.use(
  cors({
    origin: ["https://trainwithme.in", "http://localhost:3000"],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.options("*", cors());
app.use(express.json());

// OpenAI API Setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" }
});

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

// Map categories to their books and file IDs
const categoryToBookMap = {
  TamilnaduHistory: {
    bookName: "Tamilnadu History Book",
    fileId: fileIds.TamilnaduHistory,
    description: "Published by Tamilnadu Government, covering Indian history"
  },
  Spectrum: {
    bookName: "Spectrum Book",
    fileId: fileIds.Spectrum,
    description: "Spectrum book for Modern Indian History"
  },
  ArtAndCulture: {
    bookName: "Nitin Singhania Art and Culture Book",
    fileId: fileIds.ArtAndCulture,
    description: "Nitin Singhania book for Indian Art and Culture"
  },
  FundamentalGeography: {
    bookName: "NCERT Class 11th Fundamentals of Physical Geography",
    fileId: fileIds.FundamentalGeography,
    description: "NCERT Class 11th book on Fundamental Geography"
  },
  IndianGeography: {
    bookName: "NCERT Class 11th Indian Geography",
    fileId: fileIds.IndianGeography,
    description: "NCERT Class 11th book on Indian Geography"
  },
  Atlas: {
    bookName: "Atlas",
    fileId: fileIds.Atlas,
    description: "General knowledge or internet-based (file pending)"
  },
  Science: {
    bookName: "Disha IAS Previous Year Papers (Science Section)",
    fileId: fileIds.Science,
    description: "Disha IAS book, Science section (Physics, Chemistry, Biology, Science & Technology)"
  },
  Environment: {
    bookName: "Shankar IAS Environment Book",
    fileId: fileIds.Environment,
    description: "Shankar IAS book for Environment"
  },
  Economy: {
    bookName: "Ramesh Singh Indian Economy Book",
    fileId: fileIds.Economy,
    description: "Ramesh Singh book for Indian Economy"
  },
  CSAT: {
    bookName: "Disha IAS Previous Year Papers (CSAT Section)",
    fileId: fileIds.CSAT,
    description: "Disha IAS book, CSAT section"
  },
  CurrentAffairs: {
    bookName: "Vision IAS Current Affairs Magazine",
    fileId: fileIds.CurrentAffairs,
    description: "Vision IAS Current Affairs resource"
  },
  PreviousYearPaper: {
    bookName: "Disha IAS Previous Year Papers",
    fileId: fileIds.PreviousYearPaper,
    description: "Disha IAS book for Previous Year Papers"
  },
  Polity: {
    bookName: "Laxmikanth Book",
    fileId: fileIds.Polity,
    description: "Laxmikanth book for Indian Polity"
  }
};

// Store user threads, question counts, last used structure, and previous topics
const userThreads = new Map();
const questionCounts = new Map();
const lastUsedStructure = new Map();
const threadLocks = new Map();
const previousTopics = new Map(); // Track previous topics to avoid repetition

const acquireLock = async (threadId) => {
  while (threadLocks.get(threadId)) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  threadLocks.set(threadId, true);
};

const releaseLock = (threadId) => {
  threadLocks.delete(threadId);
};

// Update Assistant with File Search
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

updateAssistantWithFiles();

// Wait for run completion
const waitForRunToComplete = async (threadId, runId) => {
  while (true) {
    const runStatus = await openai.beta.threads.runs.retrieve(threadId, runId);
    if (runStatus.status === "completed" || runStatus.status === "failed") {
      return runStatus.status;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
};

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

// UPSC MCQ Structures
const upscStructures = [
  {
    name: "Multiple Statements - How Many Correct",
    example: "Consider the following statements regarding [Topic]: ... How many of the above statements are correct?",
    options: ["(a) Only one", "(b) Only two", "(c) Only three", "(d) All four"]
  },
  {
    name: "Assertion and Reason",
    example: "Assertion (A): [Statement]. Reason (R): [Statement].",
    options: [
      "(a) Both A and R are true, and R is the correct explanation of A",
      "(b) Both A and R are true, but R is NOT the correct explanation of A",
      "(c) A is true, but R is false",
      "(d) A is false, but R is true"
    ]
  },
  {
    name: "Matching List",
    example: "Match the following [Items] with their [Categories]: ... Select the correct answer using the codes:",
    options: ["(a) A-1, B-2, C-3, D-4", "(b) A-3, B-1, C-4, D-2", "(c) A-2, B-3, C-1, D-4", "(d) A-4, B-3, C-2, D-1"]
  },
  {
    name: "Multiple Statements - Which Correct",
    example: "With reference to [Topic], consider the following statements: ... Which of the statements given above is/are correct?",
    options: ["(a) 1 and 2 only", "(b) 3 only", "(c) 1 and 3 only", "(d) 1, 2, and 3"]
  },
  {
    name: "Chronological Order",
    example: "Arrange the following events in chronological order: ... Select the correct order:",
    options: ["(a) 1-2-3-4", "(b) 2-1-3-4", "(c) 1-3-2-4", "(d) 3-2-1-4"]
  },
  {
    name: "Pairs Matching - Which Correct",
    example: "Consider the following pairs: ... Which of the pairs are correctly matched?",
    options: ["(a) A and B only", "(b) B and C only", "(c) A and C only", "(d) A, B, and C"]
  },
  {
    name: "Single Correct Answer",
    example: "Which one of the following is [Question]?",
    options: ["(a) [Option A]", "(b) [Option B]", "(c) [Option C]", "(d) [Option D]"]
  }
];

const chooseStructure = (userId) => {
  const lastStructureIndex = lastUsedStructure.get(userId);
  let newStructureIndex;
  do {
    newStructureIndex = Math.floor(Math.random() * upscStructures.length);
  } while (newStructureIndex === lastStructureIndex && upscStructures.length > 1);
  lastUsedStructure.set(userId, newStructureIndex);
  return upscStructures[newStructureIndex];
};

app.post("/ask", async (req, res) => {
  let responseText = "No response available.";
  try {
    const { query, category, userId } = req.body;

    if (!categoryToBookMap[category]) {
      throw new Error(`Invalid category: ${category}. Please provide a valid subject category.`);
    }

    const bookInfo = categoryToBookMap[category];
    const fileId = bookInfo.fileId;

    if (!fileId || fileId === "pending" || fileId.startsWith("[TBD")) {
      throw new Error(`File for category ${category} is not available (File ID: ${fileId}). MCQs cannot be generated.`);
    }

    let threadId = userThreads.get(userId);
    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
      userThreads.set(userId, threadId);
    }

    await acquireLock(threadId);

    try {
      await waitForAllActiveRuns(threadId);

      const chapterMatch = query.match(/Generate 1 MCQ from (.*?) of the Tamilnadu History Book/);
      const chapter = chapterMatch ? chapterMatch[1] : null;

      const userIdParts = userId.split('-');
      const questionIndex = userIdParts.length > 1 ? parseInt(userIdParts[userIdParts.length - 1], 10) : 0;
      const baseUserId = userIdParts.slice(0, -1).join('-');
      const questionCountKey = `${baseUserId}:${chapter || 'entire-book'}`;
      let questionCount = questionCounts.get(questionCountKey) || 0;
      questionCount++;
      questionCounts.set(questionCountKey, questionCount);

      console.log(`Received request for userId ${userId}, chapter: ${chapter}, question count: ${questionCount}`);

      const selectedStructure = chooseStructure(userId);

      // Retrieve previous topics for this session
      let prevTopics = previousTopics.get(questionCountKey) || [];
      const previousTopicsList = prevTopics.length > 0 ? `Previous topics in this session: ${prevTopics.join(", ")}.` : "No previous topics yet.";

      const generalInstruction = `
        You are an AI designed to create an elite UPSC training camp for the TrainWithMe platform, delivering diverse, deeply researched, and accurate MCQs that captivate and challenge users. You have access to the uploaded book content (File ID: ${fileId}) and your extensive training data encompassing vast historical, philosophical, and cultural knowledge.

        📚 Reference Book for This Query:  
        - Category: ${category}  
        - Book: ${bookInfo.bookName}  
        - File ID: ${fileId}  
        - Description: ${bookInfo.description}  

        **Instructions for MCQ Generation:**  
        - Generate 1 MCQ inspired by the specified chapter ("${chapter}") of the book (${bookInfo.bookName}), or the entire book if no chapter is specified.  
        - **Even and Dynamic Coverage**: Analyze the full content of "${chapter}" (File ID: ${fileId}) and distribute focus evenly across its timeline, themes, events, figures, and contexts (e.g., political rise, military campaigns, administration, economy, culture, decline). Use your understanding to identify all key aspects without fixating on any single part (e.g., avoid over-repeating Ashoka, Chandragupta, or dhamma in "Unit 4").  
        - **Break Fixation**: For this MCQ (question ${questionCount}), select a fresh focus distinct from previous topics in this session (${previousTopicsList}). Shift progressively across the chapter’s breadth with each question, ensuring no repetition of figures, events, or themes unless presented in a novel way.  
        - **Expand with External Knowledge**: Enrich the MCQ with your broader training data, introducing diverse, relevant details or events not explicitly in the chapter but thematically connected (e.g., for "Unit 4," explore Seleucid interactions, post-Mauryan transitions, or regional impacts). Ensure these additions enhance variety while aligning with the chapter’s historical context.  
        - **Maximum Complexity and Depth**: Craft a challenging, unique MCQ that tests deep understanding, critical thinking, and analytical skills at an elite UPSC level. Dive into lesser-known aspects (e.g., specific officials, economic policies, cultural shifts) to surprise and engage users.  
        - **Accuracy Assurance**: Verify the factual correctness of the question, options, and answer. Cross-check historical details and ensure the correct option aligns with the explanation, avoiding errors or mismatches.  

        **UPSC Structure to Use:**  
        - Use the following UPSC structure for this MCQ:  
          - **Structure Name**: ${selectedStructure.name}  
          - **Example**: ${selectedStructure.example}  
          - **Options**: ${selectedStructure.options.join(", ")}  
        - Adapt the deeply researched content to fit this structure creatively and precisely.  

        **Response Structure:**  
        - Use this EXACT structure for the response with PLAIN TEXT headers:  
          Question: [Full question text, following the selected UPSC structure, rich with depth and complexity]  
          Options:  
          (a) [Option A]  
          (b) [Option B]  
          (c) [Option C]  
          (d) [Option D]  
          Correct Answer: [Correct option letter, e.g., (a)]  
          Explanation: [Detailed explanation, 3-5 sentences, weaving chapter content with broader knowledge, justifying the answer with precision and insight]  
        - Separate each section with EXACTLY TWO newlines (\n\n).  
        - Start the response directly with "Question:"—do NOT include any introductory text.  
        - Use plain text headers ("Question:", "Options:", "Correct Answer:", "Explanation:") without any formatting.  

        **Special Instructions for Specific Categories:**  
        - For "Science": Focus on the Science section of the Disha IAS Previous Year Papers (File ID: ${fileIds.Science}), extrapolating to cutting-edge historical contexts.  
        - For "CSAT": Use the CSAT section (File ID: ${fileIds.CSAT}), integrating complex logical extensions.  
        - For "PreviousYearPaper": Base on the entire Disha IAS book (File ID: ${fileIds.PreviousYearPaper}), weaving in advanced interpretations.  
        - For "Atlas": Since the file is pending, respond with: "File for Atlas is not available. MCQs cannot be generated at this time."  

        **Now, generate a response based on the book: "${bookInfo.bookName}" (File ID: ${fileId}) using the "${selectedStructure.name}" structure, ensuring diverse coverage of "${chapter}":**  
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

      // Extract the main topic from the question for tracking (simplified heuristic)
      const topicMatch = responseText.match(/Question:.*?([A-Za-z\s]+(?:Empire|dynasty|War|edicts|administration))/i);
      const newTopic = topicMatch ? topicMatch[1].trim() : "Unknown Topic";
      prevTopics.push(newTopic);
      if (prevTopics.length > 5) prevTopics.shift(); // Keep last 5 topics
      previousTopics.set(questionCountKey, prevTopics);

      console.log(`AI Response for userId ${userId}, chapter ${chapter}: ${responseText}`);

    } finally {
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