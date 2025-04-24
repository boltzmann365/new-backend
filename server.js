const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const { MongoClient } = require("mongodb");

dotenv.config();
const app = express();

// CORS Configuration
const allowedOrigins = ["https://trainwithme.in", "http://localhost:3000"];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

app.use((err, req, res, next) => {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  console.error(`Error in request to ${req.path}:`, err.message);
  res.status(500).  res.status(500).json({ error: "Internal Server Error", details: err.message });
});

app.use((req, res, next) => {
  console.log(`Request: ${req.method} ${req.path}, Origin: ${req.headers.origin}`);
  next();
});

app.use(express.json());

// OpenAI API Setup
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" }
});

const assistantId = process.env.ASSISTANT_ID;

// MongoDB Setup
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("Error: MONGODB_URI environment variable is not set.");
  process.exit(1);
}
const client = new MongoClient(uri);
let db;
let mongoConnected = false;

async function connectToMongoDB() {
  if (mongoConnected) return;
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    db = client.db("trainwithme");
    mongoConnected = true;
    await db.collection("mcqs").createIndex({ book: 1, category: 1, chapter: 1 });
    await db.collection("battleground_rankings").createIndex({ score: -1, date: 1 });
    // Add index for users collection
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error.message);
    mongoConnected = false;
  }
}

connectToMongoDB();

// File IDs for Reference Books
const fileIds = {
  TamilnaduHistory: "file-UyQKVs91xYHfadeHSjdDw2",
  Spectrum: "file-UwRi9bH3uhVh4YBXNbMv1w",
  ArtAndCulture: "file-Gn3dsACNC2MP2xS9QeN3Je",
  FundamentalGeography: "file-CMWSg6udmgtVZpNS3tDGHW",
  IndianGeography: "file-YaaLnGG93PF9DgMsEGcrEN",
  Science: "file-TGgc65bHqVMxpmj5ULyR6K",
  Environment: "file-Yb1cfrHMATDNQgyUa6jDqw",
  Economy: "file-TJ5Djap1uv4fZeyM5c6sKU",
  EconomicSurvey2025: "[TBD - Economic Survey file ID]",
  CSAT: "file-TGgc65bHqVMxpmj5ULyR6K",
  CurrentAffairs: "file-5BX6sBLZ2ws44NBUTbcyWg",
  PreviousYearPapers: "file-TGgc65bHqVMxpmj5ULyR6K",
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
  PreviousYearPapers: {
    bookName: "Disha Publication’s UPSC Prelims Previous Year Papers",
    fileId: fileIds.PreviousYearPapers,
    description: "Disha IAS book for Previous Year Papers"
  },
  Polity: {
    bookName: "Laxmikanth Book",
    fileId: fileIds.Polity,
    description: "Laxmikanth book for Indian Polity"
  }
};

// Store user threads, question counts, last used structure, and used themes
const userThreads = new Map();
const questionCounts = new Map();
const lastUsedStructure = new Map();
const threadLocks = new Map();
const usedThemes = new Map();

// Load themes from MongoDB for a specific category
async function loadThemes(category) {
  if (!mongoConnected) {
    console.warn(`MongoDB not connected, cannot load themes for ${category}`);
    return {};
  }
  try {
    const collection = db.collection("book_themes");
    const themes = await collection.find({ category }).toArray();
    const themesObject = {};
    themes.forEach(theme => {
      themesObject[theme.chapter] = {
        themes: theme.themes,
        last_updated: theme.last_updated
      };
    });
    console.log(`Loaded ${Object.keys(themesObject).length} chapters with themes for ${category}`);
    return themesObject;
  } catch (error) {
    console.error(`Error loading themes for ${category} from MongoDB:`, error.message);
    return {};
  }
}

// Save themes to MongoDB for a specific category
async function saveThemes(category, themes) {
  if (!mongoConnected) {
    console.warn(`MongoDB not connected, cannot save themes for ${category}`);
    return;
  }
  try {
    const collection = db.collection("book_themes");
    await collection.deleteMany({ category });
    const themeDocs = Object.entries(themes).map(([chapter, data]) => ({
      category,
      chapter,
      themes: data.themes,
      last_updated: data.last_updated
    }));
    if (themeDocs.length > 0) {
      await collection.insertMany(themeDocs);
    }
    console.log(`Themes saved to MongoDB for ${category}`);
  } catch (error) {
    console.error(`Error saving themes for ${category}:`, error.message);
  }
}

// Extract themes from the chapter and save to MongoDB
const extractThemes = async (threadId, chapter, fileId, category) => {
  let themeInstruction;
  if (category === "Polity") {
    themeInstruction = `
      Analyze the content of "${chapter}" from Laxmikanth's Indian Polity book (File ID: ${fileId}). Extract a comprehensive list of themes, subthemes, and sub-subthemes covering its full scope, focusing on the historical development of the Indian Constitution, colonial administration, and legislative reforms. Examples include: colonial rule (e.g., Regulating Act 1773, Pitt’s India Act), Government of India Acts (e.g., 1858, 1919, 1935), Indian National Movement (e.g., INC formation, Simon Commission), and constitutional developments (e.g., Cripps Mission, Cabinet Mission). Provide the list in a simple format: "Theme: [theme] - Subtheme: [subtheme] - Sub-subtheme: [sub-subtheme]". Ensure all major aspects are included, and prioritize explicit topics from the chapter. Return only the list, no additional text.
    `;
  } else {
    themeInstruction = `
      Analyze the content of "${chapter}" from the ${categoryToBookMap[category].bookName} (File ID: ${fileId}). Extract a comprehensive list of themes, subthemes, and sub-subthemes covering its full scope (e.g., invasions, governance, culture, economy, dynasties, decline for history; physiography, climate, drainage for geography; mechanics, thermodynamics for physics). Provide the list in a simple format: "Theme: [theme] - Subtheme: [subtheme] - Sub-subtheme: [sub-subtheme]". Ensure all major aspects are included, and use your understanding to identify both explicit and implicit topics. Return only the list, no additional text.
    `;
  }

  console.log(`Extracting themes for chapter: ${chapter} in ${category}`);
  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: themeInstruction,
  });

  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: assistantId,
    tools: [{ type: "file_search" }],
  });

  await waitForRunToComplete(threadId, run.id);
  const messages = await openai.beta.threads.messages.list(threadId);
  const latestMessage = messages.data.find(m => m.role === "assistant");
  const themeText = latestMessage?.content[0]?.text?.value || "";
  const themes = themeText.split("\n").filter(line => line.trim()).map(line => line.trim());

  if (mongoConnected) {
    const allThemes = await loadThemes(category);
    allThemes[chapter || "entire-book"] = {
      themes,
      last_updated: new Date().toISOString()
    };
    await saveThemes(category, allThemes);
  }

  console.log(`Extracted ${themes.length} themes for ${chapter} in ${category}`);
  return themes;
};

// New endpoint to fetch chapters with themes
app.post("/available-chapters", async (req, res) => {
  try {
    const { category } = req.body;
    if (!category || !categoryToBookMap[category]) {
      return res.status(400).json({ error: "Invalid or missing category" });
    }
    const allThemes = await loadThemes(category);
    const chapters = Object.keys(allThemes).filter(ch => ch !== "entire-book");
    res.json({ chapters });
  } catch (error) {
    console.error(`Error in /available-chapters for category=${req.body.category || 'unknown'}:`, error.message);
    res.status(500).json({ error: "Failed to fetch available chapters", details: error.message });
  }
});

