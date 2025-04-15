const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const { MongoClient } = require("mongodb");

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
    // Create index for mcqs collection
    await db.collection("mcqs").createIndex({ book: 1, category: 1, chapter: 1 });
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error.message);
    mongoConnected = false;
  }
}

// Connect to MongoDB when the server starts
connectToMongoDB();

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
  if (category === "Atlas") {
    console.log(`Atlas file pending, using fallback theme for chapter: ${chapter}`);
    return [`Theme: General Geography - Subtheme: ${chapter || 'Atlas Content'} - Sub-subtheme: Concepts`];
  }

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
  const categories = Object.keys(categoryToBookMap).filter(cat => cat !== "Atlas");
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
  // Atlas
  "Maps and Map Making": "Chapter 1",
  "The Universe": "Chapter 2",
  "The Earth": "Chapter 3",
  "Realms of the Earth": "Chapter 4",
  "Contours and Landforms": "Chapter 5",
  "The Indian Subcontinent – Physical": "Chapter 6",
  "The Indian Subcontinent – Political": "Chapter 7",
  "Northern India and Nepal": "Chapter 8",
  "North-Central and Eastern India": "Chapter 9",
  "North-Eastern India, Bhutan and Bangladesh": "Chapter 10",
  "Western India and Pakistan": "Chapter 11",
  "Southern India and Sri Lanka": "Chapter 12",
  "Jammu and Kashmir, Himachal Pradesh, Punjab, Haryana, Delhi and Chandigarh": "Chapter 13",
  "Rajasthan, Gujarat, Daman & Diu and Dadra & Nagar Haveli": "Chapter 14",
  "Uttar Pradesh, Uttarakhand, Bihar and Jharkhand": "Chapter 15",
  "Sikkim, West Bengal and the North-Eastern States": "Chapter 16",
  "Madhya Pradesh, Chhattisgarh and Odisha": "Chapter 17",
  "Maharashtra, Telangana, Andhra Pradesh and Goa": "Chapter 18",
  "Karnataka, Tamil Nadu, Kerala and Puducherry": "Chapter 19",
  "The Islands": "Chapter 20",
  "India – Geology, Geological Formations, Structure and Major Faults and Thrusts": "Chapter 21",
  "India – Physiography": "Chapter 22",
  "India – Temperature and Pressure": "Chapter 23",
  "India – Rainfall and Winds": "Chapter 24",
  "India – Relative Humidity, Annual Temperature and Annual Rainfall": "Chapter 25",
  "India – Monsoon, Rainfall Trends and Climatic Regions": "Chapter 26",
  "India – Natural Vegetation and Forest Cover": "Chapter 27",
  "India – Bio-geographic Zones, Wildlife and Wetlands": "Chapter 28",
  "India – Drainage Basins and East & West Flowing Rivers": "Chapter 29",
  "India – Soil and Land Use": "Chapter 30",
  "India – Irrigation and Net Irrigated Area": "Chapter 31",
  "India – Food grain Production, Livestock Population, Milk Production and Fisheries": "Chapter 32",
  "India – Food Crops": "Chapter 33",
  "India – Cash Crops": "Chapter 34",
  "India – Important Mineral Belts and Number of Reported Mines": "Chapter 35",
  "India – Production of Metallic and Non-Metallic Minerals": "Chapter 36",
  "India – Metallic Minerals": "Chapter 37",
  "India – Non-Metallic Minerals and Mineral Fuels": "Chapter 38",
  "India – Mineral Deposits": "Chapter 39",
  "India – Industrial Regions and Levels of Industrial Development": "Chapter 40",
  "India – Industries": "Chapter 41",
  "India – Power Projects and Power Consumption": "Chapter 42",
  "India – Roads and Inland Waterways": "Chapter 43",
  "India – Railways": "Chapter 44",
  "India – Air and Sea Routes": "Chapter 45",
  "India – Population": "Chapter 46",
  "India – Human Development": "Chapter 47",
  "India – Religions and Languages": "Chapter 48",
  "India – Tourism": "Chapter 49",
  "India – World Heritage Sites": "Chapter 50",
  "India – Cultural Heritage": "Chapter 51",
  "India – Environmental Concerns": "Chapter 52",
  "India – Natural Hazards": "Chapter 53",
  "Asia – Physical": "Chapter 54",
  "Asia – Political": "Chapter 55",
  "Asia – Climate, Natural Vegetation, Population and Economy": "Chapter 56",
  "SAARC Countries": "Chapter 57",
  "China, Mongolia and Taiwan": "Chapter 58",
  "Japan, North Korea and South Korea": "Chapter 59",
  "South-Eastern Asia": "Chapter 60",
  "Myanmar, Thailand, Laos, Cambodia and Vietnam": "Chapter 61",
  "West Asia": "Chapter 62",
  "Afghanistan and Pakistan": "Chapter 63",
  "Europe – Physical": "Chapter 64",
  "Europe – Political": "Chapter 65",
  "Europe – Climate, Natural Vegetation, Population and Economy": "Chapter 66",
  "British Isles": "Chapter 67",
  "France and Central Europe": "Chapter 68",
  "Eurasia": "Chapter 69",
  "Africa – Physical": "Chapter 70",
  "Africa – Political": "Chapter 71",
  "Africa – Climate, Natural Vegetation, Population and Economy": "Chapter 72",
  "Southern Africa and Madagascar": "Chapter 73",
  "North America": "Chapter 74",
  "North America – Political": "Chapter 75",
  "North America – Climate, Natural Vegetation, Population and Economy": "Chapter 76",
  "United States of America and Alaska": "Chapter 77",
  "South America – Physical": "Chapter 78",
  "South America – Political": "Chapter 79",
  "South America – Climate, Natural Vegetation, Population and Economy": "Chapter 80",
  "Brazil": "Chapter 81",
  "Oceania – Physical": "Chapter 82",
  "Oceania – Political": "Chapter 83",
  "Oceania – Climate, Natural Vegetation, Population and Economy": "Chapter 84",
  "Pacific Ocean and Central Pacific Islands": "Chapter 85",
  "Indian Ocean and Atlantic Ocean": "Chapter 86",
  "The Arctic Ocean and Antarctica": "Chapter 87",
  "World – Physical": "Chapter 88",
  "World – Political": "Chapter 89",
  "World – Climate": "Chapter 90",
  "World – Annual Rainfall and Major Ocean Currents": "Chapter 91",
  "World – Climatic Regions and Water Resources": "Chapter 92",
  "World – Major Landforms and Forest Cover": "Chapter 93",
  "World – Soil and Natural Vegetation": "Chapter 94",
  "World – Agriculture and Industrial Regions": "Chapter 95",
  "World – Minerals, Mineral Fuels, Trade and Economic Development": "Chapter 96",
  "World – Population Density, Urbanization, Religions and Languages": "Chapter 97",
  "World – Human Development": "Chapter 98",
  "World – Environmental Concerns": "Chapter 99",
  "World – Biomes at Risk": "Chapter 100",
  "World – Plate Tectonics and Natural Hazards": "Chapter 101",
  "World – Air Routes and Sea Routes": "Chapter 102",
  "World – Facts and Figures – Flag, Area, Population, Countries, Language, Monetary Unit and GDP": "Chapter 103",
  "World Statistics – Human Development and Economy": "Chapter 104",
  "World – Geographic Comparisons": "Chapter 105",
  "World – Time Zones": "Chapter 106",
  "Index": "Chapter 107",
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
                    bookName.includes("Atlas") ||
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

