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

// Map categories to their respective books and file IDs
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

// Function to validate the MCQ structure
const validateMCQStructure = (responseText, selectedStructure) => {
  const sections = responseText.split(/\n\n/).map(section => section.trim());
  const questionSection = sections.find(section => section.startsWith("Question:"))?.replace("Question: ", "");
  const questionLines = questionSection ? questionSection.split("\n").map(line => line.trim()) : [];

  switch (selectedStructure) {
    case "Statement-Based":
    case "Multiple Statements with Specific Combinations":
      return (
        questionLines.some(line => /^\d+\./.test(line)) &&
        (questionLines.some(line => line.includes("Which of the statements given above is/are correct?")) ||
         questionLines.some(line => line.includes("How many of the above statements are correct?")))
      );
    case "Assertion-Reason":
      return (
        questionLines.some(line => line.startsWith("Assertion (A):")) &&
        questionLines.some(line => line.startsWith("Reason (R):"))
      );
    case "Matching Type":
    case "Correctly Matched Pairs":
      return (
        questionLines.some(line => line.includes("    ")) &&
        questionLines.some(line => /^\([A-D]\)/.test(line))
      );
    case "Chronological Order":
      return (
        questionLines.some(line => line.includes("Arrange the following")) &&
        questionLines.some(line => line.includes("chronological order"))
      );
    case "Direct Question with Single Correct Answer":
      return !(
        questionLines.some(line => /^\d+\./.test(line)) ||
        questionLines.some(line => line.startsWith("Assertion (A):")) ||
        questionLines.some(line => line.includes("    ")) ||
        questionLines.some(line => line.includes("Arrange the following"))
      );
    default:
      return false;
  }
};