// Migrate existing themes to MongoDB (for manual use only)
async function migrateThemesToMongoDB() {
  if (!mongoConnected) {
    console.warn("MongoDB not connected, skipping theme migration");
    return;
  }
  const categories = Object.keys(categoryToBookMap);
  console.log(`Categories to migrate themes: ${categories.join(", ")}`);
  for (const category of categories) {
    try {
      let themes = {};
      let defaultChapter;
      if (category === "Polity") {
        defaultChapter = "Chapter 1 Historical Background";
      } else if (category === "ArtAndCulture") {
        defaultChapter = "Chapter 1 Indian Architecture, Sculpture and Pottery";
      } else if (category === "FundamentalGeography") {
        defaultChapter = "Chapter 1 Geography as a Discipline";
      } else if (category === "IndianGeography") {
        defaultChapter = "Chapter 1 India- Location";
      } else if (category === "TamilnaduHistory") {
        defaultChapter = "Unit 1 Early India: From the Beginnings to the Indus Civilisation";
      } else if (category === "Science") {
        defaultChapter = "Chapter 1 Physics";
      } else if (category === "Environment") {
        defaultChapter = "Chapter 1 Ecology";
      } else if (category === "Economy") {
        defaultChapter = "Chapter 1 Introduction";
      } else if (category === "CSAT") {
        defaultChapter = "Chapter 1 Comprehension";
      } else if (category === "CurrentAffairs") {
        defaultChapter = "Chapter 1 Polity and Governance";
      } else if (category === "PreviousYearPapers") {
        defaultChapter = "Chapter 1 History";
      } else {
        console.log(`No default chapter for ${category}, skipping migration`);
        continue;
      }
      let threadId = userThreads.get("migration-thread");
      if (!threadId) {
        const thread = await openai.beta.threads.create();
        threadId = thread.id;
        userThreads.set("migration-thread", threadId);
      }
      const themesList = await extractThemes(threadId, defaultChapter, fileIds[category], category);
      themes[defaultChapter] = {
        themes: themesList,
        last_updated: new Date().toISOString()
      };
      await saveThemes(category, themes);
      console.log(`Migrated themes for ${category} to MongoDB`);
    } catch (error) {
      console.error(`Error migrating themes for ${category}:`, error.message);
    }
  }
}