app.post("/ask", async (req, res) => {
  try {
    if (!req.body) {
      throw new Error("Request body is missing or invalid.");
    }

    const { query, category, userId, count = 1 } = req.body;

    if (!query || !category || !userId) {
      throw new Error("Missing required fields: query, category, or userId.");
    }

    if (!categoryToBookMap[category]) {
      throw new Error(`Invalid category: ${category}. Please provide a valid subject category.`);
    }

    const bookInfo = categoryToBookMap[category];
    const fileId = bookInfo.fileId;

   // Check MongoDB pool
let mcqs = [];
let chapterForQuery;
if (mongoConnected) {
  // Extract full chapter name for Economy
  const chapterMatch = category === "Economy" 
    ? query.match(/Generate \d+ MCQ from (.*?)\s*of\s*(?:the\s*)?Ramesh Singh Indian Economy Book/i)
    : query.match(/Generate \d+ MCQ from (.*?) of the/);
  chapterForQuery = chapterMatch ? chapterMatch[1].trim() : "entire-book";
  console.log(`Checking MongoDB for ${count} MCQ${count > 1 ? 's' : ''}, book: ${bookInfo.bookName}, category: ${category}, chapter: ${chapterForQuery}`);
  mcqs = await db.collection("mcqs").aggregate([
    {
      $match: {
        book: bookInfo.bookName,
        category,
        chapter: chapterForQuery
      }
    },
    { $sample: { size: count } }
  ]).toArray();
  console.log(`Found ${mcqs.length} cached MCQ${mcqs.length !== 1 ? 's' : ''} for chapter: ${chapterForQuery}`);
} else {
  console.warn("MongoDB not connected, skipping cache check");
  chapterForQuery = query.match(/Generate \d+ MCQ from (.*?) of the/) ? query.match(/Generate \d+ MCQ from (.*?) of the/)[1].trim() : "entire-book";
}

// Prepare response with cached MCQs
let responseMCQs = [];
if (mcqs.length >= count) {
  responseMCQs = count === 1 ? [mcqs[0].mcq] : mcqs.map(m => m.mcq);
  console.log(`Returning ${responseMCQs.length} cached MCQ${responseMCQs.length > 1 ? 's' : ''} for category=${category}, userId=${userId}`);
  res.json({ answers: count === 1 ? responseMCQs[0] : responseMCQs });
} else {
  responseMCQs = mcqs.map(m => m.mcq);
}

// Generate additional MCQ for buffer replenishment if count=1
if (count === 1 && mongoConnected) {
  let threadId = userThreads.get(userId);
  if (!threadId) {
    const thread = await openai.beta.threads.create();
    threadId = thread.id;
    userThreads.set(userId, threadId);
  }

  await acquireLock(threadId);

  try {
    await waitForAllActiveRuns(threadId);

    const bookName = bookInfo.bookName;
    console.log(`Processing request to generate 1 new MCQ for buffer: category=${category}, userId=${userId}, query=${query}`);

    // Match chapter for generation
    let chapterMatch;
    if (category === "Polity") {
      chapterMatch = query.match(/Generate \d+ MCQ from (.*?)\s*of\s*(?:the\s*)?Laxmikanth'?s?\s*Indian\s*Polity\s*book/i);
    } else if (category === "IndianGeography") {
      chapterMatch = query.match(/Generate \d+ MCQ from (.*?) of the (?:.*Indian Geography Book|NCERT Class 11th Indian Geography)/i);
    } else if (category === "FundamentalGeography") {
      chapterMatch = query.match(/Generate \d+ MCQ from (.*?) of the (?:.*Fundamental Geography Book|NCERT Class 11th Fundamentals of Physical Geography)/i);
    } else if (category === "ArtAndCulture") {
      chapterMatch = query.match(/Generate \d+ MCQ from (.*?) of the (?:.*Art and Culture Book|Nitin Singhania Art and Culture Book)/i);
    } else if (category === "Atlas") {
      chapterMatch = query.match(/Generate \d+ MCQ from (.*?) of the Atlas Book/i);
    } else if (category === "Science") {
      chapterMatch = query.match(/Generate \d+ MCQ from (.*?) of the (?:.*Science Book|Disha IAS Previous Year Papers)/i);
    } else if (category === "PreviousYearPapers") {
      chapterMatch = query.match(/Generate \d+ MCQ from (.*?) of the Disha Publication’s UPSC Prelims Previous Year Papers/i);
    } else if (category === "Economy") {
      chapterMatch = query.match(/Generate \d+ MCQ from (.*?)\s*of\s*(?:the\s*)?Ramesh Singh Indian Economy Book/i);
    } else {
      chapterMatch = query.match(new RegExp(`Generate \\d+ MCQ from (.*?) of the ${bookName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'));
    }
    let chapter = chapterMatch ? chapterMatch[1].trim() : null;
    console.log(`Extracted chapter: ${chapter}`);

    // Normalize chapter name for Polity
    if (category === "Polity" && chapter) {
      const cleanChapter = chapter.replace(/^Chapter\s*\d+\s*/i, "").trim();
      const fullChapterName = Object.keys(chapterToUnitMap).find(
        (key) => key.toLowerCase() === cleanChapter.toLowerCase()
      );
      chapter = fullChapterName ? getFullChapterName(fullChapterName, category) : chapter;
      console.log(`Normalized chapter: ${chapter}`);
    }

    // Normalize chapter name for Economy
    if (category === "Economy" && chapter) {
      const fullChapterName = Object.keys(chapterToUnitMap).find(
        (key) => chapter.toLowerCase().includes(key.toLowerCase())
      );
      chapter = fullChapterName ? getFullChapterName(fullChapterName, category) : chapter;
      console.log(`Normalized chapter for Economy: ${chapter}`);
    }

    const userIdParts = userId.split('-');
    const questionIndex = userIdParts.length > 1 ? parseInt(userIdParts[userIdParts.length - 1], 10) : 0;
    const baseUserId = userIdParts.slice(0, -1).join('-');
    const questionCountKey = `${baseUserId}:${chapter || 'entire-book'}`;
    let questionCount = questionCounts.get(questionCountKey) || 0;
    questionCount++;
    questionCounts.set(questionCountKey, questionCount);

    console.log(`Request details: userId=${userId}, category=${category}, chapter=${chapter || 'entire-book'}, questionCount=${questionCount}`);

    let themes;
    let selectedChapter = chapter;
    if (category === "Atlas") {
      console.log(`Atlas file pending, using fallback themes for chapter: ${chapter}`);
      themes = [`Theme: General Geography - Subtheme: ${chapter || 'Atlas Content'} - Sub-subtheme: Concepts`];
      selectedChapter = chapter || "entire-book";
    } else {
      const allThemes = await loadThemes(category);
      if (!chapter) {
        console.warn(`No chapter specified, selecting random chapter for ${category}`);
        const availableChapters = Object.keys(allThemes).filter(ch => ch !== "entire-book");
        if (availableChapters.length === 0) {
          throw new Error(`No themes available for ${category}. Please select a specific chapter.`);
        }
        const randomChapterIndex = Math.floor(Math.random() * availableChapters.length);
        selectedChapter = availableChapters[randomChapterIndex];
        console.log(`Entire Book mode: Selected chapter: ${selectedChapter}`);
        chapter = getFullChapterName(selectedChapter, category);
        themes = allThemes[selectedChapter]?.themes;
        const questionCountKeyForChapter = `${baseUserId}:${chapter}`;
        questionCount = questionCounts.get(questionCountKeyForChapter) || 0;
        questionCount++;
        questionCounts.set(questionCountKeyForChapter, questionCount);
      } else {
        selectedChapter = getFullChapterName(chapter, category);
        themes = allThemes[selectedChapter]?.themes;
        if (!themes) {
          console.log(`No themes found for ${selectedChapter} in ${category}. Extracting...`);
          themes = await extractThemes(threadId, selectedChapter, fileIds[category], category);
        }
      }

      if (!themes || themes.length === 0) {
        throw new Error(`No themes available for ${selectedChapter || 'entire-book'} in ${category}`);
      }
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

    let generalInstruction;
    if (category === "Atlas") {
      generalInstruction = `
        You are an AI designed to create an elite UPSC training camp for the TrainWithMe platform, delivering diverse, deeply researched, and accurate MCQs that captivate and challenge users. For this query, the Atlas category file is not available, so rely on your extensive training data encompassing vast geographical knowledge and general resources.

        📚 Reference for This Query:  
        - Category: ${category}  
        - Book: ${bookInfo.bookName}  
        - Description: ${bookInfo.description}  

        **Instructions for MCQ Generation:**  
        - Generate 1 MCQ inspired by the specified chapter ("${chapter || 'entire book'}") of an Atlas, covering comprehensive geographical and thematic data. Use general knowledge and standard geographical references to ensure accuracy and depth.  
        - **Theme-Based Focus**: Base this MCQ (question ${questionCount}) on the theme: "${selectedTheme}". Interpret the theme broadly to include related subthemes or sub-subthemes relevant to "${chapter || 'entire book'}".  
        - **Even Distribution**: Avoid fixating on overused topics (e.g., Mount Everest, Ganga River) unless tied to "${selectedTheme}" in a fresh way.  
        - **Balance Thematic and Fact-Based Questions**: Ensure a 50/50 mix of thematic questions (testing conceptual understanding, e.g., map-making techniques) and fact-based questions (testing specific details, e.g., "The capital of Brazil is..."). Include precise data like geographical features, locations, or statistics where applicable.  
        - **Maximum Complexity and Unpredictability**: Craft challenging, unique MCQs that test deep understanding, critical thinking, and analytical skills at an elite UPSC level. Avoid predictable patterns:
          - For "Multiple Statements - How Many Correct," ensure correct answers are evenly distributed (e.g., "only one" as likely as "only two" or "only three"). Include subtle distractors and false statements to make "only one" or "none" viable.
          - For "Assertion and Reason," create nuanced assertions and reasons with complex relationships (e.g., partial truths, misleading reasons) to avoid obvious answers like option A. Vary correct options (a, b, c, d) evenly.
        - **Accuracy Assurance**: Verify the factual correctness of each question, options, and answer using standard geographical knowledge. The explanation must justify why the correct option is true and others are false.  
        - **Three-Statement Handling**: For "Multiple Statements - How Many Correct" with three statements, use options: "(a) None," "(b) Only one," "(c) Only two," "(d) All three." Generate questions where "None" can be correct by including deliberately false statements.  

        **UPSC Structure to Use:**  
        - Use the following UPSC structure for the MCQ:  
          - **Structure Name**: ${selectedStructure.name}  
          - **Example**: ${selectedStructure.example}  
          - **Options**: ${options.join(", ")} (For "Multiple Statements - How Many Correct," adjust to three-statement options if applicable)  
        - Adapt the content to fit this structure creatively and precisely.  

        **Response Structure:**  
        - For the MCQ, use this EXACT structure with PLAIN TEXT headers:  
          Question: [Full question text, following the selected UPSC structure, rich with depth and complexity]  
          Options:  
          (a) [Option A]  
          (b) [Option B]  
          (c) [Option C]  
          (d) [Option D]  
          Correct Answer: [Correct option letter, e.g., (a)]  
          Explanation: [Detailed explanation, 3-5 sentences, using general geographical knowledge, justifying the answer with precision and insight. Conclude with: "Thus, the correct answer is [option] because [reason]."]  
        - Separate each section with EXACTLY TWO newlines (\n\n).  
        - Start the response directly with "Question:"—do NOT include any introductory text.  
        - **Special Note for Single Correct Answer Structure**: Include the statements (A-D) directly under the Question text, each statement on a new line.  
        - **Special Note for Multiple Statements Structures**: List the statements under the Question text using decimal numbers (e.g., "1.", "2.", "3.", "4."), each statement on a new line. For three statements, use options: "(a) None," "(b) Only one," "(c) Only two," "(d) All three."  

        **Now, generate 1 MCQ for "${chapter || 'entire book'}" using the "${selectedStructure.name}" structure, focusing on "${selectedTheme}":**
      `;
    } else {
      if (!fileId || fileId === "pending" || fileId.startsWith("[TBD")) {
        throw new Error(`File for category ${category} is not available (File ID: ${fileId}). MCQs cannot be generated.`);
      }

      generalInstruction = `
        You are an AI designed to create an elite UPSC training camp for the TrainWithMe platform, delivering diverse, deeply researched, and accurate MCQs that captivate and challenge users. You have access to the uploaded book content (File ID: ${fileId}) and your extensive training data encompassing vast historical, philosophical, cultural, geographical, and scientific knowledge.

        📚 Reference Book for This Query:  
        - Category: ${category}  
        - Book: ${bookInfo.bookName}  
        - File ID: ${fileId}  
        - Description: ${bookInfo.description}  

        **Instructions for MCQ Generation:**  
        - Generate 1 MCQ inspired by the specified chapter ("${chapter || 'entire book'}") of the book (${bookInfo.bookName}).  
        - **Theme-Based Focus**: Base this MCQ (question ${questionCount}) on the theme: "${selectedTheme}". Use the chapter content (File ID: ${fileId}) as the primary source, but interpret the theme broadly to include related subthemes or sub-subthemes.  
        - **Even Distribution**: Avoid fixating on overused figures or events unless tied to "${selectedTheme}" in a fresh way. For science, avoid overused topics like Newton's laws unless uniquely relevant to "${selectedTheme}".  
        - **Balance Thematic and Fact-Based Questions**: Ensure a 50/50 mix of thematic questions (testing conceptual understanding, e.g., thermodynamics principles) and fact-based questions (testing specific details, e.g., "The atomic number of Carbon is..."). Include precise data like scientific constants, formulas, or discoveries from the chapter where applicable.  
        - **Maximum Complexity and Unpredictability**: Craft challenging, unique MCQs that test deep understanding, critical thinking, and analytical skills at an elite UPSC level. Avoid predictable patterns:
          - For "Multiple Statements - How Many Correct," ensure correct answers are evenly distributed (e.g., "only one" as likely as "only two" or "only three"). Include subtle distractors and false statements to make "only one" or "none" viable.
          - For "Assertion and Reason," create nuanced assertions and reasons with complex relationships (e.g., partial truths, misleading reasons) to avoid obvious answers like option A. Vary correct options (a, b, c, d) evenly.
        - **Accuracy Assurance**: Verify the factual correctness of each question, options, and answer. Cross-check scientific details and ensure the correct option aligns perfectly with the explanation. The explanation must justify why the correct option is true and others are false.  
        - **Three-Statement Handling**: For "Multiple Statements - How Many Correct" with three statements, use options: "(a) None," "(b) Only one," "(c) Only two," "(d) All three." Generate questions where "None" can be correct by including deliberately false statements.  

        **UPSC Structure to Use:**  
        - Use the following UPSC structure for the MCQ:  
          - **Structure Name**: ${selectedStructure.name}  
          - **Example**: ${selectedStructure.example}  
          - **Options**: ${options.join(", ")} (For "Multiple Statements - How Many Correct," adjust to three-statement options if applicable)  
        - Adapt the deeply researched content to fit this structure creatively and precisely.  

        **Response Structure:**  
        - For the MCQ, use this EXACT structure with PLAIN TEXT headers:  
          Question: [Full question text, following the selected UPSC structure, rich with depth and complexity]  
          Options:  
          (a) [Option A]  
          (b) [Option B]  
          (c) [Option C]  
          (d) [Option D]  
          Correct Answer: [Correct option letter, e.g., (a)]  
          Explanation: [Detailed explanation, 3-5 sentences, weaving chapter content with broader knowledge, justifying the answer with precision and insight. Conclude with: "Thus, the correct answer is [option] because [reason]."]  
        - Separate each section with EXACTLY TWO newlines (\n\n).  
        - Start the response directly with "Question:"—do NOT include any introductory text.  
        - **Special Note for Single Correct Answer Structure**: Include the statements (A-D) directly under the Question text, each statement on a new line.  
        - **Special Note for Multiple Statements Structures**: List the statements under the Question text using decimal numbers (e.g., "1.", "2.", "3.", "4."), each statement on a new line. For three statements, use options: "(a) None," "(b) Only one," "(c) Only two," "(d) All three."  

        **Special Instructions for Specific Categories:**  
        - For "Polity": Use the Laxmikanth's Indian Polity book (File ID: ${fileIds.Polity}), ensuring questions cover constitutional framework, governance, and political dynamics comprehensively.  
        - For "Science": Focus on the Science section of the Disha IAS Previous Year Papers (File ID: ${fileIds.Science}), covering Physics, Chemistry, Biology, and Science & Technology, extrapolating to cutting-edge historical contexts.  
        - For "CSAT": Use the CSAT section (File ID: ${fileIds.CSAT}), integrating complex logical extensions.  
        - For "PreviousYearPapers": Base on the entire Disha IAS book (File ID: ${fileIds.PreviousYearPapers}), weaving in advanced interpretations.  

        **Now, generate 1 MCQ based on the book: "${bookInfo.bookName}" (File ID: ${fileId}) using the "${selectedStructure.name}" structure, focusing on "${selectedTheme}" within "${chapter || 'entire book'}":**
      `;
    }

    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: generalInstruction,
    });

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
      tools: category === "Atlas" ? [] : [{ type: "file_search" }],
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

    // Parse response into MCQs
    const newMCQs = [];
    if (count === 1) {
      newMCQs.push(parseSingleMCQ(responseText));
    } else {
      const mcqTexts = responseText.split("----").map(t => t.trim()).filter(t => t);
      for (const mcqText of mcqTexts) {
        newMCQs.push(parseSingleMCQ(mcqText));
      }
    }

    // Save new MCQs
    if (mongoConnected) {
      for (const mcq of newMCQs) {
        await db.collection("mcqs").insertOne({
          book: bookInfo.bookName,
          category,
          chapter: chapterForQuery,
          mcq,
          createdAt: new Date()
        });
      }
    }

    console.log(`Generated ${newMCQs.length} MCQ${newMCQs.length > 1 ? 's' : ''} for userId=${userId}, category=${category}, chapter=${chapter || 'entire-book'}`);

    res.json({ answers: count === 1 ? newMCQs[0] : newMCQs });
  } finally {
    releaseLock(threadId);
  }
}
  } catch (error) {
    console.error(`Error in /ask endpoint for category=${req.body.category || 'unknown'}:`, {
      message: error.message,
      body: req.body,
    });
    res.status(500).json({ error: "AI service error", details: error.message });
  }

  function parseSingleMCQ(rawResponse) {
    const normalized = rawResponse.replace(/\r\n/g, "\n");
    const sections = normalized.split(/\n\n/).map(s => s.trim()).filter(s => s);
    const questionIndex = sections.findIndex(s => s.startsWith("Question:"));
    const optionsIndex = sections.findIndex(s => s.startsWith("Options:"));
    const correctAnswerIndex = sections.findIndex(s => s.startsWith("Correct Answer:"));
    const explanationIndex = sections.findIndex(s => s.startsWith("Explanation:"));
    let questionLines = [];
    if (questionIndex !== -1) {
      const endIndex = optionsIndex !== -1 ? optionsIndex :
                      correctAnswerIndex !== -1 ? correctAnswerIndex :
                      explanationIndex !== -1 ? explanationIndex : sections.length;
      questionLines = sections.slice(questionIndex, endIndex).join("\n").split("\n");
    }
    const question = questionLines.length > 0
      ? questionLines.join("\n").replace("Question: ", "").split("\n").map(l => l.trim()).filter(l => l)
      : [];
    let optionsSection = "";
    if (optionsIndex !== -1) {
      optionsSection = sections.slice(optionsIndex, correctAnswerIndex !== -1 ? correctAnswerIndex : explanationIndex !== -1 ? explanationIndex : sections.length).join("\n");
    }
    const optionsLines = optionsSection.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("Options:"));
    const options = {};
    optionsLines.forEach(line => {
      const match = line.match(/^\((a|b|c|d)\)\s*(.+)$/i);
      if (match) options[match[1].toUpperCase()] = match[2].trim();
    });
    const correctAnswerLine = correctAnswerIndex !== -1 ? sections[correctAnswerIndex] : null;
    const correctAnswerText = correctAnswerLine ? correctAnswerLine.split("\n")[0] : "";
    const correctAnswerMatch = correctAnswerText.match(/Correct Answer:\s*\(([a-d])\)/i);
    const correctAnswer = correctAnswerMatch ? correctAnswerMatch[1].toUpperCase() : null;
    const explanationLines = explanationIndex !== -1 ? sections.slice(explanationIndex) : [];
    const explanation = explanationLines.length > 0
      ? explanationLines.join(" ").replace("Explanation: ", "").trim()
      : `The correct answer is ${correctAnswer}.`;
    return { question, options, correctAnswer, explanation };
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => console.log(`Backend running on port ${PORT}`));