app.post("/ask", async (req, res) => {
  try {
    const { query, category, userId } = req.body;
    console.log(`🔹 Received Query from User ${userId}: ${query}`);

    // Validate category
    if (!categoryToBookMap[category]) {
      throw new Error(`Invalid category: ${category}. Please provide a valid subject category.`);
    }

    const bookInfo = categoryToBookMap[category];
    const fileId = bookInfo.fileId;

    // Check if the file ID is valid for processing
    if (!fileId || fileId === "pending" || fileId.startsWith("[TBD")) {
      throw new Error(
        `File for category ${category} is not available (File ID: ${fileId}). MCQs cannot be generated.`
      );
    }

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

    // Construct structure-specific prompt
    let structurePrompt = "";
    switch (selectedStructure) {
      case "Statement-Based":
        structurePrompt = `
          Generate the MCQ in the Statement-Based format with numbered statements followed by "How many of the above statements are correct?" or "Which of the statements given above is/are correct?".  
          Provide options like:  
          (a) Only one  
          (b) Only two  
          (c) All three  
          (d) None  
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
        `;
        break;
      case "Assertion-Reason":
        structurePrompt = `
          Generate the MCQ in the Assertion-Reason format with two statements labeled "Assertion (A)" and "Reason (R)".  
          Provide options like:  
          (a) Both A and R are true, and R is the correct explanation of A  
          (b) Both A and R are true, but R is NOT the correct explanation of A  
          (c) A is true, but R is false  
          (d) A is false, but R is true  
          Example:  
          Question:  
          Assertion (A): The Indian National Congress adopted the policy of non-cooperation in 1920.  
          Reason (R): The Rowlatt Act and Jallianwala Bagh massacre created widespread discontent.  
          Options:  
          (a) Both A and R are true, and R is the correct explanation of A  
          (b) Both A and R are true, but R is NOT the correct explanation of A  
          (c) A is true, but R is false  
          (d) A is false, but R is true  
          Correct Answer: (a)  
          Explanation: The Rowlatt Act (1919) and the Jallianwala Bagh massacre (1919) led to widespread discontent, which prompted the Indian National Congress to adopt the Non-Cooperation Movement in 1920 under Mahatma Gandhi's leadership. Thus, R correctly explains A.
        `;
        break;
      case "Matching Type":
        structurePrompt = `
          Generate the MCQ in the Matching Type format with a table-like structure (e.g., Constitutional Provisions    Emergency Type) where the user must match items from two columns.  
          Provide options like:  
          (a) A-2, B-3, C-1  
          (b) A-1, B-2, C-3  
          (c) A-2, B-1, C-3  
          (d) A-3, B-2, C-1  
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
        `;
        break;
      case "Multiple Statements with Specific Combinations":
        structurePrompt = `
          Generate the MCQ in the Multiple Statements with Specific Combinations format with numbered statements followed by options specifying combinations.  
          Provide options like:  
          (a) 1 and 2 only  
          (b) 2 and 3 only  
          (c) 1 and 3 only  
          (d) 1, 2, and 3  
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
        `;
        break;
      case "Chronological Order":
        structurePrompt = `
          Generate the MCQ in the Chronological Order format with a list of events or items to be arranged in chronological order.  
          Provide options like:  
          (a) 3, 1, 2  
          (b) 2, 1, 3  
          (c) 1, 3, 2  
          (d) 3, 2, 1  
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
        `;
        break;
      case "Correctly Matched Pairs":
        structurePrompt = `
          Generate the MCQ in the Correctly Matched Pairs format with a list of pairs (e.g., Festival    State) followed by a question asking which pairs are correctly matched.  
          Provide options like:  
          (a) A only  
          (b) A and B only  
          (c) B and C only  
          (d) A, B, and C  
          Example:  
          Question: Consider the following pairs:  
          Festival    State  
          (A) Chapchar Kut    Nagaland  
          (B) Wangala    Meghalaya  
          (C) Losar    Arunachal Pradesh  
          Which of the pairs are correctly matched?  
          Options:  
          (a) A only  
          (b) B and C only  
          (c) A and C only  
          (d) A, B, and C  
          Correct Answer: (b)  
          Explanation: Chapchar Kut is a festival of Mizoram, not Nagaland, so (A) is incorrect. Wangala is correctly matched with Meghalaya, and Losar is correctly matched with Arunachal Pradesh. Thus, only B and C are correctly matched.
        `;
        break;
      case "Direct Question with Single Correct Answer":
        structurePrompt = `
          Generate the MCQ in the Direct Question with Single Correct Answer format with a single question and four options, where one is correct.  
          Provide options like:  
          (a) [Option A]  
          (b) [Option B]  
          (c) [Option C]  
          (d) [Option D]  
          Example:  
          Question: Which one of the following is a tributary of the Brahmaputra?  
          Options:  
          (a) Gandak  
          (b) Kosi  
          (c) Subansiri  
          (d) Yamuna  
          Correct Answer: (c)  
          Explanation: The Subansiri is a major tributary of the Brahmaputra, joining it in Assam. The Gandak and Kosi are tributaries of the Ganga, and the Yamuna is a tributary of the Ganga as well.
        `;
        break;
    }

    const generalInstruction = `
      You are an AI trained exclusively on UPSC Books for the TrainWithMe platform.

      📚 Reference Book for This Query:  
      - Category: ${category}  
      - Book: ${bookInfo.bookName}  
      - File ID: ${fileId}  
      - Description: ${bookInfo.description}  

      **General Instructions:**  
      - Answer ONLY from the specified book (${bookInfo.bookName}) using the attached file (File ID: ${fileId}).  
      - DO NOT use external sources, general knowledge, or any other files—rely solely on the specified file for the requested category.  
      - If the requested chapter or content is not found in the specified file, respond with an error message: "Content not found in ${bookInfo.bookName}. Please check the chapter or try a different query."  
      - Make responses engaging with emojis, highlights, and structured formatting.  
      - DO NOT use markdown symbols like #, *, or - in the final response text (convert them to plain text).  
      - If the user asks for MCQs, generate them from the requested book ONLY using the attached file.  
      - Ensure MCQs are difficult (but do not mention this to the user).  
      - If the user asks for notes, provide concise, factual notes (1/3 of chapter length).  

      **Instructions for MCQ Generation (Applies to All Subjects):**  
      - For queries requesting an MCQ, generate 1 MCQ from the specified book (${bookInfo.bookName}) and chapter (or the entire book if no chapter is specified) using the attached file (File ID: ${fileId}).  
      - The MCQ MUST follow the UPSC-style format specified below.  
      - The MCQ MUST be in the following structure: ${selectedStructure}  
      ${structurePrompt}
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
      - Separate each section with EXACTLY TWO newlines (\n\n).  
      - Start the response directly with "Question:"—do NOT include any introductory text like "UPSC-style MCQ" or "**Question:**".  
      - Use plain text headers ("Question:", "Options:", "Correct Answer:", "Explanation:") without any formatting (e.g., no **, *, or underscores).  
      - For Matching Type and Correctly Matched Pairs questions, format the list as a simple text table with each pair on a new line (e.g., "(A) Item  (1) Match").  

      **Special Instructions for Specific Categories:**  
      - For "Science": Generate MCQs only from the Science section (Physics, Chemistry, Biology, Science & Technology) of the Disha IAS Previous Year Papers book (File ID: ${fileIds.Science}).  
      - For "CSAT": Generate MCQs only from the CSAT section of the Disha IAS Previous Year Papers book (File ID: ${fileIds.CSAT}).  
      - For "PreviousYearPaper": Generate MCQs from the entire Disha IAS Previous Year Papers book (File ID: ${fileIds.PreviousYearPaper}), covering all relevant sections.  
      - For "Atlas": Since the file is pending, respond with an error message: "File for Atlas is not available. MCQs cannot be generated at this time."  

      **Now, generate a response based on the book: "${bookInfo.bookName}" (File ID: ${fileId}):**  
      "${query}"
    `;

    let responseText = "";
    let retryCount = 0;
    const maxRetries = 2;

    while (retryCount <= maxRetries) {
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

      // Validate the response structure
      const isValidStructure = validateMCQStructure(responseText, selectedStructure);
      if (isValidStructure) {
        break; // Response matches the selected structure, proceed
      } else {
        console.log(`⚠️ Response does not match ${selectedStructure} structure, retrying (${retryCount + 1}/${maxRetries})...`);
        retryCount++;
        if (retryCount > maxRetries) {
          throw new Error(`❌ Failed to generate MCQ in ${selectedStructure} format after ${maxRetries} retries.`);
        }
      }
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