// Manual migration endpoint (optional)
app.get("/migrate-themes", async (req, res) => {
  try {
    await migrateThemesToMongoDB();
    res.json({ message: "Theme migration completed" });
  } catch (error) {
    console.error("Error in /migrate-themes:", error.message);
    res.status(500).json({ error: "Migration failed", details: error.message });
  }
});

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
    console.log(`✅ Assistant ${assistantId} updated with vector store ID: ${vectorStore.id}`);
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
    options: {
      four: ["(a) Only one", "(b) Only two", "(c) Only three", "(d) All four"],
      three: ["(a) None", "(b) Only one", "(c) Only two", "(d) All three"]
    }
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
    name: "Single Correct Answer",
    example: "Which one of the following is [Question]?",
    options: ["(a) [Option A]", "(b) [Option B]", "(c) [Option C]", "(d) [Option D]"]
  },
  {
    name: "Multiple Statements - Which Correct",
    example: "With reference to [Topic], consider the following statements: ... Which of the statements given above is/are correct?",
    options: ["(a) 1 and 2 only", "(b) 3 only", "(c) 1 and 3 only", "(d) 1, 2, and 3"]
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

// Map chapter names to their unit numbers for consistency
const chapterToUnitMap = {
  // Tamilnadu History
  "Early India: From the Beginnings to the Indus Civilisation": "Unit 1",
  "Early India: The Chalcolithic, Megalithic, Iron Age and Vedic Cultures": "Unit 2",
  "Rise of Territorial Kingdoms and New Religious Sects": "Unit 3",
  "Emergence of State and Empire": "Unit 4",
  "Evolution of Society in South India": "Unit 5",
  "Polity and Society in Post-Mauryan Period": "Unit 6",
  "The Guptas": "Unit 7",
  "Harsha and Rise of Regional Kingdoms": "Unit 8",
  "Cultural Development in South India": "Unit 9",
  "Advent of Arabs and Turks": "Unit 10",
  "Later Cholas and Pandyas": "Unit 11",
  "Bahmani and Vijayanagar Kingdoms": "Unit 12",
  "Cultural Syncretism: Bhakti Movement in India": "Unit 13",
  "The Mughal Empire": "Unit 14",
  "The Marathas": "Unit 15",
  "The Coming of the Europeans": "Unit 16",
  "Effects of British Rule": "Unit 17",
  "Early Resistance to British Rule": "Unit 18",
  "Towards Modernity": "Unit 19",
  // Spectrum
  "Sources for the History of Modern India": "Unit 1",
  "Major Approaches to the History of Modern India": "Unit 2",
  "Advent of the Europeans in India": "Unit 3",
  "India on the Eve of British Conquest": "Unit 4",
  "Expansion and Consolidation of British Power in India": "Unit 5",
  "People’s Resistance Against British Before 1857": "Unit 6",
  "The Revolt of 1857": "Unit 7",
  "Socio-Religious Reform Movements: General Features": "Unit 8",
  "A General Survey of Socio-Cultural Reform Movements": "Unit 9",
  "Beginning of Modern Nationalism in India": "Unit 10",
  "Indian National Congress: Foundation and the Moderate Phase": "Unit 11",
  "Era of Militant Nationalism (1905-1909)": "Unit 12",
  "First Phase of Revolutionary Activities (1907-1917)": "Unit 13",
  "First World War and Nationalist Response": "Unit 14",
  "Emergence of Gandhi": "Unit 15",
  "Non-Cooperation Movement and Khilafat Aandolan": "Unit 16",
  "Emergence of Swarajists, Socialist Ideas, Revolutionary Activities and Other New Forces": "Unit 17",
  "Simon Commission and the Nehru Report": "Unit 18",
  "Civil Disobedience Movement and Round Table Conferences": "Unit 19",
  "Debates on the Future Strategy after Civil Disobedience Movement": "Unit 20",
  "Congress Rule in Provinces": "Unit 21",
  "Nationalist Response in the Wake of World War II": "Unit 22",
  "Quit India Movement, Demand for Pakistan, and the INA": "Unit 23",
  "Post-War National Scenario": "Unit 24",
  "Independence with Partition": "Unit 25",
  "Constitutional, Administrative and Judicial Developments": "Unit 26",
  "Survey of British Policies in India": "Unit 27",
  "Economic Impact of British Rule in India": "Unit 28",
  "Development of Indian Press": "Unit 29",
  "Development of Education": "Unit 30",
  "Peasant Movements 1857-1947": "Unit 31",
  "The Movement of the Working Class": "Unit 32",
  "Challenges Before the New-born Nation": "Unit 33",
  "The Indian States": "Unit 34",
  "Making of the Constitution for India": "Unit 35",
  "The Evolution of Nationalist Foreign Policy": "Unit 36",
  "First General Elections": "Unit 37",
  "Developments under Nehru’s Leadership (1947-64)": "Unit 38",
  "After Nehru": "Unit 39",
  "Personalities Associated with Specific Movements": "Appendix 1",
  "Governors-General and Viceroys of India: Significant Events in their Rule": "Appendix 2",
  "Indian National Congress Annual Sessions": "Appendix 3",
  "Socio-Religious Reform Movements (late 18th to mid-20th century)": "Appendix 4",
  "Famous Trials of the Nationalist Period": "Appendix 5",
  "Caste Movements": "Appendix 6",
  "Peasant Movements": "Appendix 7",
  "Newspapers and Journals": "Appendix 8",
  // Art and Culture
  "Indian Architecture, Sculpture and Pottery": "Chapter 1",
  "Indian Paintings": "Chapter 2",
  "Indian Handicrafts": "Chapter 3",
  "UNESCO’S List of World Heritage Sites in India": "Chapter 4",
  "Indian Music": "Chapter 5",
  "Indian Dance Forms": "Chapter 6",
  "Indian Theatre": "Chapter 7",
  "Indian Puppetry": "Chapter 8",
  "Indian Circus": "Chapter 9",
  "Martial Arts in India": "Chapter 10",
  "UNESCO’S List of Intangible Cultural Heritage": "Chapter 11",
  "Languages in India": "Chapter 12",
  "Religion in India": "Chapter 13",
  "Buddhism and Jainism": "Chapter 14",
  "Indian Literature": "Chapter 15",
  "Schools of Philosophy": "Chapter 16",
  "Indian Cinema": "Chapter 17",
  "Science and Technology through the Ages": "Chapter 18",
  "Calendars in India": "Chapter 19",
  "Fairs and Festivals of India": "Chapter 20",
  "Awards and Honours": "Chapter 21",
  "Law and Culture": "Chapter 22",
  "Cultural Institutions in India": "Chapter 23",
  "Coins in Ancient and Medieval India": "Chapter 24",
  "Indian Culture Abroad": "Chapter 25",
  "India through the Eyes of Foreign Travellers": "Chapter 26",
  "Delhi - A City of Seven Sisters": "Appendix-1",
  "Bhakti and Sufi Movement": "Appendix-2",
  "Famous Personalities of India": "Appendix-3",
  "Recent Geographical Indications": "Appendix-4",
  "Indian Art and Culture (Current Affairs)": "Appendix-5",
  // Fundamental Geography
  "Geography as a Discipline": "Chapter 1",
  "The Origin and Evolution of Earth": "Chapter 2",
  "Interior of the Earth": "Chapter 3",
  "Distribution of Oceans and Continents": "Chapter 4",
  "Minerals and Rocks": "Chapter 5",
  "Geomorphic Processes": "Chapter 6",
  "Landforms and their Evolution": "Chapter 7",
  "Composition and Structure of Atmosphere": "Chapter 8",
  "Solar Radiation, Heat Balance and Temperature": "Chapter 9",
  "Atmospheric Circulation and Weather Systems": "Chapter 10",
  "Water in the Atmosphere": "Chapter 11",
  "World Climate and Climate Change": "Chapter 12",
  "Water (Oceans)": "Chapter 13",
  "Movements of Ocean Water": "Chapter 14",
  "Life on the Earth": "Chapter 15",
  "Biodiversity and Conservation": "Chapter 16",
  // Indian Geography
  "India- Location": "Chapter 1",
  "Structure and Physiography": "Chapter 2",
  "Drainage System": "Chapter 3",
  "Climate": "Chapter 4",
  "Natural Vegetation": "Chapter 5",
  "Soils": "Chapter 6",
  "Natural Hazards and Disasters": "Chapter 7",
  "States, Their Capitals, Number of Districts, Area and Population": "Appendix I",
  "Union Territories, Their Capitals, Area and Population": "Appendix II",
  "Important River Basins": "Appendix III",
  "State/Union Territory Wise Forest Cover": "Appendix IV",
  "National Parks of India": "Appendix V",
  // Science
  "Physics": "Chapter 1",
  "Chemistry": "Chapter 2",
  "Biology": "Chapter 3",
  "Science and Technology": "Chapter 4",
  // Environment
  "Ecology": "Chapter 1",
  "Ecosystem": "Chapter 2",
  "Biodiversity": "Chapter 3",
  "Conservation": "Chapter 4",
  // Economy
  "Introduction": "Chapter 1",
  "Growth, Development and Happiness": "Chapter 2",
  "Evolution of the Indian Economy": "Chapter 3",
  "Economic Planning": "Chapter 4",
  "Planning in India": "Chapter 5",
  "Economic Reforms": "Chapter 6",
  "Inflation and Business Cycle": "Chapter 7",
  "Agriculture and Food Management": "Chapter 8",
  "Industry and Infrastructure": "Chapter 9",
  "Services Sector": "Chapter 10",
  "Indian Financial Market": "Chapter 11",
  "Banking in India": "Chapter 12",
  "Insurance in India": "Chapter 13",
  "Security Market in India": "Chapter 14",
  "External Sector in India": "Chapter 15",
  "International Economic Organisations and India": "Chapter 16",
  "Tax Structure in India": "Chapter 17",
  "Public Finance in India": "Chapter 18",
  "Sustainability and Climate Change: India and the World": "Chapter 19",
  "Human Development in India": "Chapter 20",
  "Burning Socio-Economic Issues": "Chapter 21",
  "Economic Concepts and Terminologies": "Chapter 22",
  // CSAT
  "Comprehension": "Chapter 1",
  "Interpersonal Skills Including Communication Skills": "Chapter 2",
  "Logical Reasoning and Analytical Ability": "Chapter 3",
  "Decision Making and Problem Solving": "Chapter 4",
  "General Mental Ability": "Chapter 5",
  "Basic Numeracy": "Chapter 6",
  "Data Interpretation": "Chapter 7",
  // CurrentAffairs
  "Polity and Governance": "Chapter 1",
  "International Relations": "Chapter 2",
  "Economy": "Chapter 3",
  "Security": "Chapter 4",
  "Environment": "Chapter 5",
  "Social Issues": "Chapter 6",
  "Science and Technology": "Chapter 7",
  "Culture": "Chapter 8",
  "Ethics": "Chapter 9",
  "Schemes in News": "Chapter 10",
  "Places in News": "Chapter 11",
  "Personalities in News": "Chapter 12",
  // PreviousYearPapers
  "History": "Chapter 1",
  "Geography": "Chapter 2",
  "Polity": "Chapter 3",
  "Economy": "Chapter 4",
  "Environment": "Chapter 5",
  "Science": "Chapter 6",
  // Polity (Laxmikanth's Indian Polity)
  "Historical Background": "Chapter 1",
  "Making of the Constitution": "Chapter 2",
  "Salient Features of the Constitution": "Chapter 3",
  "Preamble of the Constitution": "Chapter 4",
  "Union and Its Territory": "Chapter 5",
  "Citizenship": "Chapter 6",
  "Fundamental Rights": "Chapter 7",
  "Directive Principles of State Policy": "Chapter 8",
  "Fundamental Duties": "Chapter 9",
  "Amendment of the Constitution": "Chapter 10",
  "Basic Structure of the Constitution": "Chapter 11",
  "Parliamentary System": "Chapter 12",
  "Federal System": "Chapter 13",
  "Centre–State Relations": "Chapter 14",
  "Inter-State Relations": "Chapter 15",
  "Emergency Provisions": "Chapter 16",
  "President": "Chapter 17",
  "Vice-President": "Chapter 18",
  "Prime Minister": "Chapter 19",
  "Central Council of Ministers": "Chapter 20",
  "Cabinet Committees": "Chapter 21",
  "Parliament": "Chapter 22",
  "Parliamentary Committees": "Chapter 23",
  "Parliamentary Forums": "Chapter 24",
  "Parliamentary Group": "Chapter 25",
  "Supreme Court": "Chapter 26",
  "Judicial Review": "Chapter 27",
  "Judicial Activism": "Chapter 28",
  "Public Interest Litigation": "Chapter 29",
  "Governor": "Chapter 30",
  "Chief Minister": "Chapter 31",
  "State Council of Ministers": "Chapter 32",
  "State Legislature": "Chapter 33",
  "High Court": "Chapter 34",
  "Subordinate Courts": "Chapter 35",
  "Special Status of Jammu & Kashmir": "Chapter 36",
  "Special Provisions for Some States": "Chapter 37",
  "Panchayati Raj": "Chapter 38",
  "Municipalities": "Chapter 39",
  "Union Territories": "Chapter 40",
  "Scheduled and Tribal Areas": "Chapter 41",
  "Election Commission": "Chapter 42",
  "Union Public Service Commission": "Chapter 43",
  "State Public Service Commission": "Chapter 44",
  "Finance Commission": "Chapter 45",
  "Goods and Services Tax Council": "Chapter 46",
  "National Commission for SCs": "Chapter 47",
  "National Commission for STs": "Chapter 48",
  "National Commission for BCs": "Chapter 49",
  "Special Officer for Linguistic Minorities": "Chapter 50",
  "Comptroller and Auditor General of India": "Chapter 51",
  "Attorney General of India": "Chapter 52",
  "Advocate General of the State": "Chapter 53",
  "NITI Aayog": "Chapter 54",
  "National Human Rights Commission": "Chapter 55",
  "State Human Rights Commission": "Chapter 56",
  "Central Information Commission": "Chapter 57",
  "State Information Commission": "Chapter 58",
  "Central Vigilance Commission": "Chapter 59",
  "Central Bureau of Investigation": "Chapter 60",
  "Lokpal and Lokayuktas": "Chapter 61",
  "National Investigation Agency": "Chapter 62",
  "National Disaster Management Authority": "Chapter 63",
  "Co-operative Societies": "Chapter 64",
  "Official Language": "Chapter 65",
  "Public Services": "Chapter 66",
  "Rights and Liabilities of the Government": "Chapter 67",
  "Special Provisions Relating to Certain Classes": "Chapter 68",
  "Political Parties": "Chapter 69",
  "Role of Regional Parties": "Chapter 70",
  "Elections": "Chapter 71",
  "Election Laws": "Chapter 72",
  "Electoral Reforms": "Chapter 73",
  "Voting Behaviour": "Chapter 74",
  "Coalition Government": "Chapter 75",
  "Anti-Defection Law": "Chapter 76",
  "Pressure Groups": "Chapter 77",
  "National Integration": "Chapter 78",
  "Foreign Policy": "Chapter 79",
  "National Commission to Review the Working of the Constitution": "Chapter 80",
  "Appendix I: Articles of the Constitution (1–395)": "Appendix I",
  "Appendix II: Subjects of Union, State, and Concurrent Lists": "Appendix II",
  "Appendix III: Table of Precedence": "Appendix III",
  "Appendix IV: Constitutional Amendments at a Glance": "Appendix IV",
  "Appendix V: Presidents, Vice-Presidents, Prime Ministers, etc.": "Appendix V",
  "Appendix VI: UPSC Questions on Indian Polity (General Studies–Prelims)": "Appendix VI",
};

// Function to get the full chapter name (with unit) from a chapter key
const getFullChapterName = (chapterKey, category) => {
  const chapterMap = chapterToUnitMap;
  const bookName = categoryToBookMap[category].bookName;
  for (const [chapterName, unit] of Object.entries(chapterMap)) {
    const fullName = bookName.includes("Spectrum") || 
                    bookName.includes("Tamilnadu") || 
                    bookName.includes("Art and Culture") || 
                    bookName.includes("FundamentalGeography") || 
                    bookName.includes("IndianGeography") || 
                    bookName.includes("Science") ||
                    bookName.includes("Environment") ||
                    bookName.includes("Economy") ||
                    bookName.includes("CSAT") ||
                    bookName.includes("CurrentAffairs") ||
                    bookName.includes("PreviousYearPapers") ||
                    bookName.includes("Laxmikanth")
      ? `${unit} ${chapterName}`.trim()
      : chapterName;
    if (chapterKey === fullName || chapterKey === chapterName) {
      return fullName;
    }
  }
  return chapterKey;
};

// Fetch cached MCQs from MongoDB
async function fetchCachedMCQs(category, chapter, count) {
  if (!mongoConnected) {
    console.warn(`MongoDB not connected, cannot fetch cached MCQs for category=${category}, chapter=${chapter}`);
    return [];
  }
  try {
    let matchQuery = { category };
    if (chapter && chapter !== "entire-book") {
      matchQuery.chapter = chapter;
    }
    const cachedMCQs = await db.collection("mcqs").aggregate([
      { $match: matchQuery },
      { $sample: { size: count } }
    ]).toArray();
    console.log(`Fetched ${cachedMCQs.length} cached MCQ(s) for category=${category}, chapter=${chapter || 'any'}`);
    return cachedMCQs.map(m => m.mcq);
  } catch (error) {
    console.error(`Error fetching cached MCQs for category=${category}, chapter=${chapter}:`, error.message);
    return [];
  }
}

// Generate MCQs with cached fallback
async function generateMCQs(query, category, userId, count, chapter, retryCount = 0) {
  let threadId = userThreads.get(userId);
  if (!threadId) {
    const thread = await openai.beta.threads.create();
    threadId = thread.id;
    userThreads.set(userId, threadId);
  }

  await acquireLock(threadId);

  try {
    await waitForAllActiveRuns(threadId);

    const bookInfo = categoryToBookMap[category];
    const fileId = bookInfo.fileId;
    const bookName = bookInfo.bookName;

    console.log(`Generating ${count} MCQ${count > 1 ? 's' : ''}: category=${category}, userId=${userId}, chapter=${chapter || 'entire-book'}`);

    let selectedChapter = chapter;
    if (category === "Polity" && chapter) {
      const cleanChapter = chapter.replace(/^Chapter\s*\d+\s*/i, "").trim();
      const fullChapterName = Object.keys(chapterToUnitMap).find(
        (key) => key.toLowerCase() === cleanChapter.toLowerCase()
      );
      selectedChapter = fullChapterName ? getFullChapterName(fullChapterName, category) : chapter;
    } else if (category === "Economy" && chapter && chapter !== "entire-book") {
      const fullChapterName = Object.keys(chapterToUnitMap).find(
        (key) => chapter.toLowerCase().includes(key.toLowerCase())
      );
      selectedChapter = fullChapterName ? getFullChapterName(fullChapterName, category) : chapter;
    }

    const userIdParts = userId.split('-');
    const questionIndex = userIdParts.length > 1 ? parseInt(userIdParts[userIdParts.length - 1], 10) : 0;
    const baseUserId = userIdParts.slice(0, -1).join('-');
    const questionCountKey = `${baseUserId}:${selectedChapter || 'entire-book'}`;
    let questionCount = questionCounts.get(questionCountKey) || 0;
    questionCount++;
    questionCounts.set(questionCountKey, questionCount);

    const allThemes = await loadThemes(category);
    let themes = allThemes[selectedChapter]?.themes;
    if (!themes) {
      console.log(`No themes found for ${selectedChapter} in ${category}. Extracting...`);
      themes = await extractThemes(threadId, selectedChapter, fileIds[category], category);
    }
    if (!themes || themes.length === 0) {
      throw new Error(`No themes available for ${selectedChapter || 'entire-book'} in ${category}`);
    }

    let used = usedThemes.get(questionCountKey) || [];
    let availableThemes = themes.filter(t => !used.includes(t));
    if (availableThemes.length === 0) {
      used = [];
      availableThemes = themes;
    }

    const randomIndex = Math.floor(Math.random() * availableThemes.length);
    const selectedTheme = availableThemes[randomIndex];
    used.push(selectedTheme);
    usedThemes.set(questionCountKey, used);

    console.log(`Selected theme for question ${questionCount}: ${selectedTheme}`);

    const selectedStructure = chooseStructure(userId);

    let options = selectedStructure.options;
    if (selectedStructure.name === "Multiple Statements - How Many Correct") {
      options = selectedStructure.options.four;
    }

    if (!fileId || fileId === "pending" || fileId.startsWith("[TBD")) {
      throw new Error(`File for category ${category} is not available (File ID: ${fileId}). MCQs cannot be generated.`);
    }

    const generalInstruction = `
You are an AI designed to create an elite UPSC training camp for the TrainWithMe platform, delivering diverse, deeply researched, and accurate MCQs that captivate and challenge users. You have access to the uploaded book content (File ID: ${fileId}) and your extensive training data encompassing vast historical, philosophical, cultural, geographical, and scientific knowledge.

📚 Reference Book for This Query:  
- Category: ${category}  
- Book: ${bookInfo.bookName}  
- File ID: ${fileId}  
- Description: ${bookInfo.description}  

**Instructions for MCQ Generation:**  
- Generate ${count} MCQ${count > 1 ? 's' : ''} inspired by the specified chapter ("${selectedChapter || 'entire book'}") of the book (${bookInfo.bookName}).  
- **Theme-Based Focus**: Base this MCQ (question ${questionCount}) on the theme: "${selectedTheme}". Use the chapter content (File ID: ${fileId}) as the primary source, but interpret the theme broadly to include related subthemes or sub-subthemes.  
- **Even Distribution**: Avoid fixating on overused figures or events unless tied to "${selectedTheme}" in a fresh way. For science, avoid overused topics like Newton's laws unless uniquely relevant to "${selectedTheme}".  
- **Balance Thematic and Fact-Based Questions**: Ensure a 20/80 mix of thematic questions (testing conceptual understanding, e.g., thermodynamics principles) and fact-based questions (testing specific details, e.g., "The atomic number of Carbon is...").give fact based question more priority. Include precise data like scientific constants, formulas, or discoveries from the chapter where applicable.  
- **Maximum Complexity and Unpredictability**: Craft challenging, unique MCQs that test deep understanding, critical thinking, and analytical skills at an elite UPSC level. Avoid predictable patterns:
  - For "Multiple Statements - How Many Correct," ensure correct answers are evenly distributed (e.g., "only one" as likely as "only two" or "only three"). Include subtle distractors and false statements to make "only one" or "none" viable.
  - For "Assertion and Reason," create nuanced assertions and reasons with complex relationships (e.g., partial truths, misleading reasons) to avoid obvious answers like option A. Vary correct options (a, b, c, d) evenly.
- **Accuracy Assurance**: Verify the factual correctness of each question, options, and answer. Cross-check scientific details and ensure the correct option aligns perfectly with the explanation. The explanation must justify why the selected option is true and others are false.  
- **Three-Statement Handling**: For "Multiple Statements - How Many Correct" with three statements, use options: "(a) None," "(b) Only one," "(c) Only two," "(d) All three." Generate questions where "None" can be correct by including deliberately false statements.  

**UPSC Structure to Use:**  
- Use the following UPSC structure for each MCQ:  
  - **Structure Name**: ${selectedStructure.name}  
  - **Example**: ${selectedStructure.example}  
  - **Options**: ${options.join(", ")} (For "Multiple Statements - How Many Correct," adjust to three-statement options if applicable)  
- Adapt the deeply researched content to fit this structure creatively and precisely.  

**Response Structure:**  
- For each MCQ, use this EXACT structure with PLAIN TEXT headers:  
  Question: [Full question text, following the selected UPSC structure, rich with depth and complexity]  
  Options:  
  (a) [Option A]  
  (b) [Option B]  
  (c) [Option C]  
  (d) [Option D]  
  Correct Answer: [Single lowercase letter: a, b, c, or d, corresponding to the correct option. Do NOT include parentheses, phrases like "Only two," or any text beyond the single letter. For "Multiple Statements - How Many Correct," the Correct Answer must be the letter matching the correct option (e.g., 'c' for '(c) Only two').]  
  Explanation: [Detailed explanation, 3-5 sentences, weaving chapter content with broader knowledge, justifying why the selected option is correct and others are incorrect. Conclude with: "Thus, the correct answer is (option letter) because [reason]."]  
- Separate each section with EXACTLY TWO newlines (\n\n).  
- For multiple MCQs, separate each MCQ with "----" on a new line.  
- Start the response directly with "Question:"—do NOT include any introductory text.  
- **Special Note for Single Correct Answer Structure**: Include the statements (A-D) directly under the Question text, each statement on a new line.  
- **Special Note for Multiple Statements Structures**: List the statements under the Question text using decimal numbers (e.g., "1.", "2.", "3.", "4."), each statement on a new line. For three statements, use options: "(a) None," "(b) Only one," "(c) Only two," "(d) All three."  

**Special Instructions for Specific Categories:**  
- For "Polity": Use the Laxmikanth's Indian Polity book (File ID: ${fileIds.Polity}), ensuring questions cover constitutional framework, governance, and political dynamics comprehensively.  
- For "Science": Focus on the Science section of the Disha IAS Previous Year Papers (File ID: ${fileIds.Science}), covering Physics, Chemistry, Biology, and Science & Technology, extrapolating to cutting-edge historical contexts.  
- For "CSAT": Use the CSAT section (File ID: ${fileIds.CSAT}), integrating complex logical extensions.  
- For "PreviousYearPapers": Base on the entire Disha IAS book (File ID: ${fileIds.PreviousYearPapers}), weaving in advanced interpretations.  

**Now, generate ${count} MCQ${count > 1 ? 's' : ''} based on the book: "${bookInfo.bookName}" (File ID: ${fileId}) using the "${selectedStructure.name}" structure, focusing on "${selectedTheme}" within "${selectedChapter || 'entire book'}":**
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
      throw new Error("Failed to create AI run. Check OpenAI request.");
    }

    const runStatus = await waitForRunToComplete(threadId, run.id);
    if (runStatus === "failed") {
      throw new Error("AI request failed.");
    }

    const messages = await openai.beta.threads.messages.list(threadId);
    const latestMessage = messages.data.find(m => m.role === "assistant");
    const responseText = latestMessage?.content[0]?.text?.value || "No response available.";

    const newMCQs = [];
    if (count === 1) {
      newMCQs.push(parseSingleMCQ(responseText));
    } else {
      const mcqTexts = responseText.split("----").map(t => t.trim()).filter(t => t);
      for (const mcqText of mcqTexts) {
        newMCQs.push(parseSingleMCQ(mcqText));
      }
    }

    if (mongoConnected) {
      const validMCQs = newMCQs.filter(mcq => {
        // Validate MCQ structure
        const hasValidOptions = mcq.options && 
          mcq.options.A && mcq.options.B && mcq.options.C && mcq.options.D &&
          Object.keys(mcq.options).length === 4;
        const hasValidQuestion = mcq.question && Array.isArray(mcq.question) && 
          mcq.question.length > 0 && 
          !mcq.question.some(line => line.match(/^\([a-d]\)/) || line.match(/^Options:/));
        const hasValidAnswer = mcq.correctAnswer && ['A', 'B', 'C', 'D'].includes(mcq.correctAnswer);
        const hasValidExplanation = mcq.explanation && typeof mcq.explanation === 'string' && mcq.explanation.length > 0;
    
        const isValid = hasValidOptions && hasValidQuestion && hasValidAnswer && hasValidExplanation;
        if (!isValid) {
          console.warn(`Discarding invalid MCQ:`, {
            question: mcq.question,
            options: mcq.options,
            correctAnswer: mcq.correctAnswer,
            explanation: mcq.explanation
          });
        }
        return isValid;
      });
    
      if (validMCQs.length < newMCQs.length) {
        console.warn(`Discarded ${newMCQs.length - validMCQs.length} invalid MCQ(s). Fetching cached MCQs...`);
        const remainingCount = newMCQs.length - validMCQs.length;
        if (remainingCount > 0 && mongoConnected) {
          const cachedMCQs = await fetchCachedMCQs(category, selectedChapter, remainingCount);
          if (cachedMCQs.length >= remainingCount) {
            return [...validMCQs, ...cachedMCQs.slice(0, remainingCount)];
          } else {
            console.warn(`Insufficient cached MCQs (${cachedMCQs.length}/${remainingCount}) for category=${category}, chapter=${selectedChapter || 'any'}. Falling back to broader cache.`);
            const fallbackMCQs = await fetchCachedMCQs(category, null, remainingCount - cachedMCQs.length);
            if (cachedMCQs.length + fallbackMCQs.length >= remainingCount) {
              return [...validMCQs, ...cachedMCQs, ...fallbackMCQs.slice(0, remainingCount - cachedMCQs.length)];
            } else {
              console.warn(`Insufficient cached MCQs even after fallback. Returning available MCQs.`);
              return [...validMCQs, ...cachedMCQs, ...fallbackMCQs];
            }
          }
        } else {
          console.warn(`No MongoDB connection or no MCQs to fetch. Returning valid MCQs only.`);
          return validMCQs;
        }
      }
    
      for (const mcq of validMCQs) {
        await db.collection("mcqs").insertOne({
          book: bookInfo.bookName,
          category,
          chapter: selectedChapter || "entire-book",
          mcq,
          createdAt: new Date()
        });
      }
      console.log(`Saved ${validMCQs.length} MCQ${validMCQs.length > 1 ? 's' : ''} to MongoDB for category=${category}, chapter=${selectedChapter || 'entire-book'}`);
    }

    return newMCQs;
  } catch (error) {
    console.error(`Error generating ${count} MCQs for category=${category}, userId=${userId}, retry=${retryCount}:`, error.message);
    throw error;
  } finally {
    releaseLock(threadId);
  }
}

// New endpoint to save user data
app.post("/save-user", async (req, res) => {
  try {
    const { email, username } = req.body;

    if (!email || !username) {
      return res.status(400).json({ error: "Missing required fields: email and username are required" });
    }

    if (!mongoConnected) {
      console.warn("MongoDB not connected, cannot save user data");
      return res.status(500).json({ error: "Database not connected" });
    }

    // Save or update user in the database
    const userData = {
      email,
      username,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Use upsert to update if exists, or insert if new
    await db.collection("users").updateOne(
      { email }, // Match by email
      { $set: userData }, // Update or set the data
      { upsert: true } // Insert if not found
    );

    console.log(`Saved/Updated user: ${email}, username: ${username}`);
    res.status(200).json({ message: "User saved successfully" });
  } catch (error) {
    console.error(`Error saving user data for email=${req.body.email || 'unknown'}:`, error.message);
    if (error.code === 11000) { // Duplicate key error (email already exists)
      res.status(400).json({ error: "User with this email already exists" });
    } else {
      res.status(500).json({ error: "Failed to save user", details: error.message });
    }
  }
});

app.post("/ask", async (req, res) => {
  try {
    if (!req.body) {
      throw new Error("Request body is missing or invalid.");
    }

    const { query, category, userId, count = 1, forceGenerate = false, chapter, mode } = req.body;

    if (!userId || (!query && mode !== "battleground") || (mode !== "battleground" && !category)) {
      throw new Error("Missing required fields: query, category, or userId.");
    }

    if (mode === "battleground") {
      const subjects = [
        "Polity",
        "History",
        "Geography",
        "Science",
        "Environment",
        "Economy",
        "CurrentAffairs",
        "PreviousYearPapers"
      ];
      const randomSubject = category || subjects[Math.floor(Math.random() * subjects.length)];
      console.log(`Battleground mode: Fetching ${count} MCQ(s) for subject: ${randomSubject}`);
    
      // Map battleground subjects to possible categoryToBookMap keys (multiple books for History and Geography)
      const subjectMapping = {
        Polity: ["Polity"],
        History: ["Spectrum", "TamilnaduHistory", "ArtAndCulture"],
        Geography: ["FundamentalGeography", "IndianGeography"],
        Science: ["Science"],
        Environment: ["Environment"],
        Economy: ["Economy"],
        CurrentAffairs: ["CurrentAffairs"],
        PreviousYearPapers: ["PreviousYearPapers"]
      };
    
      const possibleSubjects = subjectMapping[randomSubject];
      if (!possibleSubjects || possibleSubjects.length === 0) {
        console.error(`Invalid subject mapping for ${randomSubject}`);
        res.status(400).json({ error: "Invalid subject", details: `Subject ${randomSubject} not supported` });
        return;
      }
    
      const mappedSubject = possibleSubjects[Math.floor(Math.random() * possibleSubjects.length)];
      if (!categoryToBookMap[mappedSubject]) {
        console.error(`Invalid mapped subject: ${mappedSubject}`);
        res.status(400).json({ error: "Invalid subject", details: `Mapped subject ${mappedSubject} not supported` });
        return;
      }
    
      let mcqs = [];
      if (!forceGenerate && mongoConnected) {
        const matchQuery = { category: mappedSubject };
        if (chapter !== "entire-book") {
          matchQuery.chapter = chapter;
        }
        mcqs = await db.collection("mcqs").aggregate([
          { $match: matchQuery },
          { $sample: { size: count } }
        ]).toArray();
        console.log(`Found ${mcqs.length} cached MCQ(s) for subject: ${mappedSubject}, chapter: ${chapter || 'any'}`);
      }
    
      if (mcqs.length < count) {
        console.log(`Insufficient cached MCQs (${mcqs.length}/${count}) for subject: ${mappedSubject}, generating ${count - mcqs.length} MCQs`);
        const neededCount = count - mcqs.length;
        const themes = await db.collection("book_themes").aggregate([
          { $match: { category: mappedSubject } },
          { $sample: { size: 1 } }
        ]).toArray();
    
        let selectedTheme, randomChapter;
        selectedTheme = themes[0].themes[Math.floor(Math.random() * themes[0].themes.length)];
        randomChapter = themes[0].chapter;
    
        const bookInfo = categoryToBookMap[mappedSubject];
        if (!bookInfo) {
          console.error(`No book info found for mapped subject: ${mappedSubject}`);
          res.status(500).json({ error: "Failed to generate MCQs", details: `No book info for ${mappedSubject}` });
          return;
        }
    
        const query = `Generate ${neededCount} MCQ from ${randomChapter} of the ${bookInfo.bookName} based on theme: ${selectedTheme}. Use the chapter content as the primary source, supplemented by internet resources and general knowledge to ensure uniqueness and depth.`;
    
        const newMCQs = await generateMCQs(query, mappedSubject, userId, neededCount, randomChapter);
        mcqs = mcqs.concat(await db.collection("mcqs").find({
          book: bookInfo.bookName,
          category: mappedSubject,
          chapter: randomChapter
        }).sort({ createdAt: -1 }).limit(neededCount).toArray());
      }
    
      if (mcqs.length >= count) {
        console.log(`Returning ${mcqs.length} MCQ(s) for Battleground, subject: ${mappedSubject}`);
        res.json({ answers: count === 1 ? mcqs[0].mcq : mcqs.map(m => m.mcq) });
        return;
      }
    
      console.error(`Failed to retrieve or generate ${count} MCQs for subject: ${mappedSubject}`);
      res.status(500).json({ error: "Failed to retrieve or generate MCQs", details: `Insufficient MCQs available for ${mappedSubject}` });
      return;
    }

    if (!categoryToBookMap[category]) {
      throw new Error(`Invalid category: ${category}. Please provide a valid subject category.`);
    }

    const bookInfo = categoryToBookMap[category];
    const bookName = bookInfo.bookName;

    let chapterForQuery = req.body.chapter || "entire-book";
    if (!chapterForQuery || chapterForQuery === "entire-book") {
      if (category === "Economy") {
        const chapterMatch = query.match(/Generate \d+ MCQ from (.*?)\s*of\s*(?:the\s*)?Ramesh Singh Indian Economy Book/i);
        chapterForQuery = chapterMatch ? chapterMatch[1].trim() : "entire-book";
      } else if (category === "Polity") {
        const chapterMatch = query.match(/Generate \d+ MCQ from (.*?)\s*of\s*(?:the\s*)?Laxmikanth['s]* Indian Polity book/i);
        chapterForQuery = chapterMatch ? chapterMatch[1].trim() : "entire-book";
      } else {
        const chapterMatch = query.match(/Generate \d+ MCQ from (.*?)\s*of\s*(?:the\s*)?.*?/i);
        chapterForQuery = chapterMatch ? chapterMatch[1].trim() : "entire-book";
      }
    }

    let selectedChapter = chapterForQuery;
    if (category === "Polity" && chapterForQuery && chapterForQuery !== "entire-book") {
      const cleanChapter = chapterForQuery.replace(/^Chapter\s*\d+\s*[:\-\s]*/i, "").trim();
      const fullChapterName = Object.keys(chapterToUnitMap).find(
        (key) => key.toLowerCase() === cleanChapter.toLowerCase()
      );
      selectedChapter = fullChapterName ? getFullChapterName(fullChapterName, category) : chapterForQuery;
    } else if (category === "Economy" && chapterForQuery && chapterForQuery !== "entire-book") {
      const fullChapterName = Object.keys(chapterToUnitMap).find(
        (key) => chapterForQuery.toLowerCase().includes(key.toLowerCase())
      );
      selectedChapter = fullChapterName ? getFullChapterName(fullChapterName, category) : chapterForQuery;
    }

    console.log(`Processing /ask request: category=${category}, userId=${userId}, count=${count}, chapter=${chapterForQuery}, forceGenerate=${forceGenerate}`);

    let mcqs = [];

    if (chapterForQuery === "entire-book" && mongoConnected) {
      const allThemes = await loadThemes(category);
      const availableChapters = Object.keys(allThemes).filter(ch => ch !== "entire-book");
      if (availableChapters.length === 0) {
        console.error("No chapters with saved themes available for entire-book mode");
        return res.status(400).json({ error: "No chapters with saved themes available" });
      }

      if (forceGenerate && count === 1) {
        console.log(`Force generating 1 new MCQ for entire-book mode`);
        const randomChapter = availableChapters[Math.floor(Math.random() * availableChapters.length)];
        const queryForChapter = `Generate 1 MCQ from ${randomChapter} of the ${bookInfo.bookName}. Use the chapter content as the primary source, supplemented by internet resources and general knowledge to ensure uniqueness and depth.`;
        const newMCQs = await generateMCQs(queryForChapter, category, userId, 1, randomChapter);

        mcqs = await db.collection("mcqs").find({
          book: bookName,
          category,
          chapter: randomChapter
        }).sort({ createdAt: -1 }).limit(1).toArray();
        
        console.log(`After forced generation, returning 1 latest MCQ for chapter: ${randomChapter}`);
        res.json({ answers: mcqs[0].mcq });
        return;
      } else {
        console.log(`Fetching ${count} cached MCQs for entire-book mode`);
        const selectedChapters = [];
        while (selectedChapters.length < count && availableChapters.length > 0) {
          const randomIndex = Math.floor(Math.random() * availableChapters.length);
          selectedChapters.push(availableChapters.splice(randomIndex, 1)[0]);
        }

        for (const chapter of selectedChapters) {
          const chapterMCQs = await db.collection("mcqs").aggregate([
            {
              $match: {
                book: bookName,
                category,
                chapter
              }
            },
            { $sample: { size: 1 } }
          ]).toArray();
          mcqs = mcqs.concat(chapterMCQs);
        }

        if (mcqs.length < count) {
          console.log(`Insufficient cached MCQs (${mcqs.length}/${count}) for entire-book mode, generating ${count - mcqs.length} MCQs`);
          const neededCount = count - mcqs.length;
          for (let i = 0; i < neededCount; i++) {
            const randomChapter = availableChapters.length > 0 
              ? availableChapters[Math.floor(Math.random() * availableChapters.length)]
              : selectedChapters[Math.floor(Math.random() * selectedChapters.length)];
            const queryForChapter = `Generate 1 MCQ from ${randomChapter} of the ${bookInfo.bookName}. Use the chapter content as the primary source, supplemented by internet resources and general knowledge to ensure uniqueness and depth.`;
            const newMCQs = await generateMCQs(queryForChapter, category, userId, 1, randomChapter);
            mcqs = mcqs.concat(await db.collection("mcqs").find({
              book: bookName,
              category,
              chapter: randomChapter
            }).sort({ createdAt: -1 }).limit(1).toArray());
          }
        }

        console.log(`Returning ${mcqs.length} MCQ${mcqs.length > 1 ? 's' : ''} for entire-book mode, category=${category}, userId=${userId}`);
        res.json({ answers: count === 1 ? mcqs[0].mcq : mcqs.map(m => m.mcq) });
        return;
      }
    }

    if (forceGenerate && count === 1 && mongoConnected) {
      console.log(`Force generating 1 new MCQ for chapter: ${chapterForQuery}`);
      const newMCQs = await generateMCQs(query, category, userId, 1, chapterForQuery);

      mcqs = await db.collection("mcqs").find({
        book: bookName,
        category,
        chapter: chapterForQuery
      }).sort({ createdAt: -1 }).limit(1).toArray();
      
      console.log(`After forced generation, returning 1 latest MCQ for chapter: ${chapterForQuery}`);
      res.json({ answers: mcqs[0].mcq });
      return;
    }

    if (mongoConnected) {
      console.log(`Checking MongoDB for ${count} MCQ${count > 1 ? 's' : ''}, book: ${bookName}, category: ${category}, chapter: ${chapterForQuery}`);
      mcqs = await db.collection("mcqs").aggregate([
        {
          $match: {
            book: bookName,
            category,
            chapter: chapterForQuery
          }
        },
        { $sample: { size: count } }
      ]).toArray();
      console.log(`Found ${mcqs.length} cached MCQ${mcqs.length !== 1 ? 's' : ''} for chapter: ${chapterForQuery}`);
    } else {
      console.warn("MongoDB not connected, proceeding to generation");
    }

    if (mcqs.length < count && mongoConnected) {
      console.log(`Insufficient cached MCQs (${mcqs.length}/${count}), generating ${count} MCQs`);
      const neededCount = count;
      const newMCQs = await generateMCQs(query, category, userId, neededCount, chapterForQuery);

      mcqs = await db.collection("mcqs").aggregate([
        {
          $match: {
            book: bookName,
            category,
            chapter: chapterForQuery
          }
        },
        { $sample: { size: count } }
      ]).toArray();
      console.log(`After generation, found ${mcqs.length} cached MCQ${mcqs.length !== 1 ? 's' : ''} for chapter: ${chapterForQuery}`);
    }

    if (mcqs.length >= count) {
      console.log(`Returning ${mcqs.length} cached MCQ${mcqs.length > 1 ? 's' : ''} for category=${category}, userId=${userId}`);
      res.json({ answers: count === 1 ? mcqs[0].mcq : mcqs.map(m => m.mcq) });
      return;
    }

    console.error(`Failed to retrieve or generate ${count} MCQs for category=${category}, chapter=${chapterForQuery}`);
    res.status(500).json({ error: "Failed to retrieve or generate MCQs", details: "Insufficient MCQs available after generation" });
  } catch (error) {
    console.error(`Error in /ask endpoint for category=${req.body.category || 'unknown'}:`, {
      message: error.message,
      body: req.body,
    });
    res.status(500).json({ error: "AI service error", details: error.message });
  }
});

// New leaderboard endpoints
app.post("/battleground/submit", async (req, res) => {
  try {
    const { username, score } = req.body;
    if (!username || typeof score !== "number") {
      throw new Error("Missing or invalid username or score");
    }
    // Update or insert the user's score (upsert)
    await db.collection("battleground_rankings").updateOne(
      { username }, // Match by username
      { $set: { score, date: new Date() } }, // Update score and date
      { upsert: true } // Insert if not found
    );
    // Fetch updated rankings
    const rankings = await db.collection("battleground_rankings")
      .find({}, { projection: { username: 1, score: 1, _id: 0 } }) // Exclude date and _id
      .sort({ score: -1, date: 1 })
      .limit(50)
      .toArray();
    res.json({ rankings });
  } catch (error) {
    console.error("Error in /battleground/submit:", error.message);
    res.status(500).json({ error: "Failed to submit score", details: error.message });
  }
});

app.get("/battleground/leaderboard", async (req, res) => {
  try {
    const rankings = await db.collection("battleground_rankings")
      .find({}, { projection: { username: 1, score: 1, _id: 0 } }) // Exclude date and _id
      .sort({ score: -1, date: 1 })
      .limit(50)
      .toArray();
    res.json({ rankings });
  } catch (error) {
    console.error("Error in /battleground/leaderboard:", error.message);
    res.status(500).json({ error: "Failed to fetch leaderboard", details: error.message });
  }
});

function parseSingleMCQ(rawResponse) {
  const normalized = rawResponse.replace(/\r\n/g, "\n");
  const sections = normalized.split(/\n\n/).map(s => s.trim()).filter(s => s);
  const questionIndex = sections.findIndex(s => s.startsWith("Question:"));
  const optionsIndex = sections.findIndex(s => s.startsWith("Options:"));
  const correctAnswerIndex = sections.findIndex(s => s.startsWith("Correct Answer:"));
  const explanationIndex = sections.findIndex(s => s.startsWith("Explanation:"));
  let questionLines = [];
  if (questionIndex !== -1) {
    if (optionsIndex !== -1) {
      questionLines = sections.slice(questionIndex, optionsIndex).join("\n").split("\n");
    } else if (correctAnswerIndex !== -1) {
      questionLines = sections.slice(questionIndex, correctAnswerIndex).join("\n").split("\n");
    } else if (explanationIndex !== -1) {
      questionLines = sections.slice(questionIndex, explanationIndex).join("\n").split("\n");
    } else {
      questionLines = sections.slice(questionIndex).join("\n").split("\n");
    }
  }

  // Clean question lines and extract misplaced options
  let cleanedQuestionLines = [];
  const misplacedOptions = [];
  let inOptionsSection = false;
  for (const line of questionLines) {
    if (line.match(/^Options:/)) {
      inOptionsSection = true;
      continue;
    }
    if (inOptionsSection && line.match(/^\([a-d]\)\s*.+$/i)) {
      misplacedOptions.push(line);
    } else {
      cleanedQuestionLines.push(line);
    }
  }

  const question = cleanedQuestionLines.length > 0
    ? cleanedQuestionLines.join("\n").replace("Question: ", "").split("\n").map(line => line.trim()).filter(line => line)
    : [];

  let optionsSection = "";
  if (optionsIndex !== -1) {
    if (correctAnswerIndex !== -1) {
      optionsSection = sections.slice(optionsIndex, correctAnswerIndex).join("\n");
    } else if (explanationIndex !== -1) {
      optionsSection = sections.slice(optionsIndex, explanationIndex).join("\n");
    } else {
      optionsSection = sections.slice(optionsIndex).join("\n");
    }
  }

  const optionsLines = optionsSection.split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("Options:"));
  const options = {};
  // Add options from the Options: section
  optionsLines.forEach(line => {
    const match = line.match(/^\((a|b|c|d)\)\s*(.+)$/i);
    if (match) options[match[1].toUpperCase()] = match[2].trim();
  });
  // Add misplaced options from the question section
  misplacedOptions.forEach(line => {
    const match = line.match(/^\((a|b|c|d)\)\s*(.+)$/i);
    if (match) options[match[1].toUpperCase()] = match[2].trim();
  });

  const correctAnswerLine = correctAnswerIndex !== -1 ? sections[correctAnswerIndex] : "";
  const correctAnswerParts = correctAnswerLine ? correctAnswerLine.split("\n") : [];
  const correctAnswerText = correctAnswerParts[0] || "";
  const correctAnswer = correctAnswerText
    ? correctAnswerText.replace("Correct Answer: ", "").replace("(", "").replace(")", "").trim().toUpperCase()
    : null;

  const explanationLines = explanationIndex !== -1 ? sections.slice(explanationIndex) : correctAnswerParts.slice(1);
  const explanation = explanationLines.length > 0
    ? explanationLines.join(" ").replace("Explanation: ", "").trim()
    : `The correct answer is ${correctAnswer}.`;

  return {
    question,
    options,
    correctAnswer,
    explanation
  };
}

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});