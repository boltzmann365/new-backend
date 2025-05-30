const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { MongoClient, ObjectId } = require("mongodb");
const tiktoken = require('@dqbd/tiktoken');
const axios = require('axios');
const natural = require('natural');
const cheerio = require('cheerio');
const cron = require('node-cron');
const fs = require('fs'); // Added for generateFalseStatements
const mongodb = require('mongodb');

const dotenv = require('dotenv');
dotenv.config();
const app = express();

app.use(cors({
  origin: ["http://localhost:3000", "http://localhost:3001"],
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control"],
  credentials: true
}));

app.use((req, res, next) => {
  console.log(`Request: ${req.method} ${req.path}, Origin: ${req.headers.origin}`);
  next();
});

app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "OpenAI-Beta": "assistants=v2" }
});

const assistantId = process.env.ASSISTANT_ID;

let db;
let mongoConnected = false;

// Manual retry function for API calls
async function retryRequest(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      console.warn(`Retry ${i + 1}/${retries} failed: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// Unsplash rate limit tracking
let unsplashRequestCount = 0;
const unsplashRateLimit = 50; // Free tier: 50 requests/hour
const rateLimitReset = 3600000; // 1 hour in ms

setInterval(() => {
  unsplashRequestCount = 0;
  console.log("Unsplash request counter reset");
}, rateLimitReset);

const activeBatchSessions = new Map();

async function connectToMongoDB(uri) {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
    retryWrites: true,
    retryReads: true,
    maxPoolSize: 20,
    socketTimeoutMS: 30000
  });
  try {
    console.log("Attempting to connect to MongoDB with URI:", uri.replace(/\/\/.*@/, '//****:****@'));
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    db = client.db("trainwithme");
    mongoConnected = true;

    // Create transformer collection and index
    const collections = await db.listCollections({ name: "transformer" }).toArray();
    if (collections.length === 0) {
      await db.createCollection("transformer");
      await db.collection("transformer").createIndex({ createdAt: -1 }, { background: true });
      console.log("Created transformer collection with createdAt index");
    }

    await db.collection("mcq_generation_instructions").createIndex({ version: 1 }, { unique: true, background: true });
    await db.collection("evaluation_instructions").createIndex({ parameter: 1 }, { unique: true, background: true });
    await db.collection("mcq_to_be_evaluated").createIndex({ createdAt: -1 }, { background: true });
    await db.collection("good_mcqs").createIndex({ createdAt: -1 }, { background: true });
    await db.collection("modified_mcqs").createIndex({ createdAt: -1 }, { background: true });
    await db.collection("reported_mcqs").createIndex({ createdAt: -1 }, { background: true });
    await db.collection("mcqs").createIndex({ createdAt: -1 }, { background: true });
    await db.collection("book_mappings").createIndex({ category: 1, chapter: 1 }, { unique: true, background: true });

    console.log("MongoDB indexes created for collections");
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error.message, error.stack);
    mongoConnected = false;
    throw error;
  }
  return { client, db, mongoConnected };
}

async function initializeCurrentAffairsCollections() {
  const collections = await db.listCollections({ name: "current_affairs_raw" }).toArray();
  if (collections.length === 0) {
    await db.createCollection("current_affairs_raw");
    await db.collection("current_affairs_raw").createIndex({ date: -1, source: 1 }, { background: true });
    console.log("Created current_affairs_raw collection with indexes");
  }

  const articleCollections = await db.listCollections({ name: "current_affairs_articles" }).toArray();
  if (articleCollections.length === 0) {
    await db.createCollection("current_affairs_articles");
    await db.collection("current_affairs_articles").createIndex({ date: -1, category: 1 }, { background: true });
    console.log("Created current_affairs_articles collection with indexes");
  }
}

// Placeholder for generateMCQ (replace with actual implementation)
async function generateMCQ(threadId, category, chapter, node, res) {
  console.log(`Placeholder generateMCQ called for ${category} - ${chapter} - ${node}`);
  return {
    selected_mcq_structure: { name: "Placeholder Structure" },
    mcq: { question: [], options: {}, correctAnswer: "A", explanation: "Placeholder MCQ" }
  };
}

const categoryToBookMap = {
  Polity: {
    bookName: "Laxmikanth Book",
    description: "Laxmikanth book for Indian Polity"
  },
  TamilnaduHistory: {
    bookName: "Tamilnadu History Book",
    description: "Published by Tamilnadu Government, covering Indian history"
  },
  Spectrum: {
    bookName: "Spectrum Book",
    description: "Spectrum book for Modern Indian History"
  },
  ArtAndCulture: {
    bookName: "Nitin Singhania Art and Culture Book",
    description: "Nitin Singhania book for Indian Art and Culture"
  },
  FundamentalGeography: {
    bookName: "NCERT Class 11th Fundamentals of Physical Geography",
    description: "NCERT Class 11th book on Fundamental Geography"
  },
  IndianGeography: {
    bookName: "NCERT Class 11th Indian Geography",
    description: "NCERT Class 11th book on Indian Geography"
  },
  Science: {
    bookName: "Disha IAS Previous Year Papers (Science Section)",
    description: "Disha IAS book, Science section (Physics, Chemistry, Biology, Science & Technology)"
  },
  Environment: {
    bookName: "Shankar IAS Environment Book",
    description: "Shankar IAS book for Environment"
  },
  Economy: {
    bookName: "Ramesh Singh Indian Economy Book",
    description: "Ramesh Singh book for Indian Economy"
  },
  CSAT: {
    bookName: "Disha IAS Previous Year Papers (CSAT Section)",
    description: "Disha IAS book, CSAT section"
  },
  CurrentAffairs: {
    bookName: "Vision IAS Current Affairs Magazine April 2025",
    description: "Vision IAS Current Affairs resource"
  },
  PreviousYearPapers: {
    bookName: "Disha Publication's UPSC Prelims Previous Year Papers",
    description: "Disha IAS book for Previous Year Papers"
  }
};

const bookChaptersMap = {
  Polity: [
    { name: "Historical Background", unit: "Chapter 1" },
    { name: "Making of the Constitution", unit: "Chapter 2" },
    { name: "Salient Features of the Constitution", unit: "Chapter 3" },
    { name: "Preamble of the Constitution", unit: "Chapter 4" },
    { name: "Union and Its Territory", unit: "Chapter 5" },
    { name: "Citizenship", unit: "Chapter 6" },
    { name: "Fundamental Rights", unit: "Chapter 7" },
    { name: "Directive Principles of State Policy", unit: "Chapter 8" },
    { name: "Fundamental Duties", unit: "Chapter 9" },
    { name: "Amendment of the Constitution", unit: "Chapter 10" },
    { name: "Basic Structure of the Constitution", unit: "Chapter 11" },
    { name: "Parliamentary System", unit: "Chapter 12" },
    { name: "Federal System", unit: "Chapter 13" },
    { name: "Centre–State Relations", unit: "Chapter 14" },
    { name: "Inter-State Relations", unit: "Chapter 15" },
    { name: "Emergency Provisions", unit: "Chapter 16" },
    { name: "President", unit: "Chapter 17" },
    { name: "Vice-President", unit: "Chapter 18" },
    { name: "Prime Minister", unit: "Chapter 19" },
    { name: "Central Council of Ministers", unit: "Chapter 20" },
    { name: "Cabinet Committees", unit: "Chapter 21" },
    { name: "Parliament", unit: "Chapter 22" },
    { name: "Parliamentary Committees", unit: "Chapter 23" },
    { name: "Parliamentary Forums", unit: "Chapter 24" },
    { name: "Parliamentary Group", unit: "Chapter 25" },
    { name: "Supreme Court", unit: "Chapter 26" },
    { name: "Judicial Review", unit: "Chapter 27" },
    { name: "Judicial Activism", unit: "Chapter 28" },
    { name: "Public Interest Litigation", unit: "Chapter 29" },
    { name: "Governor", unit: "Chapter 30" },
    { name: "Chief Minister", unit: "Chapter 31" },
    { name: "State Council of Ministers", unit: "Chapter 32" },
    { name: "State Legislature", unit: "Chapter 33" },
    { name: "High Court", unit: "Chapter 34" },
    { name: "Subordinate Courts", unit: "Chapter 35" },
    { name: "Special Status of Jammu & Kashmir", unit: "Chapter 36" },
    { name: "Special Provisions for Some States", unit: "Chapter 37" },
    { name: "Panchayati Raj", unit: "Chapter 38" },
    { name: "Municipalities", unit: "Chapter 39" },
    { name: "Union Territories", unit: "Chapter 40" },
    { name: "Scheduled and Tribal Areas", unit: "Chapter 41" },
    { name: "Election Commission", unit: "Chapter 42" },
    { name: "Union Public Service Commission", unit: "Chapter 43" },
    { name: "State Public Service Commission", unit: "Chapter 44" },
    { name: "Finance Commission", unit: "Chapter 45" },
    { name: "Goods and Services Tax Council", unit: "Chapter 46" },
    { name: "National Commission for SCs", unit: "Chapter 47" },
    { name: "National Commission for STs", unit: "Chapter 48" },
    { name: "National Commission for BCs", unit: "Chapter 49" },
    { name: "Special Officer for Linguistic Minorities", unit: "Chapter 50" },
    { name: "Comptroller and Auditor General of India", unit: "Chapter 51" },
    { name: "Attorney General of India", unit: "Chapter 52" },
    { name: "Advocate General of the State", unit: "Chapter 53" },
    { name: "NITI Aayog", unit: "Chapter 54" },
    { name: "National Human Rights Commission", unit: "Chapter 55" },
    { name: "State Human Rights Commission", unit: "Chapter 56" },
    { name: "Central Information Commission", unit: "Chapter 57" },
    { name: "State Information Commission", unit: "Chapter 58" },
    { name: "Central Vigilance Commission", unit: "Chapter 59" },
    { name: "Central Bureau of Investigation", unit: "Chapter 60" },
    { name: "Lokpal and Lokayuktas", unit: "Chapter 61" },
    { name: "National Investigation Agency", unit: "Chapter 62" },
    { name: "National Disaster Management Authority", unit: "Chapter 63" },
    { name: "Co-operative Societies", unit: "Chapter 64" },
    { name: "Official Language", unit: "Chapter 65" },
    { name: "Public Services", unit: "Chapter 66" },
    { name: "Rights and Liabilities of the Government", unit: "Chapter 67" },
    { name: "Special Provisions Relating to Certain Classes", unit: "Chapter 68" },
    { name: "Political Parties", unit: "Chapter 69" },
    { name: "Role of Regional Parties", unit: "Chapter 70" },
    { name: "Elections", unit: "Chapter 71" },
    { name: "Election Laws", unit: "Chapter 72" },
    { name: "Electoral Reforms", unit: "Chapter 73" },
    { name: "Voting Behaviour", unit: "Chapter 74" },
    { name: "Coalition Government", unit: "Chapter 75" },
    { name: "Anti-Defection Law", unit: "Chapter 76" },
    { name: "Pressure Groups", unit: "Chapter 77" },
    { name: "National Integration", unit: "Chapter 78" },
    { name: "Foreign Policy", unit: "Chapter 79" },
    { name: "National Commission to Review the Working of the Constitution", unit: "Chapter 80" }
  ],
  TamilnaduHistory: [
    { name: "Early India: From the Beginnings to the Indus Civilisation", unit: "Unit 1" },
    { name: "Early India: The Chalcolithic, Megalithic, Iron Age and Vedic Cultures", unit: "Unit 2" },
    { name: "Rise of Territorial Kingdoms and New Religious Sects", unit: "Unit 3" },
    { name: "Emergence of State and Empire", unit: "Unit 4" },
    { name: "Evolution of Society in South India", unit: "Unit 5" },
    { name: "Polity and Society in Post-Mauryan Period", unit: "Unit 6" },
    { name: "The Guptas", unit: "Unit 7" },
    { name: "Harsha and Rise of Regional Kingdoms", unit: "Unit 8" },
    { name: "Cultural Development in South India", unit: "Unit 9" },
    { name: "Advent of Arabs and Turks", unit: "Unit 10" },
    { name: "Later Cholas and Pandyas", unit: "Unit 11" },
    { name: "Bahmani and Vijayanagar Kingdoms", unit: "Unit 12" },
    { name: "Cultural Syncretism: Bhakti Movement in India", unit: "Unit 13" },
    { name: "The Mughal Empire", unit: "Unit 14" },
    { name: "The Marathas", unit: "Unit 15" },
    { name: "The Coming of the Europeans", unit: "Unit 16" },
    { name: "Effects of British Rule", unit: "Unit 17" },
    { name: "Early Resistance to British Rule", unit: "Unit 18" },
    { name: "Towards Modernity", unit: "Unit 19" }
  ],
  Spectrum: [
    { name: "Sources for the History of Modern India", unit: "Unit 1" },
    { name: "Major Approaches to the History of Modern India", unit: "Unit 2" },
    { name: "Advent of the Europeans in India", unit: "Unit 3" },
    { name: "India on the Eve of British Conquest", unit: "Unit 4" },
    { name: "Expansion and Consolidation of British Power in India", unit: "Unit 5" },
    { name: "People's Resistance Against British Before 1857", unit: "Unit 6" },
    { name: "The Revolt of 1857", unit: "Unit 7" },
    { name: "Socio-Religious Reform Movements: General Features", unit: "Unit 8" },
    { name: "A General Survey of Socio-Cultural Reform Movements", unit: "Unit 9" },
    { name: "Beginning of Modern Nationalism in India", unit: "Unit 10" },
    { name: "Indian National Congress: Foundation and the Moderate Phase", unit: "Unit 11" },
    { name: "Era of Militant Nationalism (1905-1909)", unit: "Unit 12" },
    { name: "First Phase of Revolutionary Activities (1907-1917)", unit: "Unit 13" },
    { name: "First World War and Nationalist Response", unit: "Unit 14" },
    { name: "Emergence of Gandhi", unit: "Unit 15" },
    { name: "Non-Cooperation Movement and Khilafat Aandolan", unit: "Unit 16" },
    { name: "Emergence of Swarajists, Socialist Ideas, Revolutionary Activities and Other New Forces", unit: "Unit 17" },
    { name: "Simon Commission and the Nehru Report", unit: "Unit 18" },
    { name: "Civil Disobedience Movement and Round Table Conferences", unit: "Unit 19" },
    { name: "Debates on the Future Strategy after Civil Disobedience Movement", unit: "Unit 20" },
    { name: "Congress Rule in Provinces", unit: "Unit 21" },
    { name: "Nationalist Response in the Wake of World War II", unit: "Unit 22" },
    { name: "Quit India Movement, Demand for Pakistan, and the INA", unit: "Unit 23" },
    { name: "Post-War National Scenario", unit: "Unit 24" },
    { name: "Independence with Partition", unit: "Unit 25" },
    { name: "Constitutional, Administrative and Judicial Developments", unit: "Unit 26" },
    { name: "Survey of British Policies in India", unit: "Unit 27" },
    { name: "Economic Impact of British Rule in India", unit: "Unit 28" },
    { name: "Development of Indian Press", unit: "Unit 29" },
    { name: "Development of Education", unit: "Unit 30" },
    { name: "Peasant Movements 1857-1947", unit: "Unit 31" },
    { name: "The Movement of the Working Class", unit: "Unit 32" },
    { name: "Challenges Before the New-born Nation", unit: "Unit 33" },
    { name: "The Indian States", unit: "Unit 34" },
    { name: "Making of the Constitution for India", unit: "Unit 35" },
    { name: "The Evolution of Nationalist Foreign Policy", unit: "Unit 36" },
    { name: "First General Elections", unit: "Unit 37" },
    { name: "Developments under Nehru's Leadership (1947-64)", unit: "Unit 38" },
    { name: "After Nehru", unit: "Unit 39" }
  ],
  ArtAndCulture: [
    { name: "Indian Architecture, Sculpture and Pottery", unit: "Chapter 1" },
    { name: "Indian Paintings", unit: "Chapter 2" },
    { name: "Indian Handicrafts", unit: "Chapter 3" },
    { name: "UNESCO's List of World Heritage Sites in India", unit: "Chapter 4" },
    { name: "Indian Music", unit: "Chapter 5" },
    { name: "Indian Dance Forms", unit: "Chapter 6" },
    { name: "Indian Theatre", unit: "Chapter 7" },
    { name: "Indian Puppetry", unit: "Chapter 8" },
    { name: "Indian Circus", unit: "Chapter 9" },
    { name: "Martial Arts in India", unit: "Chapter 10" },
    { name: "UNESCO's List of Intangible Cultural Heritage", unit: "Chapter 11" },
    { name: "Languages in India", unit: "Chapter 12" },
    { name: "Religion in India", unit: "Chapter 13" },
    { name: "Buddhism and Jainism", unit: "Chapter 14" },
    { name: "Indian Literature", unit: "Chapter 15" },
    { name: "Schools of Philosophy", unit: "Chapter 16" },
    { name: "Indian Cinema", unit: "Chapter 17" },
    { name: "Science and Technology through the Ages", unit: "Chapter 18" },
    { name: "Calendars in India", unit: "Chapter 19" },
    { name: "Fairs and Festivals of India", unit: "Chapter 20" },
    { name: "Awards and Honours", unit: "Chapter 21" },
    { name: "Law and Culture", unit: "Chapter 22" },
    { name: "Cultural Institutions in India", unit: "Chapter 23" },
    { name: "Coins in Ancient and Medieval India", unit: "Chapter 24" },
    { name: "Indian Culture Abroad", unit: "Chapter 25" },
    { name: "India through the Eyes of Foreign Travellers", unit: "Chapter 26" }
  ],
  FundamentalGeography: [
    { name: "Geography as a Discipline", unit: "Chapter 1" },
    { name: "The Origin and Evolution of Earth", unit: "Chapter 2" },
    { name: "Interior of the Earth", unit: "Chapter 3" },
    { name: "Distribution of Oceans and Continents", unit: "Chapter 4" },
    { name: "Minerals and Rocks", unit: "Chapter 5" },
    { name: "Geomorphic Processes", unit: "Chapter 6" },
    { name: "Landforms and their Evolution", unit: "Chapter 7" },
    { name: "Composition and Structure of Atmosphere", unit: "Chapter 8" },
    { name: "Solar Radiation, Heat Balance and Temperature", unit: "Chapter 9" },
    { name: "Atmospheric Circulation and Weather Systems", unit: "Chapter 10" },
    { name: "Water in the Atmosphere", unit: "Chapter 11" },
    { name: "World Climate and Climate Change", unit: "Chapter 12" },
    { name: "Water (Oceans)", unit: "Chapter 13" },
    { name: "Movements of Ocean Water", unit: "Chapter 14" },
    { name: "Life on the Earth", unit: "Chapter 15" },
    { name: "Biodiversity and Conservation", unit: "Chapter 16" }
  ],
  IndianGeography: [
    { name: "India- Location", unit: "Chapter 1" },
    { name: "Structure and Physiography", unit: "Chapter 2" },
    { name: "Drainage System", unit: "Chapter 3" },
    { name: "Climate", unit: "Chapter 4" },
    { name: "Natural Vegetation", unit: "Chapter 5" },
    { name: "Soils", unit: "Chapter 6" },
    { name: "Natural Hazards and Disasters", unit: "Chapter 7" }
  ],
  Science: [
    { name: "Physics", unit: "Chapter 1" },
    { name: "Chemistry", unit: "Chapter 2" },
    { name: "Biology", unit: "Chapter 3" },
    { name: "Science and Technology", unit: "Chapter 4" }
  ],
  Environment: [
    { name: "Ecology", unit: "Chapter 1" },
    { name: "Functions of an Ecosystem", unit: "Chapter 2" },
    { name: "Terrestrial Ecosystem", unit: "Chapter 3" },
    { name: "Aquatic Ecosystem", unit: "Chapter 4" },
    { name: "Environmental Pollution", unit: "Chapter 5" },
    { name: "Renewable Energy", unit: "Chapter 6" },
    { name: "Environmental Issues", unit: "Chapter 7" },
    { name: "Environmental Impact Assessment", unit: "Chapter 8" },
    { name: "Biodiversity", unit: "Chapter 9" },
    { name: "Indian Biodiversity", unit: "Chapter 10" },
    { name: "Schedule Animals of Wildlife Protection Act, 1972", unit: "Chapter 11" },
    { name: "Animal Diversity of India", unit: "Chapter 12" },
    { name: "Plant Diversity of India", unit: "Chapter 13" },
    { name: "Marine Organisms", unit: "Chapter 14" },
    { name: "Protected Areas Network", unit: "Chapter 15" },
    { name: "Conservation Efforts", unit: "Chapter 16" },
    { name: "Climate Change", unit: "Chapter 17" },
    { name: "Ocean Acidification", unit: "Chapter 18" },
    { name: "Ozone Depletion", unit: "Chapter 19" },
    { name: "Impact of Climate Change – India", unit: "Chapter 20" },
    { name: "Mitigation Strategies", unit: "Chapter 21" },
    { name: "India and Climate Change", unit: "Chapter 22" },
    { name: "Climate Change Organisations", unit: "Chapter 23" },
    { name: "Agriculture", unit: "Chapter 24" },
    { name: "Acts and Policies", unit: "Chapter 25" },
    { name: "Institutions and Measures", unit: "Chapter 26" },
    { name: "Environmental Organisations", unit: "Chapter 27" },
    { name: "International Environmental Conventions", unit: "Chapter 28" },
    { name: "Environment Issues and Health Effects", unit: "Chapter 29" }
  ],
  Economy: [
    { name: "Introduction", unit: "Chapter 1" },
    { name: "Growth, Development and Happiness", unit: "Chapter 2" },
    { name: "Evolution of the Indian Economy", unit: "Chapter 3" },
    { name: "Economic Planning", unit: "Chapter 4" },
    { name: "Planning in India", unit: "Chapter 5" },
    { name: "Economic Reforms", unit: "Chapter 6" },
    { name: "Inflation and Business Cycle", unit: "Chapter 7" },
    { name: "Agriculture and Food Management", unit: "Chapter 8" },
    { name: "Industry and Infrastructure", unit: "Chapter 9" },
    { name: "Services Sector", unit: "Chapter 10" },
    { name: "Indian Financial Market", unit: "Chapter 11" },
    { name: "Banking in India", unit: "Chapter 12" },
    { name: "Insurance in India", unit: "Chapter 13" },
    { name: "Security Market in India", unit: "Chapter 14" },
    { name: "External Sector in India", unit: "Chapter 15" },
    { name: "International Economic Organisations and India", unit: "Chapter 16" },
    { name: "Tax Structure in India", unit: "Chapter 17" },
    { name: "Public Finance in India", unit: "Chapter 18" },
    { name: "Sustainability and Climate Change: India and the World", unit: "Chapter 19" },
    { name: "Human Development in India", unit: "Chapter 20" },
    { name: "Burning Socio-Economic Issues", unit: "Chapter 21" },
    { name: "Economic Concepts and Terminologies", unit: "Chapter 22" }
  ],
  CSAT: [
    { name: "Maths and Reasoning", unit: "Chapter 1" },
    { name: "English", unit: "Chapter 2" }
  ],
  CurrentAffairs: [
    { name: "Polity and Governance", unit: "Chapter 1" },
    { name: "International Relations", unit: "Chapter 2" },
    { name: "Economy", unit: "Chapter 3" },
    { name: "Security", unit: "Chapter 4" },
    { name: "Environment", unit: "Chapter 5" },
    { name: "Social Issues", unit: "Chapter 6" },
    { name: "Science and Technology", unit: "Chapter 7" },
    { name: "Culture", unit: "Chapter 8" },
    { name: "Ethics", unit: "Chapter 9" },
    { name: "Schemes in News", unit: "Chapter 10" },
    { name: "Places in News", unit: "Chapter 11" },
    { name: "Personalities in News", unit: "Chapter 12" }
  ],
  PreviousYearPapers: [
    { name: "History", unit: "Chapter 1" },
    { name: "Geography", unit: "Chapter 2" },
    { name: "Polity", unit: "Chapter 3" },
    { name: "Economy", unit: "Chapter 4" },
    { name: "Environment", unit: "Chapter 5" },
    { name: "Science", unit: "Chapter 6" }
  ]
};

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

const waitForRunToComplete = async (threadId, runId) => {
  while (true) {
    try {
      const runStatus = await openai.beta.threads.runs.retrieve(threadId, runId);
      if (runStatus.status === "completed" || runStatus.status === "failed" || runStatus.status === "cancelled") {
        console.log(`Run ${runId} completed with status: ${runStatus.status}`);
        return runStatus;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Error checking run status for run ${runId}:`, error.message, error.stack);
      throw error;
    }
  }
};

function getFullChapterName(chapterKey, category) {
  const chapters = bookChaptersMap[category] || [];
  const chapter = chapters.find(ch => {
    const fullName = `${ch.unit} ${ch.name}`.trim();
    return chapterKey.toLowerCase() === fullName.toLowerCase() || chapterKey.toLowerCase() === ch.name.toLowerCase();
  });
  return chapter ? `${chapter.unit} ${chapter.name}`.trim() : chapterKey;
}

async function generateTreeStructure(threadId, category, chapter) {
  const bookName = categoryToBookMap[category].bookName;

  const prompt = `
You are an AI designed to create a detailed tree structure for a specific chapter from the "${bookName}" for the TrainWithMe platform, suitable for generating UPSC-style MCQs. The chapter to analyze is "${chapter}". Use your knowledge of the book and chapter to generate the structure without retrieving external content.

**Instructions for Tree Structure Generation:**
- For "CurrentAffairs", focus on recent events, policies, and issues from April 2025 (e.g., government schemes, international summits, economic policies, environmental initiatives, technological advancements, or notable personalities) based on your knowledge of current affairs trends, without using external sources.
- For other categories, generate the structure based on your knowledge of the specified chapter from the respective book (e.g., Laxmikanth for Polity, Spectrum for Modern History), capturing key concepts, facts, and specifics relevant to the subject.
- Create a hierarchical tree structure with the following levels:
  - **topics**: Main themes of the chapter (e.g., for CurrentAffairs: "New Government Schemes"; for Polity: "Fundamental Rights").
  - **subtopics**: Specific events or sub-themes (e.g., for CurrentAffairs: "PM Suryodaya Yojana 2025"; for Polity: "Right to Equality").
  - **details**: Key aspects of each subtopic (e.g., for CurrentAffairs: "Scheme Objectives"; for Polity: "Article 14").
  - **subdetails**: Granular points (e.g., for CurrentAffairs: "Funding Allocation"; for Polity: "Equality Before Law").
  - **particulars**: Specific facts or examples (e.g., for CurrentAffairs: "Launched April 15, 2025", "Rs 20,000 crore budget"; for Polity: "Article 14 ensures equal protection") as an array of strings.
- Ensure the structure is detailed, fact-based, and reflects the chapter’s content for MCQ generation.
- Each topic, subtopic, detail, and subdetail should have a descriptive name relevant to the content.
- Limit the depth to 5 levels (topics → subtopics → details → subdetails → particulars).
- Include 1-3 subtopics per topic, 1-2 details per subtopic, 1-2 subdetails per detail, and 1-3 particulars per subdetail.
- If you lack sufficient knowledge for the chapter, return: {"topics": [], "note": "Insufficient knowledge for '${bookName}', chapter '${chapter}'. Please ensure the chapter is valid."}.
- Include a note summarizing the generated content (e.g., for CurrentAffairs: "Generated content: 3 new schemes in Polity and Governance"; for Polity: "Generated content: Fundamental Rights articles").

**Output Format:**
Return a JSON object with the following structure:
{
  "topics": [
    {
      "topic": "Theme",
      "subtopics": [
        {
          "subtopic": "Event or Sub-theme",
          "details": [
            {
              "detail": "Aspect",
              "subdetails": [
                {
                  "subdetail": "Granular Point",
                  "particulars": ["Fact 1", "Fact 2"]
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  "note": "Summary of generated content or error message"
}
Return only the JSON object, no additional text.
`;

  let treeStructure;
  try {
    await acquireLock(threadId);
    console.log(`Sending tree structure generation request to OpenAI thread ${threadId} for ${category} - ${chapter}`);
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: prompt
    });

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId
    }, { maxRetries: 3 });

    const runStatus = await waitForRunToComplete(threadId, run.id);
    if (runStatus.status === "failed") {
      throw new Error(`OpenAI run failed: ${runStatus.last_error?.message || "Unknown failure reason"}`);
    }

    const messages = await openai.beta.threads.messages.list(threadId);
    const latestMessage = messages.data.find(m => m.role === "assistant");
    if (!latestMessage || !latestMessage.content[0]?.text?.value) {
      throw new Error("No response from OpenAI for tree structure generation");
    }

    const responseText = latestMessage.content[0].text.value;
    console.log(`OpenAI response for ${category} - ${chapter}:`, responseText);
    treeStructure = safeJsonParse(responseText);
    if (treeStructure.error || !treeStructure.topics) {
      throw new Error(`Failed to parse OpenAI response as valid tree structure: ${treeStructure.details || "Invalid format"}`);
    }
  } finally {
    releaseLock(threadId);
  }

  return treeStructure;
}

async function enhanceTreeStructure(threadId, category, chapter, existingStructure) {
  const bookName = categoryToBookMap[category].bookName;

  const prompt = `
You are an AI designed to provide new additions to an existing tree structure for a book chapter on the TrainWithMe platform, based on your knowledge of the chapter’s content. The book is "${bookName}", and the chapter is "${chapter}". The existing tree structure is:

${JSON.stringify(existingStructure, null, 2)}

**Instructions for Providing New Additions:**
- Analyze the content of the specified chapter ("${chapter}") from the book using your knowledge, without retrieving external content.
- Identify new, unique subtopics, details, subdetails, or particulars not already present in the existing tree structure.
- Do not modify, remove, or duplicate any existing entries in the provided tree structure. Only provide new entries that complement the existing structure without redundancy.
- Focus on underrepresented or missing aspects of the chapter content. For example, if the chapter is an introduction, include foundational concepts, historical context, or emerging trends not yet covered.
- Structure the new entries hierarchically, matching the levels: topics → subtopics → details → subdetails → particulars.
- Add at least 1-2 new subtopics per topic, 1-2 new details per subtopic, 1-2 new subdetails per detail, or 1-3 new particulars per subdetail, based on the chapter's content. If no new content is found, return an empty structure with a note explaining why.
- Limit the depth to 5 levels (topics → subtopics → details → subdetails → particulars).
- Ensure each new entry is unique by comparing against the existing tree's content (e.g., avoid repeating facts like "National Physical Laboratory set up in 1947" if already present).

**Output Format:**
Return a JSON object containing only the new entries to be added, structured as follows:
{
  "newTopics": [
    {
      "topic": "New Main Theme",
      "subtopics": [
        {
          "subtopic": "New Sub-theme",
          "details": [
            {
              "detail": "New Specific Aspect",
              "subdetails": [
                {
                  "subdetail": "New Granular Point",
                  "particulars": ["New Fact 1", "New Fact 2"]
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  "newSubtopics": [
    {
      "parentPath": "root.topics[0]",
      "subtopic": "New Sub-theme",
      "details": [
        {
          "detail": "New Specific Aspect",
          "subdetails": [
            {
              "subdetail": "New Granular Point",
              "particulars": ["New Fact 1", "New Fact 2"]
            }
          ]
        }
      ]
    }
  ],
  "newDetails": [
    {
      "parentPath": "root.topics[0].subtopics[0]",
      "detail": "New Specific Aspect",
      "subdetails": [
        {
          "subdetail": "New Granular Point",
          "particulars": ["New Fact 1", "New Fact 2"]
        }
      ]
    }
  ],
  "newSubdetails": [
    {
      "parentPath": "root.topics[0].subtopics[0].details[0]",
      "subdetail": "New Granular Point",
      "particulars": ["New Fact 1", "New Fact 2"]
    }
  ],
  "newParticulars": [
    {
      "parentPath": "root.topics[0].subtopics[0].details[0].subdetails[0]",
      "particulars": ["New Fact 1", "New Fact 2"]
    }
  ],
  "note": "Optional explanation if no new entries are added (e.g., 'All chapter content already covered')."
}
- "newTopics" contains entirely new topics to be added at the root.
- "newSubtopics" contains new subtopics to be added under existing topics, with "parentPath" indicating the topic (e.g., "root.topics[0]").
- "newDetails" contains new details to be added under existing subtopics, with "parentPath" (e.g., "root.topics[0].subtopics[0]").
- "newSubdetails" contains new subdetails to be added under existing details, with "parentPath" (e.g., "root.topics[0].subtopics[0].details[0]").
- "newParticulars" contains new particulars to be added under existing subdetails, with "parentPath" (e.g., "root.topics[0].subtopics[0].details[0].subdetails[0]").
- If no new entries are possible, return an empty structure with a "note" explaining why.
- Return only the JSON object, no additional text.
`;

  let newEntries;
  try {
    await acquireLock(threadId);
    console.log(`Sending tree structure enhancement request to OpenAI thread ${threadId} for ${category} - ${chapter}`);
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: prompt
    });

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId
    }, { maxRetries: 3 });

    const runStatus = await waitForRunToComplete(threadId, run.id);
    if (runStatus.status === "failed") {
      throw new Error(`OpenAI run failed: ${runStatus.last_error?.message || "Unknown failure reason"}`);
    }

    const messages = await openai.beta.threads.messages.list(threadId);
    const latestMessage = messages.data.find(m => m.role === "assistant");
    if (!latestMessage || !latestMessage.content[0]?.text?.value) {
      throw new Error("No response from OpenAI for tree structure enhancement");
    }

    const responseText = latestMessage.content[0].text.value;
    console.log(`Raw OpenAI response for ${category} - ${chapter}:`, responseText);
    newEntries = safeJsonParse(responseText);
    if (newEntries.error) {
      throw new Error(`Failed to parse OpenAI response as JSON: ${newEntries.details}`);
    }
    if (!newEntries.newTopics && !newEntries.newSubtopics && !newEntries.newDetails && !newEntries.newSubdetails && !newEntries.newParticulars) {
      console.warn(`No new entries provided by OpenAI for ${category} - ${chapter}. Note: ${newEntries.note || "No note provided"}`);
    }
  } finally {
    releaseLock(threadId);
  }

  let enhancedStructure = JSON.parse(JSON.stringify(existingStructure));

  function getOrCreateNode(path, structure) {
    const parts = path.replace(/^root\./, '').split(/[\.\[\]]+/).filter(p => p);
    let current = structure;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.match(/^(topics|subtopics|details|subdetails|particulars)$/)) {
        const key = part;
        const nextPart = parts[++i];
        if (!nextPart || !nextPart.match(/^\d+$/)) {
          throw new Error(`Invalid path format at ${path}: expected index after ${key}`);
        }
        const index = parseInt(nextPart);
        if (!current[key]) current[key] = [];
        if (!current[key][index]) current[key][index] = {};
        current = current[key][index];
      } else {
        current = current[part] = current[part] || {};
      }
    }
    return current;
  }

  if (newEntries.newTopics && Array.isArray(newEntries.newTopics)) {
    if (!enhancedStructure.topics) enhancedStructure.topics = [];
    console.log(`Adding ${newEntries.newTopics.length} new topics`);
    enhancedStructure.topics.push(...newEntries.newTopics);
  }

  if (newEntries.newSubtopics && Array.isArray(newEntries.newSubtopics)) {
    for (const newSubtopic of newEntries.newSubtopics) {
      try {
        const parentNode = getOrCreateNode(newSubtopic.parentPath, enhancedStructure);
        if (!parentNode.subtopics) parentNode.subtopics = [];
        console.log(`Adding new subtopic at ${newSubtopic.parentPath}: ${newSubtopic.subtopic}`);
        parentNode.subtopics.push(newSubtopic);
      } catch (error) {
        console.error(`Failed to add subtopic at ${newSubtopic.parentPath}:`, error.message);
      }
    }
  }

  if (newEntries.newDetails && Array.isArray(newEntries.newDetails)) {
    for (const newDetail of newEntries.newDetails) {
      try {
        const parentNode = getOrCreateNode(newDetail.parentPath, enhancedStructure);
        if (!parentNode.details) parentNode.details = [];
        console.log(`Adding new detail at ${newDetail.parentPath}: ${newDetail.detail}`);
        parentNode.details.push(newDetail);
      } catch (error) {
        console.error(`Failed to add detail at ${newDetail.parentPath}:`, error.message);
      }
    }
  }

  if (newEntries.newSubdetails && Array.isArray(newEntries.newSubdetails)) {
    for (const newSubdetail of newEntries.newSubdetails) {
      try {
        const parentNode = getOrCreateNode(newSubdetail.parentPath, enhancedStructure);
        if (!parentNode.subdetails) parentNode.subdetails = [];
        console.log(`Adding new subdetail at ${newSubdetail.parentPath}: ${newSubdetail.subdetail}`);
        parentNode.subdetails.push(newSubdetail);
      } catch (error) {
        console.error(`Failed to add subdetail at ${newSubdetail.parentPath}:`, error.message);
      }
    }
  }

  if (newEntries.newParticulars && Array.isArray(newEntries.newParticulars)) {
    for (const newParticular of newEntries.newParticulars) {
      try {
        const parentNode = getOrCreateNode(newParticular.parentPath, enhancedStructure);
        if (!parentNode.particulars) parentNode.particulars = [];
        console.log(`Adding ${newParticular.particulars.length} new particulars at ${newParticular.parentPath}`);
        parentNode.particulars.push(...newParticular.particulars);
      } catch (error) {
        console.error(`Failed to add particulars at ${newParticular.parentPath}:`, error.message);
      }
    }
  }

  return enhancedStructure;
}

async function isChapterMapped(category, chapter) {
  const mapping = await db.collection("book_mappings").findOne({ category, chapter });
  return !!mapping && mapping.mapped === true;
}

async function fetchTreeStructure(category, chapter) {
  try {
    const mapping = await db.collection("book_mappings").findOne({ category, chapter });
    if (!mapping || !mapping.mappings) {
      console.log(`No mapping found for ${category} - ${chapter}, skipping chapter`);
      throw new Error(`No mapping found for ${category} - ${chapter}`);
    }
    return mapping.mappings;
  } catch (error) {
    console.error(`Error fetching tree structure for ${category} - ${chapter}:`, error.message, error.stack);
    throw error;
  }
}

function selectRandomNode(tree) {
  if (!tree || !tree.topics || !Array.isArray(tree.topics)) {
    throw new Error("Invalid tree structure");
  }

  const nodes = [];

  function traverse(node) {
    if (typeof node === 'string') {
      nodes.push(node);
      return;
    }

    if (typeof node !== 'object' || !node) return;

    if (node.topic || node.subtopic || node.detail || node.subdetail) {
      nodes.push(node.topic || node.subtopic || node.detail || node.subdetail);
    }

    const levelKeys = ['topics', 'subtopics', 'details', 'subdetails', 'particulars'];
    for (const key of levelKeys) {
      if (node[key] && Array.isArray(node[key])) {
        node[key].forEach((child, index) => {
          const childValue = typeof child === 'string' ? child : (child.topic || child.subtopic || child.detail || child.subdetail || `Unnamed ${key.slice(0, -1)} ${index + 1}`);
          if (typeof child === 'string') {
            nodes.push(childValue);
          }
          traverse(child);
        });
      }
    }
  }

  tree.topics.forEach((topic, index) => {
    const topicValue = topic.topic || `Unnamed Topic ${index + 1}`;
    nodes.push(topicValue);
    traverse(topic);
  });

  if (nodes.length === 0) {
    throw new Error("No valid nodes found in the tree structure");
  }

  const randomIndex = Math.floor(Math.random() * nodes.length);
  return nodes[randomIndex];
}

const mcqStructures = [
  {
    name: "Single Correct Answer Direct - Correct A",
    options_template: "(a) [Option A] (b) [Option B] (c) [Option C] (d) [Option D]",
    correct_answer: "A",
    explanation_format: "The statement is correct because [Option A] aligns with historical facts: [specific reason]. Options B, C, and D are incorrect due to [misconception 1], [misconception 2], and [misconception 3]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (a) because [reason]."
  },
  {
    name: "Single Correct Answer Direct - Correct B",
    options_template: "(a) [Option A] (b) [Option B] (c) [Option C] (d) [Option D]",
    correct_answer: "B",
    explanation_format: "The statement is correct because [Option B] aligns with historical facts: [specific reason]. Options A, C, and D are incorrect due to [misconception 1], [misconception 2], and [misconception 3]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (b) because [reason]."
  },
  {
    name: "Single Correct Answer Direct - Correct C",
    options_template: "(a) [Option A] (b) [Option B] (c) [Option C] (d) [Option D]",
    correct_answer: "C",
    explanation_format: "The statement is correct because [Option C] aligns with historical facts: [specific reason]. Options A, B, and D are incorrect due to [misconception 1], [misconception 2], and [misconception 3]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (c) because [reason]."
  },
  {
    name: "Single Correct Answer Direct - Correct D",
    options_template: "(a) [Option A] (b) [Option B] (c) [Option C] (d) [Option D]",
    correct_answer: "D",
    explanation_format: "The statement is correct because [Option D] aligns with historical facts: [specific reason]. Options A, B, and C are incorrect due to [misconception 1], [misconception 2], and [misconception 3]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (d) because [reason]."
  },
  {
    name: "Multiple Statements Which Correct 2 Statements - 1 Only",
    options_template: "(a) 1 only (b) 2 only (c) Both 1 and 2 (d) Neither 1 nor 2",
    correct_answer: "A",
    explanation_format: "Statement 1 is correct: [specific reason]. Statement 2 is incorrect: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (a) because only statement 1 is correct."
  },
  {
    name: "Multiple Statements Which Correct 2 Statements - 2 Only",
    options_template: "(a) 1 only (b) 2 only (c) Both 1 and 2 (d) Neither 1 nor 2",
    correct_answer: "B",
    explanation_format: "Statement 1 is incorrect: [specific reason]. Statement 2 is correct: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (b) because only statement 2 is correct."
  },
  {
    name: "Multiple Statements Which Correct 2 Statements - Both 1 and 2",
    options_template: "(a) 1 only (b) 2 only (c) Both 1 and 2 (d) Neither 1 nor 2",
    correct_answer: "C",
    explanation_format: "Statement 1 is correct: [specific reason]. Statement 2 is correct: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (c) because both statements are correct."
  },
  {
    name: "Multiple Statements Which Correct 2 Statements - Neither 1 nor 2",
    options_template: "(a) 1 only (b) 2 only (c) Both 1 and 2 (d) Neither 1 nor 2",
    correct_answer: "D",
    explanation_format: "Statement 1 is incorrect: [specific reason]. Statement 2 is incorrect: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (d) because neither statement is correct."
  },
  {
    name: "Multiple Statements Which Correct 3 Statements - 1 and 2 Only",
    options_template: "(a) 1 and 2 only (b) 2 and 3 only (c) 1 and 3 only (d) 1, 2 and 3",
    correct_answer: "A",
    explanation_format: "Statement 1 is correct: [specific reason]. Statement 2 is correct: [specific reason]. Statement 3 is incorrect: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (a) because statements 1 and 2 are correct."
  },
  {
    name: "Multiple Statements Which Correct 3 Statements - 2 and 3 Only",
    options_template: "(a) 1 and 2 only (b) 2 and 3 only (c) 1 and 3 only (d) 1, 2 and 3",
    correct_answer: "B",
    explanation_format: "Statement 1 is incorrect: [specific reason]. Statement 2 is correct: [specific reason]. Statement 3 is correct: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (b) because statements 2 and 3 are correct."
  },
  {
    name: "Multiple Statements Which Correct 3 Statements - 1 and 3 Only",
    options_template: "(a) 1 and 2 only (b) 2 and 3 only (c) 1 and 3 only (d) 1, 2 and 3",
    correct_answer: "C",
    explanation_format: "Statement 1 is correct: [specific reason]. Statement 2 is incorrect: [specific reason]. Statement 3 is correct: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (c) because statements 1 and 3 are correct."
  },
  {
    name: "Multiple Statements Which Correct 3 Statements - All Correct",
    options_template: "(a) 1 and 2 only (b) 2 and 3 only (c) 1 and 3 only (d) 1, 2 and 3",
    correct_answer: "D",
    explanation_format: "Statement 1 is correct: [specific reason]. Statement 2 is correct: [specific reason]. Statement 3 is correct: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (d) because all statements are correct."
  },
  {
    name: "Multiple Statements Which Correct 4 Statements - 1, 2 and 3 Only",
    options_template: "(a) 1, 2 and 3 only (b) 2, 3 and 4 only (c) 1, 3 and 4 only (d) 1, 2, 3 and 4",
    correct_answer: "A",
    explanation_format: "Statements 1, 2, and 3 are correct: [specific reasons]. Statement 4 is incorrect: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (a) because statements 1, 2, and 3 are correct."
  },
  {
    name: "Multiple Statements Which Correct 4 Statements - 2, 3 and 4 Only",
    options_template: "(a) 1, 2 and 3 only (b) 2, 3 and 4 only (c) 1, 3 and 4 only (d) 1, 2, 3 and 4",
    correct_answer: "B",
    explanation_format: "Statement 1 is incorrect: [specific reason]. Statements 2, 3, and 4 are correct: [specific reasons]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (b) because statements 2, 3, and 4 are correct."
  },
  {
    name: "Multiple Statements Which Correct 4 Statements - 1, 3 and 4 Only",
    options_template: "(a) 1, 2 and 3 only (b) 2, 3 and 4 only (c) 1, 3 and 4 only (d) 1, 2, 3 and 4",
    correct_answer: "C",
    explanation_format: "Statements 1, 3, and 4 are correct: [specific reasons]. Statement 2 is incorrect: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (c) because statements 1, 3, and 4 are correct."
  },
  {
    name: "Multiple Statements Which Correct 4 Statements - All Correct",
    options_template: "(a) 1, 2 and 3 only (b) 2, 3 and 4 only (c) 1, 3 and 4 only (d) 1, 2, 3 and 4",
    correct_answer: "D",
    explanation_format: "All statements are correct: [specific reasons for each]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (d) because all statements are correct."
  },
  {
    name: "Statement I and Statement II - Both Correct and II Explains I",
    options_template: "(a) Both Statement-I and Statement-II are correct and Statement-II explains Statement-I (b) Both Statement-I and Statement-II are correct, but Statement-II does not explain Statement-I (c) Statement-I is correct, but Statement-II is incorrect (d) Statement-I is incorrect, but Statement-II is correct",
    correct_answer: "A",
    explanation_format: "Statement I is correct: [specific reason]. Statement II is correct and explains Statement I: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (a) because both statements are correct and Statement II explains Statement I."
  },
  {
    name: "Statement I and Statement II - Both Correct but II Does Not Explain I",
    options_template: "(a) Both Statement-I and Statement-II are correct and Statement-II explains Statement-I (b) Both Statement-I and Statement-II are correct, but Statement-II does not explain Statement-I (c) Statement-I is correct, but Statement-II is incorrect (d) Statement-I is incorrect, but Statement-II is correct",
    correct_answer: "B",
    explanation_format: "Statement I is correct: [specific reason]. Statement II is correct: [specific reason]. However, Statement II does not explain Statement I: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (b) because both are correct but Statement II does not explain Statement I."
  },
  {
    name: "Statement I and Statement II - I Correct II Incorrect",
    options_template: "(a) Both Statement-I and Statement-II are correct and Statement-II explains Statement-I (b) Both Statement-I and Statement-II are correct, but Statement-II does not explain Statement-I (c) Statement-I is correct, but Statement-II is incorrect (d) Statement-I is incorrect, but Statement-II is correct",
    correct_answer: "C",
    explanation_format: "Statement I is correct: [specific reason]. Statement II is incorrect: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (c) because Statement I is correct, but Statement II is incorrect."
  },
  {
    name: "Statement I and Statement II - I Incorrect II Correct",
    options_template: "(a) Both Statement-I and Statement-II are correct and Statement-II explains Statement-I (b) Both Statement-I and Statement-II are correct, but Statement-II does not explain Statement-I (c) Statement-I is correct, but Statement-II is incorrect (d) Statement-I is incorrect, but Statement-II is correct",
    correct_answer: "D",
    explanation_format: "Statement I is incorrect: [specific reason]. Statement II is correct: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (d) because Statement I is incorrect, but Statement II is correct."
  },
  {
    name: "Matching Pairs How Many Correct 3 Pairs - Only One Pair",
    options_template: "(a) Only one pair (b) Only two pairs (c) All three pairs (d) None of the pairs",
    correct_answer: "A",
    explanation_format: "Pair 1 is correct: [specific reason]. Pairs 2 and 3 are incorrect: [specific reasons]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (a) because only one pair is correctly matched."
  },
  {
    name: "Matching Pairs How Many Correct 3 Pairs - Only Two Pairs",
    options_template: "(a) Only one pair (b) Only two pairs (c) All three pairs (d) None of the pairs",
    correct_answer: "B",
    explanation_format: "Pairs 1 and 2 are correct: [specific reasons]. Pair 3 is incorrect: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (b) because only two pairs are correctly matched."
  },
  {
    name: "Matching Pairs How Many Correct 3 Pairs - All Three Pairs",
    options_template: "(a) Only one pair (b) Only two pairs (c) All three pairs (d) None of the pairs",
    correct_answer: "C",
    explanation_format: "All pairs are correct: [specific reasons for each]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (c) because all three pairs are correctly matched."
  },
  {
    name: "Matching Pairs How Many Correct 3 Pairs - None of the Pairs",
    options_template: "(a) Only one pair (b) Only two pairs (c) All three pairs (d) None of the pairs",
    correct_answer: "D",
    explanation_format: "All pairs are incorrect: [specific reasons for each]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (d) because none of the pairs are correctly matched."
  },
  {
    name: "Matching Pairs How Many Correct 4 Pairs - Only One",
    options_template: "(a) Only one (b) Only two (c) Only three (d) All four",
    correct_answer: "A",
    explanation_format: "Pair 1 is correct: [specific reason]. Pairs 2, 3, and 4 are incorrect: [specific reasons]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (a) because only one pair is correctly matched."
  },
  {
    name: "Matching Pairs How Many Correct 4 Pairs - Only Two",
    options_template: "(a) Only one (b) Only two (c) Only three (d) All four",
    correct_answer: "B",
    explanation_format: "Pairs 1 and 2 are correct: [specific reasons]. Pairs 3 and 4 are incorrect: [specific reasons]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (b) because only two pairs are correctly matched."
  },
  {
    name: "Matching Pairs How Many Correct 4 Pairs - Only Three",
    options_template: "(a) Only one (b) Only two (c) Only three (d) All four",
    correct_answer: "C",
    explanation_format: "Pairs 1, 2, and 3 are correct: [specific reasons]. Pair 4 is incorrect: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (c) because only three pairs are correctly matched."
  },
  {
    name: "Matching Pairs How Many Correct 4 Pairs - All Four",
    options_template: "(a) Only one (b) Only two (c) Only three (d) All four",
    correct_answer: "D",
    explanation_format: "All pairs are correct: [specific reasons for each]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (d) because all four pairs are correctly matched."
  },
  {
    name: "Select Correct Combination 3 Items - 1 Only",
    options_template: "(a) 1 only (b) 2 and 3 only (c) 1, 2 and 3 (d) None of the above",
    correct_answer: "A",
    explanation_format: "Statement 1 is correct: [specific reason]. Statements 2 and 3 are incorrect: [specific reasons]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (a) because only statement 1 is correct."
  },
  {
    name: "Select Correct Combination 3 Items - 2 and 3 Only",
    options_template: "(a) 1 only (b) 2 and 3 only (c) 1, 2 and 3 (d) None of the above",
    correct_answer: "B",
    explanation_format: "Statement 1 is incorrect: [specific reason]. Statements 2 and 3 are correct: [specific reasons]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (b) because statements 2 and 3 are correct."
  },
  {
    name: "Select Correct Combination 3 Items - All Correct",
    options_template: "(a) 1 only (b) 2 and 3 only (c) 1, 2 and 3 (d) None of the above",
    correct_answer: "C",
    explanation_format: "All statements are correct: [specific reasons for each]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (c) because all statements are correct."
  },
  {
    name: "Select Correct Combination 3 Items - None Correct",
    options_template: "(a) 1 only (b) 2 and 3 only (c) 1, 2 and 3 (d) None of the above",
    correct_answer: "D",
    explanation_format: "All statements are incorrect: [specific reasons for each]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (d) because none of the statements are correct."
  },
  {
    name: "Select Correct Combination 4 Items - 1, 2 and 3 Only",
    options_template: "(a) 1, 2 and 3 only (b) 2, 3 and 4 only (c) 1, 3 and 4 only (d) 1, 2, 3 and 4",
    correct_answer: "A",
    explanation_format: "Statements 1, 2, and 3 are correct: [specific reasons]. Statement 4 is incorrect: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (a) because statements 1, 2, and 3 are correct."
  },
  {
    name: "Select Correct Combination 4 Items - 2, 3 and 4 Only",
    options_template: "(a) 1, 2 and 3 only (b) 2, 3 and 4 only (c) 1, 3 and 4 only (d) 1, 2, 3 and 4",
    correct_answer: "B",
    explanation_format: "Statement 1 is incorrect: [specific reason]. Statements 2, 3, and 4 are correct: [specific reasons]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (b) because statements 2, 3, and 4 are correct."
  },
  {
    name: "Select Correct Combination 4 Items - 1, 3 and 4 Only",
    options_template: "(a) 1, 2 and 3 only (b) 2, 3 and 4 only (c) 1, 3 and 4 only (d) 1, 2, 3 and 4",
    correct_answer: "C",
    explanation_format: "Statements 1, 3, and 4 are correct: [specific reasons]. Statement 2 is incorrect: [specific reason]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (c) because statements 1, 3, and 4 are correct."
  },
  {
    name: "Select Correct Combination 4 Items - All Correct",
    options_template: "(a) 1, 2 and 3 only (b) 2, 3 and 4 only (c) 1, 3 and 4 only (d) 1, 2, 3 and 4",
    correct_answer: "D",
    explanation_format: "All statements are correct: [specific reasons for each]. 【[chapter]:[statement]†[source]】 Therefore, the correct answer is (d) because all statements are correct."
  }
];

function selectRandomMCQStructure() {
  return mcqStructures[Math.floor(Math.random() * mcqStructures.length)];
}

let bookMappingsCache = null;

async function fetchAndCacheBookMappings() {
  try {
    const categories = Object.keys(categoryToBookMap);
    const books = [];

    const collections = await db.listCollections({ name: "book_mappings" }).toArray();
    if (collections.length === 0) {
      console.log("book_mappings collection does not exist");
      for (const category of categories) {
        const chapters = bookChaptersMap[category] || [];
        const chapterDetails = chapters.map(chapter => ({
          chapter: `${chapter.unit} ${chapter.name}`.trim(),
          isMapped: false,
          mapping: null
        }));
        books.push({
          category,
          bookName: categoryToBookMap[category].bookName,
          chapters: chapterDetails,
          isFullyMapped: false
        });
      }
      bookMappingsCache = { books, allBooksMapped: false };
      return;
    }

    for (const category of categories) {
      const chapters = bookChaptersMap[category] || [];
      const chapterDetails = [];

      for (const chapter of chapters) {
        const chapterName = `${chapter.unit} ${chapter.name}`.trim();
        let mapping = null;
        try {
          mapping = await db.collection("book_mappings").findOne({ category, chapter: chapterName });
        } catch (error) {
          console.error(`Error querying book_mappings for ${category} - ${chapterName}:`, error.message, error.stack);
          mapping = null;
        }

        chapterDetails.push({
          chapter: chapterName,
          isMapped: !!mapping && mapping.mapped === true,
          mapping: mapping && mapping.mappings ? mapping.mappings : null
        });
      }

      const isFullyMapped = chapterDetails.length > 0 && chapterDetails.every(ch => ch.isMapped);
      books.push({
        category,
        bookName: categoryToBookMap[category].bookName,
        chapters: chapterDetails,
        isFullyMapped
      });
    }

    const allBooksMapped = books.length > 0 && books.every(book => book.isFullyMapped);
    bookMappingsCache = { books, allBooksMapped };
    console.log("Book mappings cached successfully");
  } catch (error) {
    console.error("Error caching book mappings:", error.message, error.stack);
    bookMappingsCache = null;
  }
}

async function generateFalseStatements(threadId, category, chapter, node, falseCount) {
  const logStep = (step) => {
    console.log(step);
  };

  logStep("Preparing false statement generation");

  const trueCount = 4 - falseCount;
  const statementAssignments = [];
  for (let i = 1; i <= falseCount; i++) {
    statementAssignments.push(`- Statement ${i}: False (incorrect fact)`);
  }
  for (let i = falseCount + 1; i <= 4; i++) {
    statementAssignments.push(`- Statement ${i}: True (correct fact)`);
  }

  const prompt = `
You are an AI designed to generate fact-based statements for the TrainWithMe platform, aligned with UPSC-style questions, using the subject "${category}". Generate statements **STRICTLY** for "${category}" and node "${node}" based on your knowledge, without external content.

**Instructions:**
- Generate **EXACTLY 4 STATEMENTS** with **EXACTLY ${falseCount} FALSE STATEMENTS** and **${trueCount} TRUE STATEMENTS**:
${falseCount === 0 ? '- All statements (1–4): True (correct fact)' : statementAssignments.join('\n')}
- **MUST HAVE EXACTLY ${falseCount} FALSE STATEMENTS**. **NO DEVIATION ALLOWED**.
- **TRUE STATEMENTS**: Precise, fact-based, requiring specific details from "${category}" (e.g., constitutional provisions, historical events).
- **FALSE STATEMENTS**: Subtle, plausible, based on specific misconceptions or slight factual distortions (e.g., incorrect dates, misattributed roles). **DO NOT** use absolute terms like "always," "never," "harmless," or "completely." False statements must require UPSC-level knowledge to identify as incorrect, avoiding vague or illogical claims.
- **EACH STATEMENT**: Include a clear, concise reason explaining why it is true or false, starting with "Correct:" for true, "Incorrect:" for false, with precise facts and addressing misconceptions.
- **DO NOT** include a "source" field or any source references.

**Example Output:**
{
  "statements": [
    {
      "text": "The UPSC conducts elections to Parliament.",
      "isTrue": false,
      "reason": "Incorrect: The Election Commission oversees elections, per polity texts."
    },
    {
      "text": "The President’s oath is administered by the Chief Justice.",
      "isTrue": true,
      "reason": "Correct: The oath is taken before the Chief Justice."
    }
  ]
}

**Output Format:**
{
  "statements": [
    {
      "text": "Statement text",
      "isTrue": true | false,
      "reason": "Reason why true or false"
    },
    ...
  ]
}
Return **ONLY** the JSON object, no additional text, markdown, comments, or "source" fields. **ENSURE EXACTLY ${falseCount} FALSE STATEMENTS** for "${category}".
`;

  try {
    const encoder = tiktoken.get_encoding('cl100k_base');
    const tokens = encoder.encode(prompt);
    console.log(`Input Tokens for False Statements (${category} - ${chapter} - ${node}): ${tokens.length}`);
    require('fs').appendFileSync('token_counts.log', `Input Tokens for False Statements (${category} - ${chapter} - ${node}): ${tokens.length}\n`);
  } catch (error) {
    console.error(`Error counting tokens: ${error.message}`);
  }

  let result = null;
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    attempt++;
    logStep(`Attempt ${attempt} to generate false statements`);

    try {
      await acquireLock(threadId);
      logStep(`Sending false statement generation request to OpenAI thread ${threadId}`);
      await openai.beta.threads.messages.create(threadId, {
        role: "user",
        content: prompt,
      });

      logStep(`Creating OpenAI run for thread ${threadId}`);
      const run = await openai.beta.threads.runs.create(threadId, {
        assistant_id: assistantId,
      }, { maxRetries: 2 });

      logStep(`Waiting for OpenAI run ${run.id} to complete`);
      const runStatus = await waitForRunToComplete(threadId, run.id);
      if (runStatus.status === "failed") {
        throw new Error(`OpenAI run failed: ${runStatus.last_error?.message || "Unknown failure reason"}`);
      }

      logStep(`Fetching response from OpenAI thread ${threadId}`);
      const messages = await openai.beta.threads.messages.list(threadId);
      const latestMessage = messages.data.find(m => m.role === "assistant");
      if (!latestMessage || !latestMessage.content[0]?.text?.value) {
        throw new Error("No response from OpenAI");
      }

      const rawResponse = latestMessage.content[0].text.value;
      logStep("Received OpenAI response, parsing JSON");
      console.log("Raw OpenAI response:", rawResponse);

      try {
        result = JSON.parse(rawResponse);
      } catch (parseError) {
        throw new Error(`Failed to parse OpenAI response: ${parseError.message}`);
      }

      if (!result || !result.statements || !Array.isArray(result.statements) || result.statements.length !== 4) {
        throw new Error("Invalid response format: Expected 4 statements");
      }

      const falseStatementCount = result.statements.filter(stmt => !stmt.isTrue).length;
      if (falseStatementCount !== falseCount) {
        throw new Error(`Expected ${falseCount} false statements, got ${falseStatementCount}`);
      }

      result.statements.forEach((stmt, index) => {
        if (!stmt.text || typeof stmt.isTrue !== 'boolean' || !stmt.reason || stmt.reason.trim() === "") {
          throw new Error(`Invalid statement ${index + 1}: Missing text, isTrue, or non-empty reason`);
        }
      });

      try {
        const encoder = tiktoken.get_encoding('cl100k_base');
        const outputTokens = encoder.encode(JSON.stringify(result)).length;
        console.log(`Output Tokens for False Statements (${category} - ${chapter} - ${node}): ${outputTokens}`);
        require('fs').appendFileSync('token_counts.log', `Output Tokens for False Statements (${category} - ${chapter} - ${node}): ${outputTokens}\n`);
      } catch (error) {
        console.error(`Error counting output tokens: ${error.message}`);
      }

      return {
        category,
        chapter,
        node,
        falseCount,
        statements: result.statements,
      };
    } catch (error) {
      console.error(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxAttempts) {
        throw new Error(`Failed to generate statements after ${maxAttempts} attempts: ${error.message}`);
      }
    } finally {
      releaseLock(threadId);
    }
  }
}

async function evaluateAndModifyMcq(threadId, mcqEntry, res = null) {
  const logStep = (step) => {
    if (res && typeof res.write === 'function') {
      res.write(`data: ${JSON.stringify({ status: "step", step: step })}\n\n`);
    }
    console.log(step);
  };

  const evalInstructions = await db.collection("evaluation_instructions").findOne({ parameter: "evaluationAndModification" });
  if (!evalInstructions || !evalInstructions.instruction) {
    throw new Error("Evaluation and modification instructions not found in the database");
  }

  const evaluationPrompt = `
**MCQ Details:**
- Question: ${JSON.stringify(mcqEntry.mcq?.question || [])}
- Options: ${JSON.stringify(mcqEntry.mcq?.options || {})}
- Correct Answer: ${mcqEntry.mcq?.correctAnswer || "N/A"}
- Explanation: ${mcqEntry.mcq?.explanation || "N/A"}
- Expected Options Template: ${mcqEntry.selected_mcq_structure ? mcqEntry.selected_mcq_structure.options_template || "Unknown" : "Unknown"}

${evalInstructions.instruction}
`;

  let result;
  try {
    await acquireLock(threadId);
    logStep(`Sending evaluation and modification request to OpenAI thread ${threadId}`);
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: evaluationPrompt,
    });

    logStep(`Creating OpenAI run for thread ${threadId}`);
    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
    }, { maxRetries: 3 });

    logStep(`Waiting for OpenAI run ${run.id} to complete`);
    const runStatus = await waitForRunToComplete(threadId, run.id);
    if (runStatus.status === "failed") {
      const failedRun = await openai.beta.threads.runs.retrieve(threadId, run.id);
      const failureReason = failedRun.last_error ? failedRun.last_error.message : "Unknown failure reason";
      throw new Error(`OpenAI run failed: ${failureReason}`);
    }

    logStep(`Fetching response from OpenAI thread ${threadId}`);
    const messages = await openai.beta.threads.messages.list(threadId);
    const latestMessage = messages.data.find(m => m.role === "assistant");
    if (!latestMessage || !latestMessage.content[0]?.text?.value) {
      throw new Error("No response from OpenAI");
    }

    let responseText = latestMessage.content[0].text.value;
    logStep("Raw OpenAI evaluation and modification response: " + responseText);

    result = safeJsonParse(responseText);
    if (result.error) {
      throw new Error(`Failed to parse OpenAI response as JSON: ${result.details}`);
    }

    if (!result.faults || typeof result.modifiedMcq !== 'object') {
      logStep(`Error: OpenAI response does not contain a valid evaluation structure. Expected 'faults' and 'modifiedMcq'.`);
      throw new Error("OpenAI response does not contain a valid evaluation structure");
    }

    if (result.modifiedMcq && (
      !Array.isArray(result.modifiedMcq.question) ||
      !result.modifiedMcq.options ||
      !['A', 'B', 'C', 'D'].includes(result.modifiedMcq.correctAnswer) ||
      !result.modifiedMcq.explanation
    )) {
      logStep(`Error: Invalid modifiedMcq structure in OpenAI response`);
      throw new Error("Invalid modifiedMcq structure in OpenAI response");
    }

    logStep(`Faults: ${result.faults}`);
    if (result.modifiedMcq) {
      logStep("Modified MCQ Generated:");
      logStep(`Question: ${Array.isArray(result.modifiedMcq.question) ? result.modifiedMcq.question.join("\n") : result.modifiedMcq.question}`);
      Object.entries(result.modifiedMcq.options).forEach(([key, value]) => {
        logStep(`Option ${key.toLowerCase()}: ${value}`);
      });
      logStep(`Correct Answer: ${result.modifiedMcq.correctAnswer.toLowerCase()}) ${result.modifiedMcq.options[result.modifiedMcq.correctAnswer]}`);
      logStep(`Explanation: ${result.modifiedMcq.explanation}`);
    }
  } finally {
    releaseLock(threadId);
  }

  return result;
}

app.get("/admin/get-collection-counts", async (req, res) => {
  try {
    const toBeEvaluatedCount = await db.collection("mcq_to_be_evaluated").countDocuments();
    const goodMcqsCount = await db.collection("good_mcqs").countDocuments();
    const modifiedMcqsCount = await db.collection("modified_mcqs").countDocuments();
    const finalMcqsCount = await db.collection("mcqs").countDocuments();

    res.status(200).json({
      toBeEvaluatedCount,
      goodMcqsCount,
      modifiedMcqsCount,
      finalMcqsCount
    });
  } catch (error) {
    console.error("Error in /admin/get-collection-counts:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch collection counts", details: error.message });
  }
});

app.get("/admin/produce-single-mcq", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { category } = req.query;
    console.log(`Handling request for /admin/produce-single-mcq?category=${category}`);
    if (!category || !categoryToBookMap[category]) {
      console.error("Missing or invalid category:", category);
      res.write(`data: ${JSON.stringify({ status: "error", message: "Missing or invalid category" })}\n\n`);
      res.end();
      return;
    }

    const chapters = bookChaptersMap[category];
    if (!chapters || chapters.length === 0) {
      console.log(`No chapters found for ${category}`);
      res.write(`data: ${JSON.stringify({ status: "error", message: `No chapters found for ${category}.` })}\n\n`);
      res.end();
      return;
    }

    // Filter chapters with existing mappings
    const mappedChapters = [];
    for (const chapter of chapters) {
      const chapterName = `${chapter.unit} ${chapter.name}`.trim();
      const mapping = await db.collection("book_mappings").findOne({ category, chapter: chapterName });
      if (mapping && mapping.mappings) {
        mappedChapters.push(chapterName);
      }
    }

    if (mappedChapters.length === 0) {
      console.log(`No mapped chapters found for ${category}`);
      res.write(`data: ${JSON.stringify({ status: "error", message: `No mapped chapters found for ${category}.` })}\n\n`);
      res.end();
      return;
    }

    const randomIndex = Math.floor(Math.random() * mappedChapters.length);
    const selectedChapter = mappedChapters[randomIndex];
    console.log(`Selected chapter for MCQ generation: ${selectedChapter}`);

    let treeStructure;
    try {
      treeStructure = await fetchTreeStructure(category, selectedChapter);
    } catch (error) {
      console.error(`Failed to fetch tree structure for ${category} - ${selectedChapter}:`, error.message);
      res.write(`data: ${JSON.stringify({ status: "error", message: `Failed to fetch tree structure: ${error.message}` })}\n\n`);
      res.end();
      return;
    }

    let node;
    try {
      node = selectRandomNode(treeStructure);
    } catch (error) {
      console.error(`Failed to select node for ${category} - ${selectedChapter}:`, error.message);
      res.write(`data: ${JSON.stringify({ status: "error", message: `Failed to select node: ${error.message}` })}\n\n`);
      res.end();
      return;
    }
    console.log(`Selected node for MCQ generation: ${node}`);

    const thread = await openai.beta.threads.create();
    const threadId = thread.id;

    let result;
    try {
      result = await generateMCQ(threadId, category, selectedChapter, node, res);
    } catch (error) {
      console.error(`Failed to generate MCQ for ${selectedChapter} - ${node} in ${category}:`, error.message, error.stack);
      res.write(`data: ${JSON.stringify({ status: "error", message: "Failed to generate MCQ", details: error.message })}\n\n`);
      res.end();
      return;
    }

    console.log("Saving MCQ to mcq_to_be_evaluated collection");
    const mcqDoc = {
      category,
      chapter: selectedChapter,
      node,
      selected_mcq_structure: result.selected_mcq_structure,
      mcq: result.mcq,
      createdAt: new Date(),
    };
    const insertResult = await db.collection("mcq_to_be_evaluated").insertOne(mcqDoc);
    console.log("Data saved to mcq_to_be_evaluated collection");

    console.log(`Sending MCQ for ${selectedChapter} - ${node} in ${category}:`, result.mcq);
    res.write(`data: ${JSON.stringify({
      status: "completed",
      selectedChapter: selectedChapter,
      node: node,
      selected_mcq_structure: result.selected_mcq_structure,
      mcq: result.mcq,
      mcqId: insertResult.insertedId.toString()
    })}\n\n`);
    res.end();
  } catch (error) {
    console.error(`Error in /admin/produce-single-mcq:`, error.message, error.stack);
    res.write(`data: ${JSON.stringify({ status: "error", message: "Failed to process request", details: error.message })}\n\n`);
    res.end();
  }
});

app.get("/admin/start-mass-production", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const categories = Object.keys(categoryToBookMap);
    let totalMcqsGenerated = 0;

    for (const category of categories) {
      if (res.writableEnded) {
        console.log("Client disconnected, stopping mass production");
        break;
      }

      console.log(`Starting mass production for category: ${category}`);
      const chapters = bookChaptersMap[category];
      if (!chapters || chapters.length === 0) {
        console.log(`No chapters found for ${category}, skipping...`);
        continue;
      }

      // Filter chapters with existing mappings
      const mappedChapters = [];
      for (const chapter of chapters) {
        const chapterName = `${chapter.unit} ${chapter.name}`.trim();
        const mapping = await db.collection("book_mappings").findOne({ category, chapter: chapterName });
        if (mapping && mapping.mappings) {
          mappedChapters.push(chapterName);
        }
      }

      if (mappedChapters.length === 0) {
        console.log(`No mapped chapters found for ${category}, skipping...`);
        continue;
      }

      let mcqsGeneratedForCategory = 0;
      const targetMcqsPerCategory = 100;

      while (mcqsGeneratedForCategory < targetMcqsPerCategory) {
        if (res.writableEnded) {
          console.log(`Client disconnected, stopping mass production for ${category}`);
          break;
        }

        const randomIndex = Math.floor(Math.random() * mappedChapters.length);
        const selectedChapter = mappedChapters[randomIndex];

        let treeStructure;
        try {
          treeStructure = await fetchTreeStructure(category, selectedChapter);
        } catch (error) {
          console.error(`Failed to fetch tree structure for ${category} - ${selectedChapter}:`, error.message);
          continue;
        }

        let node;
        try {
          node = selectRandomNode(treeStructure);
        } catch (error) {
          console.error(`Failed to select node for ${category} - ${selectedChapter}:`, error.message);
          continue;
        }

        const thread = await openai.beta.threads.create();
        const threadId = thread.id;

        let result;
        try {
          result = await generateMCQ(threadId, category, selectedChapter, node, res);
        } catch (error) {
          console.error(`Failed to generate MCQ for ${selectedChapter} - ${node} in ${category}:`, error.message);
          continue;
        }

        const mcqDoc = {
          category,
          chapter: selectedChapter,
          node,
          selected_mcq_structure: result.selected_mcq_structure,
          mcq: result.mcq,
          createdAt: new Date(),
        };
        const insertResult = await db.collection("mcq_to_be_evaluated").insertOne(mcqDoc);
        mcqsGeneratedForCategory++;
        totalMcqsGenerated++;

        res.write(`data: ${JSON.stringify({
          status: "progress",
          category,
          mcqsGeneratedForCategory,
          totalMcqsGenerated,
          mcqId: insertResult.insertedId.toString()
        })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log(`Completed mass production for ${category}: ${mcqsGeneratedForCategory} MCQs generated`);
    }

    res.write(`data: ${JSON.stringify({ status: "completed", totalMcqsGenerated })}\n\n`);
    res.end();
  } catch (error) {
    console.error(`Error in /admin/start-mass-production:`, error.message, error.stack);
    res.write(`data: ${JSON.stringify({ status: "error", message: "Failed to process mass production", details: error.message })}\n\n`);
    res.end();
  }
});

app.get("/admin/start-batch-production", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { category, sessionId } = req.query;
    console.log(`Starting batch production for category: ${category}, sessionId: ${sessionId}`);
    if (!category || !categoryToBookMap[category]) {
      console.error("Invalid or missing category:", category);
      res.write(`data: ${JSON.stringify({ status: "error", message: "Invalid or missing category" })}\n\n`);
      res.end();
      return;
    }
    if (!sessionId) {
      console.error("Missing sessionId");
      res.write(`data: ${JSON.stringify({ status: "error", message: "Missing sessionId" })}\n\n`);
      res.end();
      return;
    }

    // Store session
    activeBatchSessions.set(sessionId, { category, cancelled: false });

    const chapters = bookChaptersMap[category];
    if (!chapters || chapters.length === 0) {
      console.error(`No chapters found for category ${category}`);
      res.write(`data: ${JSON.stringify({ status: "error", message: `No chapters found for category ${category}` })}\n\n`);
      res.end();
      activeBatchSessions.delete(sessionId);
      return;
    }

    // Filter chapters with existing mappings
    const mappedChapters = [];
    for (const chapter of chapters) {
      const chapterName = `${chapter.unit} ${chapter.name}`.trim();
      const mapping = await db.collection("book_mappings").findOne({ category, chapter: chapterName });
      if (mapping && mapping.mappings) {
        mappedChapters.push(chapterName);
      }
    }

    if (mappedChapters.length === 0) {
      console.error(`No mapped chapters found for category ${category}`);
      res.write(`data: ${JSON.stringify({ status: "error", message: `No mapped chapters found for category ${category}` })}\n\n`);
      res.end();
      activeBatchSessions.delete(sessionId);
      return;
    }

    let mcqsGenerated = 0;
    const targetMcqs = 100;

    while (mcqsGenerated < targetMcqs) {
      if (res.writableEnded) {
        console.log(`Client disconnected, stopping batch production for ${category}`);
        activeBatchSessions.delete(sessionId);
        break;
      }

      // Check for cancellation
      const session = activeBatchSessions.get(sessionId);
      if (session && session.cancelled) {
        console.log(`Batch production cancelled for session ${sessionId}`);
        res.write(`data: ${JSON.stringify({ status: "completed", producedMcqs: mcqsGenerated, savedMcqs: mcqsGenerated, message: "Batch production cancelled" })}\n\n`);
        res.end();
        activeBatchSessions.delete(sessionId);
        return;
      }

      const randomIndex = Math.floor(Math.random() * mappedChapters.length);
      const selectedChapter = mappedChapters[randomIndex];
      console.log(`Selected chapter for MCQ generation: ${selectedChapter}`);

      let treeStructure;
      try {
        treeStructure = await fetchTreeStructure(category, selectedChapter);
      } catch (error) {
        console.error(`Failed to fetch tree structure for ${category} - ${selectedChapter}:`, error.message);
        continue;
      }

      let node;
      try {
        node = selectRandomNode(treeStructure);
      } catch (error) {
        console.error(`Failed to select node for ${category} - ${selectedChapter}:`, error.message);
        continue;
      }
      console.log(`Selected node for MCQ generation: ${node}`);

      const thread = await openai.beta.threads.create();
      const threadId = thread.id;

      let result;
      try {
        result = await generateMCQ(threadId, category, selectedChapter, node, res);
      } catch (error) {
        console.error(`Failed to generate MCQ for ${selectedChapter} - ${node} in ${category}:`, error.message);
        continue;
      }

      const mcqDoc = {
        category,
        chapter: selectedChapter,
        node,
        selected_mcq_structure: result.selected_mcq_structure,
        mcq: result.mcq,
        createdAt: new Date(),
      };
      const insertResult = await db.collection("mcq_to_be_evaluated").insertOne(mcqDoc);
      mcqsGenerated++;

      res.write(`data: ${JSON.stringify({
        status: "progress",
        producedMcqs: mcqsGenerated,
        savedMcqs: mcqsGenerated,
        mcqId: insertResult.insertedId.toString()
      })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`Completed batch production for ${category}: ${mcqsGenerated} MCQs generated`);
    res.write(`data: ${JSON.stringify({ status: "completed", producedMcqs: mcqsGenerated, savedMcqs: mcqsGenerated })}\n\n`);
    res.end();
    activeBatchSessions.delete(sessionId);
  } catch (error) {
    console.error(`Error in /admin/start-batch-production:`, error.message, error.stack);
    res.write(`data: ${JSON.stringify({ status: "error", message: "Failed to process batch production", details: error.message })}\n\n`);
    res.end();
    activeBatchSessions.delete(sessionId);
  }
});

app.post("/admin/stop-batch-production", async (req, res) => {
  try {
    const { sessionId } = req.body;
    console.log(`Received stop request for session ${sessionId}`);
    if (!sessionId) {
      console.error("Missing sessionId in stop request");
      return res.status(400).json({ error: "Missing sessionId" });
    }

    const session = activeBatchSessions.get(sessionId);
    if (!session) {
      console.log(`No active batch production session found for ${sessionId}`);
      return res.status(404).json({ error: `No active batch production session found for ${sessionId}` });
    }

    // Mark session as cancelled
    session.cancelled = true;
    activeBatchSessions.set(sessionId, session);

    res.status(200).json({ message: `Batch production stop requested for session ${sessionId}` });
  } catch (error) {
    console.error("Error in /admin/stop-batch-production:", error.message, error.stack);
    res.status(500).json({ error: "Failed to stop batch production", details: error.message });
  }
});

app.get("/admin/start-mass-em", async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    let processedMcqs = 0;
    let goodMcqs = 0;
    let modifiedMcqs = 0;
    let isCancelled = false;

    // Store session for cancellation
    const sessionId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    activeBatchSessions.set(sessionId, { type: "mass-em", cancelled: false });

    const toBeEvaluated = await db.collection("mcq_to_be_evaluated").find({}).toArray();
    if (toBeEvaluated.length === 0) {
      console.log("No MCQs found in mcq_to_be_evaluated collection");
      res.write(`data: ${JSON.stringify({ status: "completed", processedMcqs, goodMcqs, modifiedMcqs, message: "No MCQs to evaluate" })}\n\n`);
      res.end();
      activeBatchSessions.delete(sessionId);
      return;
    }

    for (const mcqEntry of toBeEvaluated) {
      if (res.writableEnded) {
        console.log("Client disconnected, stopping mass evaluation and modification");
        activeBatchSessions.delete(sessionId);
        break;
      }

      // Check for cancellation
      const session = activeBatchSessions.get(sessionId);
      if (session && session.cancelled) {
        console.log(`Mass evaluation and modification cancelled for session ${sessionId}`);
        res.write(`data: ${JSON.stringify({ status: "completed", processedMcqs, goodMcqs, modifiedMcqs, message: "Mass evaluation and modification cancelled" })}\n\n`);
        res.end();
        activeBatchSessions.delete(sessionId);
        return;
      }

      const thread = await openai.beta.threads.create();
      const threadId = thread.id;

      let result;
      try {
        result = await evaluateAndModifyMcq(threadId, {
          mcq: mcqEntry.mcq,
          selected_mcq_structure: mcqEntry.selected_mcq_structure
        }, res);
      } catch (error) {
        console.error(`Failed to evaluate MCQ ${mcqEntry._id}:`, error.message);
        continue;
      }

      processedMcqs++;

      // Determine if MCQ is good or needs modification
      if (!result.faults || result.faults.trim() === "") {
        // Good MCQ
        const goodMcqDoc = {
          category: mcqEntry.category,
          chapter: mcqEntry.chapter,
          node: mcqEntry.node,
          selected_mcq_structure: mcqEntry.selected_mcq_structure,
          mcq: mcqEntry.mcq,
          createdAt: new Date(),
          transferredFrom: mcqEntry._id.toString()
        };
        await db.collection("good_mcqs").insertOne(goodMcqDoc);
        goodMcqs++;
        await db.collection("mcq_to_be_evaluated").deleteOne({ _id: mcqEntry._id });
      } else {
        // Modified MCQ
        const modifiedMcqDoc = {
          category: mcqEntry.category,
          chapter: mcqEntry.chapter,
          node: mcqEntry.node,
          selected_mcq_structure: mcqEntry.selected_mcq_structure,
          mcq: result.modifiedMcq,
          faults: result.faults,
          originalMcqId: mcqEntry._id.toString(),
          createdAt: new Date()
        };
        await db.collection("modified_mcqs").insertOne(modifiedMcqDoc);
        modifiedMcqs++;
        await db.collection("mcq_to_be_evaluated").deleteOne({ _id: mcqEntry._id });
      }

      res.write(`data: ${JSON.stringify({
        status: "progress",
        processedMcqs,
        goodMcqs,
        modifiedMcqs
      })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    res.write(`data: ${JSON.stringify({ status: "completed", processedMcqs, goodMcqs, modifiedMcqs })}\n\n`);
    res.end();
    activeBatchSessions.delete(sessionId);
  } catch (error) {
    console.error(`Error in /admin/start-mass-em:`, error.message, error.stack);
    res.write(`data: ${JSON.stringify({ status: "error", message: "Failed to process mass evaluation and modification", details: error.message })}\n\n`);
    res.end();
    activeBatchSessions.delete(sessionId);
  }
});

app.post("/admin/stop-mass-em", async (req, res) => {
  try {
    const { sessionId } = req.body;
    console.log(`Received stop request for mass-em session ${sessionId}`);
    if (!sessionId) {
      console.error("Missing sessionId in stop request");
      return res.status(400).json({ error: "Missing sessionId" });
    }

    const session = activeBatchSessions.get(sessionId);
    if (!session || session.type !== "mass-em") {
      console.log(`No active mass-em session found for ${sessionId}`);
      return res.status(404).json({ error: `No active mass-em session found for ${sessionId}` });
    }

    // Mark session as cancelled
    session.cancelled = true;
    activeBatchSessions.set(sessionId, session);

    res.status(200).json({ message: `Mass evaluation and modification stop requested for session ${sessionId}` });
  } catch (error) {
    console.error("Error in /admin/stop-mass-em:", error.message, error.stack);
    res.status(500).json({ error: "Failed to stop mass evaluation and modification", details: error.message });
  }
});

app.post("/admin/transfer-good-mcqs", async (req, res) => {
  try {
    const goodMcqs = await db.collection("good_mcqs").find({}).toArray();
    if (goodMcqs.length === 0) {
      console.log("No MCQs found in good_mcqs collection to transfer");
      return res.status(200).json({ message: "No MCQs found in good_mcqs collection to transfer" });
    }

    const finalMcqs = goodMcqs.map(mcq => {
      const { _id, transferredFrom, ...rest } = mcq;
      return {
        ...rest,
        book: categoryToBookMap[mcq.category]?.bookName || "Unknown Book",
        createdAt: new Date()
      };
    });

    const insertResult = await db.collection("mcqs").insertMany(finalMcqs);
    console.log(`Transferred ${insertResult.insertedCount} MCQs to mcqs collection`);

    await db.collection("good_mcqs").deleteMany({});
    console.log(`Deleted ${goodMcqs.length} MCQs from good_mcqs collection`);

    res.status(200).json({ message: `Successfully transferred ${insertResult.insertedCount} MCQs to mcqs collection` });
  } catch (error) {
    console.error("Error in /admin/transfer-good-mcqs:", error.message, error.stack);
    res.status(500).json({ error: "Failed to transfer good MCQs", details: error.message });
  }
});

app.post("/admin/transfer-to-good-mcqs", async (req, res) => {
  try {
    const { mcq } = req.body;
    console.log("Received MCQ for transfer:", mcq);
    if (!mcq) {
      console.log("Missing MCQ data in request body");
      return res.status(400).json({ error: "Missing MCQ data in request body" });
    }

    const mcqToInsert = { ...mcq };
    delete mcqToInsert._id;
    mcqToInsert.transferredFrom = mcq.originalId || null;

    const insertResult = await db.collection("good_mcqs").insertOne(mcqToInsert);
    console.log(`Transferred MCQ to good_mcqs collection with new ID: ${insertResult.insertedId}`);

    if (mcq.originalId && mcq.sourceCollection) {
      const validCollections = ["mcq_to_be_evaluated", "modified_mcqs", "reported_mcqs"];
      if (validCollections.includes(mcq.sourceCollection)) {
        try {
          const objectId = typeof mcq.originalId === "string" ? new ObjectId(mcq.originalId) : mcq.originalId;
          console.log(`Attempting to remove MCQ ${objectId} from ${mcq.sourceCollection}`);
          const deleteResult = await db.collection(mcq.sourceCollection).deleteOne({ _id: objectId });
          console.log(`Delete result: ${deleteResult.deletedCount} document(s) deleted`);
        } catch (deleteError) {
          console.error(`Error deleting MCQ from ${mcq.sourceCollection}:`, deleteError.message, deleteError.stack);
        }
      } else {
        console.log(`Invalid sourceCollection: ${mcq.sourceCollection}`);
      }
    } else {
      console.log("No originalId or sourceCollection provided, skipping deletion");
    }

    res.status(200).json({ message: "MCQ transferred to good_mcqs collection" });
  } catch (error) {
    console.error("Error in /admin/transfer-to-good-mcqs:", error.message, error.stack);
    if (error.code === 11000) {
      res.status(400).json({ error: "MCQ already exists in good_mcqs collection", details: error.message });
    } else {
      res.status(500).json({ error: "Failed to transfer MCQ to good_mcqs", details: error.message });
    }
  }
});

app.get("/admin/get-book-mappings", async (req, res) => {
  try {
    if (bookMappingsCache) {
      console.log("Returning cached book mappings");
      res.status(200).json(bookMappingsCache);
    } else {
      console.log("Cache empty, fetching book mappings from database");
      await fetchAndCacheBookMappings();
      if (bookMappingsCache) {
        res.status(200).json(bookMappingsCache);
      } else {
        throw new Error("Failed to fetch book mappings");
      }
    }
  } catch (error) {
    console.error("Error in /admin/get-book-mappings:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch book mappings", details: error.message });
  }
});

app.post("/admin/map-chapter", async (req, res) => {
  try {
    const { category, chapter } = req.body;
    if (!category || !chapter) {
      return res.status(400).json({ error: "Missing category or chapter in request body" });
    }

    const existingMapping = await db.collection("book_mappings").findOne({ category, chapter });
    const thread = await openai.beta.threads.create();
    const threadId = thread.id;
    let treeStructure;

    if (existingMapping && existingMapping.mapped) {
      console.log(`Repopulating chapter ${chapter} in ${category}`);
      treeStructure = await enhanceTreeStructure(threadId, category, chapter, existingMapping.mappings);
      const updateResult = await db.collection("book_mappings").updateOne(
        { category, chapter },
        {
          $set: {
            mappings: treeStructure,
            last_updated: new Date().toISOString()
          }
        }
      );
      console.log(`Updated mappings for ${category} - ${chapter}: ${updateResult.modifiedCount} document(s) modified`);
      await fetchAndCacheBookMappings();
      res.status(200).json({ message: `Successfully repopulated chapter ${chapter} in ${category}` });
    } else {
      console.log(`Mapping chapter ${chapter} in ${category}`);
      treeStructure = await generateTreeStructure(threadId, category, chapter);
      const mappingDoc = {
        category,
        chapter,
        mapped: true,
        mappings: treeStructure,
        last_updated: new Date().toISOString()
      };
      await db.collection("book_mappings").insertOne(mappingDoc);
      await fetchAndCacheBookMappings();
      res.status(200).json({ message: `Successfully mapped chapter ${chapter} in ${category}` });
    }
  } catch (error) {
    console.error("Error in /admin/map-chapter:", error.message, error.stack);
    res.status(500).json({ error: "Failed to map chapter", details: error.message });
  }
});

app.post("/admin/map-book", async (req, res) => {
  try {
    const { category } = req.body;
    if (!category) {
      return res.status(400).json({ error: "Missing category in request body" });
    }

    const chapters = bookChaptersMap[category] || [];
    if (chapters.length === 0) {
      return res.status(400).json({ error: `No chapters found for category ${category}` });
    }

    const existingMappings = await db.collection("book_mappings")
      .find({ category })
      .toArray();

    const mappedChapters = new Set(existingMappings.map(mapping => mapping.chapter));
    const chaptersToMap = chapters.filter(chapter => {
      const chapterName = `${chapter.unit} ${chapter.name}`.trim();
      return !mappedChapters.has(chapterName);
    });

    if (chaptersToMap.length === 0) {
      return res.status(200).json({ message: `All chapters in ${category} are already mapped` });
    }

    const thread = await openai.beta.threads.create();
    const threadId = thread.id;
    const mappingsToInsert = [];

    for (const chapter of chaptersToMap) {
      const chapterName = `${chapter.unit} ${chapter.name}`.trim();
      const treeStructure = await generateTreeStructure(threadId, category, chapterName);
      mappingsToInsert.push({
        category,
        chapter: chapterName,
        mapped: true,
        mappings: treeStructure,
        last_updated: new Date().toISOString()
      });
    }

    await db.collection("book_mappings").insertMany(mappingsToInsert);
    await fetchAndCacheBookMappings();
    res.status(200).json({ message: `Successfully mapped ${mappingsToInsert.length} unmapped chapters in ${category}` });
  } catch (error) {
    console.error("Error in /admin/map-book:", error.message, error.stack);
    res.status(500).json({ error: "Failed to map book", details: error.message });
  }
});

app.post("/admin/map-all-books", async (req, res) => {
  try {
    const categories = Object.keys(categoryToBookMap);
    const thread = await openai.beta.threads.create();
    const threadId = thread.id;
    let totalChaptersMapped = 0;

    for (const category of categories) {
      const chapters = bookChaptersMap[category] || [];
      if (chapters.length === 0) {
        console.log(`No chapters found for ${category}, skipping...`);
        continue;
      }

      const existingMappings = await db.collection("book_mappings")
        .find({ category })
        .toArray();
      const mappedChapters = new Set(existingMappings.map(mapping => mapping.chapter));

      const chaptersToMap = chapters.filter(chapter => {
        const chapterName = `${chapter.unit} ${chapter.name}`.trim();
        return !mappedChapters.has(chapterName);
      });

      const mappingsToInsert = [];
      for (const chapter of chaptersToMap) {
        const chapterName = `${chapter.unit} ${chapter.name}`.trim();
        const treeStructure = await generateTreeStructure(threadId, category, chapterName);
        mappingsToInsert.push({
          category,
          chapter: chapterName,
          mapped: true,
          mappings: treeStructure,
          last_updated: new Date().toISOString()
        });
      }

      if (mappingsToInsert.length > 0) {
        await db.collection("book_mappings").insertMany(mappingsToInsert);
        totalChaptersMapped += mappingsToInsert.length;
      }
    }

    await fetchAndCacheBookMappings();
    res.status(200).json({ message: `Successfully mapped ${totalChaptersMapped} unmapped chapters across all books` });
  } catch (error) {
    console.error("Error in /admin/map-all-books:", error.message, error.stack);
    res.status(500).json({ error: "Failed to map all books", details: error.message });
  }
});

app.post("/admin/repopulate-book-mappings", async (req, res) => {
  try {
    const categories = Object.keys(categoryToBookMap);
    const thread = await openai.beta.threads.create();
    const threadId = thread.id;
    let totalChaptersRepopulated = 0;

    for (const category of categories) {
      const chapters = bookChaptersMap[category] || [];
      if (chapters.length === 0) {
        console.log(`No chapters found for ${category}, skipping...`);
        continue;
      }

      for (const chapter of chapters) {
        const chapterName = `${chapter.unit} ${chapter.name}`.trim();
        const existingMapping = await db.collection("book_mappings").findOne({ category, chapter: chapterName });

        if (existingMapping && existingMapping.mapped) {
          console.log(`Enhancing tree structure for ${category} - ${chapterName}`);
          const enhancedStructure = await enhanceTreeStructure(threadId, category, chapterName, existingMapping.mappings);
          const updateResult = await db.collection("book_mappings").updateOne(
            { category, chapter: chapterName },
            {
              $set: {
                mappings: enhancedStructure,
                last_updated: new Date().toISOString()
              }
            }
          );
          console.log(`Updated mappings for ${category} - ${chapterName}: ${updateResult.modifiedCount} document(s) modified`);
          totalChaptersRepopulated++;
        } else {
          console.log(`Generating new tree structure for unmapped chapter ${category} - ${chapterName}`);
          const treeStructure = await generateTreeStructure(threadId, category, chapterName);
          await db.collection("book_mappings").insertOne({
            category,
            chapter: chapterName,
            mapped: true,
            mappings: treeStructure,
            last_updated: new Date().toISOString()
          });
          totalChaptersRepopulated++;
        }
      }
    }

    await fetchAndCacheBookMappings();
    res.status(200).json({ message: `Successfully repopulated ${totalChaptersRepopulated} chapters across all books` });
  } catch (error) {
    console.error("Error in /admin/repopulate-book-mappings:", error.message, error.stack);
    res.status(500).json({ error: "Failed to repopulate book mappings", details: error.message });
  }
});

app.get("/admin/get-mcq-generation-instructions", async (req, res) => {
  try {
    const instructions = await db.collection("mcq_generation_instructions")
      .findOne({}, { sort: { updatedAt: -1 } });
    res.status(200).json({ instructions: instructions?.instruction || "" });
  } catch (error) {
    console.error("Error in /admin/get-mcq-generation-instructions:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch MCQ generation instructions", details: error.message });
  }
});

app.get("/admin/get-evaluation-instructions", async (req, res) => {
  try {
    const instructions = await db.collection("evaluation_instructions").find({}).toArray();
    res.status(200).json({ instructions });
  } catch (error) {
    console.error("Error in /admin/get-evaluation-instructions:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch evaluation instructions", details: error.message });
  }
});

app.post("/admin/save-instructions", async (req, res) => {
  try {
    const { instructionType, updated_instructions } = req.body;
    console.log(`Saving instructions for ${instructionType}`);
    if (!instructionType || !updated_instructions) {
      console.log("Missing instructionType or updated_instructions");
      return res.status(400).json({ error: "Missing instructionType or updated_instructions" });
    }

    if (instructionType === "mcq_generation") {
      await db.collection("mcq_generation_instructions").updateOne(
        { version: "1.0" },
        { $set: { instruction: updated_instructions, updatedAt: new Date() } },
        { upsert: true }
      );
    } else if (instructionType === "evaluation") {
      await db.collection("evaluation_instructions").deleteMany({});
      await db.collection("evaluation_instructions").insertMany(
        updated_instructions.map(inst => ({
          parameter: inst.parameter,
          instruction: inst.instruction
        }))
      );
    } else {
      return res.status(400).json({ error: "Invalid instructionType" });
    }

    res.status(200).json({ message: "Instructions saved successfully" });
  } catch (error) {
    console.error("Error in /admin/save-instructions:", error.message, error.stack);
    res.status(500).json({ error: "Failed to save instructions", details: error.message });
  }
});

app.get("/admin/generate-bciq-mcq", async (req, res) => {
  try {
    const { category } = req.query;
    console.log(`Handling request for /admin/generate-bciq-mcq?category=${category}`);
    if (!category || !categoryToBookMap[category]) {
      console.error("Missing or invalid category:", category);
      return res.status(400).json({ error: "Missing or invalid category" });
    }

    const chapters = bookChaptersMap[category];
    if (!chapters || chapters.length === 0) {
      console.log(`No chapters found for ${category}`);
      return res.status(400).json({ error: `No chapters found for ${category}` });
    }

    // Filter chapters with existing mappings
    const mappedChapters = [];
    for (const chapter of chapters) {
      const chapterName = `${chapter.unit} ${chapter.name}`.trim();
      const mapping = await db.collection("book_mappings").findOne({ category, chapter: chapterName });
      if (mapping && mapping.mappings) {
        mappedChapters.push(chapterName);
      }
    }

    if (mappedChapters.length === 0) {
      console.log(`No mapped chapters found for ${category}`);
      return res.status(400).json({ error: `No mapped chapters found for ${category}` });
    }

    const randomIndex = Math.floor(Math.random() * mappedChapters.length);
    const selectedChapter = mappedChapters[randomIndex];
    console.log(`Selected chapter for MCQ generation: ${selectedChapter}`);

    let treeStructure;
    try {
      treeStructure = await fetchTreeStructure(category, selectedChapter);
    } catch (error) {
      console.error(`Failed to fetch tree structure for ${category} - ${selectedChapter}:`, error.message);
      return res.status(500).json({ error: `Failed to fetch tree structure: ${error.message}` });
    }

    let node;
    try {
      node = selectRandomNode(treeStructure);
    } catch (error) {
      console.error(`Failed to select node for ${category} - ${selectedChapter}:`, error.message);
      return res.status(500).json({ error: `Failed to select node: ${error.message}` });
    }
    console.log(`Selected node for MCQ generation: ${node}`);

    const thread = await openai.beta.threads.create();
    const threadId = thread.id;

    let result;
    try {
      result = await generateMCQ(threadId, category, selectedChapter, node);
    } catch (error) {
      console.error(`Failed to generate MCQ for ${selectedChapter} - ${node} in ${category}:`, error.message);
      return res.status(500).json({ error: "Failed to generate MCQ", details: error.message });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error(`Error in /admin/generate-bciq-mcq:`, error.message, error.stack);
    res.status(500).json({ error: "Failed to process request", details: error.message });
  }
});

app.post("/admin/evaluate-and-modify-bciq-mcq", async (req, res) => {
  try {
    const { mcq } = req.body;
    console.log("Received MCQ for evaluation:", mcq);
    if (!mcq || !mcq.question || !mcq.options || !mcq.correctAnswer || !mcq.explanation) {
      console.log("Invalid MCQ data in request body");
      return res.status(400).json({ error: "Invalid MCQ data in request body" });
    }

    const thread = await openai.beta.threads.create();
    const threadId = thread.id;

    const result = await evaluateAndModifyMcq(threadId, {
      mcq,
      selected_mcq_structure: { options_template: mcq.options_template || "Unknown" }
    });

    res.status(200).json(result);
  } catch (error) {
    console.error("Error in /admin/evaluate-and-modify-bciq-mcq:", error.message, error.stack);
    res.status(500).json({ error: "Failed to evaluate and modify MCQ", details: error.message });
  }
});

app.get("/admin/fetch-mcqs", async (req, res) => {
  try {
    const { collection, limit = 1, page = 1 } = req.query;
    console.log(`Fetching MCQs from ${collection}, page ${page}, limit ${limit}`);
    const validCollections = ["mcq_to_be_evaluated", "modified_mcqs", "reported_mcqs", "parsed_mcqs"];
    if (!collection || !validCollections.includes(collection)) {
      console.log("Invalid or missing collection:", collection);
      return res.status(400).json({ error: "Invalid or missing collection" });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const mcqs = await db.collection(collection)
      .find({})
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalMcqs = await db.collection(collection).countDocuments();

    res.status(200).json({
      mcqs,
      totalMcqs,
      currentPage: parseInt(page)
    });
  } catch (error) {
    console.error("Error in /admin/fetch-mcqs:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch MCQs", details: error.message });
  }
});

app.post("/admin/generate-false-statements", async (req, res) => {
  try {
    const { category, chapter, node, falseCount } = req.body;
    console.log(`Handling request for /admin/generate-false-statements: ${category}, ${chapter}, ${node}, falseCount=${falseCount}`);
    
    if (!category || !categoryToBookMap[category]) {
      console.error("Missing or invalid category:", category);
      return res.status(400).json({ error: "Missing or invalid category" });
    }
    if (!chapter || !bookChaptersMap[category].some(ch => `${ch.unit} ${ch.name}`.trim() === chapter)) {
      console.error("Missing or invalid chapter:", chapter);
      return res.status(400).json({ error: "Missing or invalid chapter" });
    }
    if (!node) {
      console.error("Missing node:", node);
      return res.status(400).json({ error: "Missing node" });
    }
    if (!Number.isInteger(falseCount) || falseCount < 0 || falseCount > 4) {
      console.error("Invalid falseCount:", falseCount);
      return res.status(400).json({ error: "falseCount must be an integer between 0 and 4" });
    }

    let treeStructure;
    try {
      treeStructure = await fetchTreeStructure(category, chapter);
    } catch (error) {
      console.error(`Failed to fetch tree structure for ${category} - ${chapter}:`, error.message);
      return res.status(500).json({ error: `Failed to fetch tree structure: ${error.message}` });
    }

    // Validate node exists in tree structure
    const nodes = [];
    function traverse(node) {
      if (!node || typeof node !== 'object') return;
      if (typeof node === 'string') {
        nodes.push(node);
        return;
      }
      if (node.topic || node.subtopic || node.detail || node.subdetail) {
        nodes.push(node.topic || node.subtopic || node.detail || node.subdetail);
      }
      ['topics', 'subtopics', 'details', 'subdetails', 'particulars'].forEach(key => {
        if (node[key] && Array.isArray(node[key])) {
          node[key].forEach(child => traverse(child));
        }
      });
    }

    if (!treeStructure || !treeStructure.topics || !Array.isArray(treeStructure.topics)) {
      console.error(`Invalid tree structure for ${category} - ${chapter}:`, JSON.stringify(treeStructure, null, 2));
      return res.status(500).json({ error: `Invalid tree structure: topics is missing or not an array` });
    }

    treeStructure.topics.forEach(topic => {
      if (topic) traverse(topic);
    });

    if (!nodes.includes(node)) {
      console.error("Invalid node:", node, "Available nodes:", nodes);
      return res.status(400).json({ error: `Invalid node: ${node} not found in tree structure` });
    }

    const thread = await openai.beta.threads.create();
    const threadId = thread.id;

    let result;
    try {
      result = await generateFalseStatements(threadId, category, chapter, node, falseCount);
    } catch (error) {
      console.error(`Failed to generate false statements for ${chapter} - ${node} in ${category}:`, error.message);
      return res.status(500).json({ error: "Failed to generate false statements", details: error.message });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error(`Error in /admin/generate-false-statements:`, error.message, error.stack);
    res.status(500).json({ error: "Failed to process request", details: error.message });
  }
});

// Server-side implementation of transformStatementsToMCQ (mirroring client-side logic)
function transformStatementsToMCQ(data, bookName) {
  if (!data || !data.category || !data.chapter || !data.node || !data.statements || !Array.isArray(data.statements) || data.statements.length !== 4) {
    throw new Error('Invalid input: Expected category, chapter, node, and exactly 4 statements');
  }

  const { node, statements } = data;

  // Define Select Correct Combination templates
  const templates = {
    2: [
      {
        name: "Select Correct Combination 2 Statements",
        options_template: "(a) 1 only (b) 2 only (c) Both 1 and 2 (d) None of the above",
        options: ["1 only", "2 only", "Both 1 and 2", "None of the above"]
      }
    ],
    3: [
      {
        name: "Select Correct Combination 3 Items",
        options_template: "(a) 1 only (b) 2 and 3 only (c) 1, 2 and 3 (d) None of the above",
        options: ["1 only", "2 and 3 only", "1, 2 and 3", "None of the above"]
      },
      {
        name: "Select Correct Combination 3 Statements Singles",
        options_template: "(a) 1 only (b) 2 only (c) 3 only (d) None of the above",
        options: ["1 only", "2 only", "3 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 3 Statements Pairs",
        options_template: "(a) 1 and 2 only (b) 1 and 3 only (c) 2 and 3 only (d) None of the above",
        options: ["1 and 2 only", "1 and 3 only", "2 and 3 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 3 Statements Mixed 1",
        options_template: "(a) 1 only (b) 1 and 2 only (c) 3 only (d) None of the above",
        options: ["1 only", "1 and 2 only", "3 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 3 Statements Mixed 2",
        options_template: "(a) 2 only (b) 1 and 3 only (c) 1, 2 and 3 (d) None of the above",
        options: ["2 only", "1 and 3 only", "1, 2 and 3", "None of the above"]
      },
      {
        name: "Select Correct Combination 3 Statements Mixed 3",
        options_template: "(a) 3 only (b) 2 and 3 only (c) 1 and 2 only (d) None of the above",
        options: ["3 only", "2 and 3 only", "1 and 2 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 3 Statements Mixed 4",
        options_template: "(a) 1 only (b) 2 only (c) 1 and 3 only (d) None of the above",
        options: ["1 only", "2 only", "1 and 3 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 3 Statements All",
        options_template: "(a) 1 only (b) 1 and 2 only (c) 1, 2 and 3 (d) None of the above",
        options: ["1 only", "1 and 2 only", "1, 2 and 3", "None of the above"]
      }
    ],
    4: [
      {
        name: "Select Correct Combination 4 Statements",
        options_template: "(a) 1 only (b) 1 and 2 only (c) 1, 2 and 3 only (d) None of the above",
        options: ["1 only", "1 and 2 only", "1, 2 and 3 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 4 Statements Singles",
        options_template: "(a) 1 only (b) 2 only (c) 3 only (d) None of the above",
        options: ["1 only", "2 only", "3 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 4 Statements Triples",
        options_template: "(a) 1, 2 and 3 only (b) 2, 3 and 4 only (c) 1, 3 and 4 only (d) None of the above",
        options: ["1, 2 and 3 only", "2, 3 and 4 only", "1, 3 and 4 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 4 Statements Pairs",
        options_template: "(a) 1 and 2 only (b) 2 and 3 only (c) 3 and 4 only (d) None of the above",
        options: ["1 and 2 only", "2 and 3 only", "3 and 4 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 4 Statements Mixed 1",
        options_template: "(a) 1 only (b) 1 and 3 only (c) 2, 3 and 4 only (d) None of the above",
        options: ["1 only", "1 and 3 only", "2, 3 and 4 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 4 Statements Mixed 2",
        options_template: "(a) 2 only (b) 2 and 4 only (c) 1, 2 and 3 only (d) None of the above",
        options: ["2 only", "2 and 4 only", "1, 2 and 3 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 4 Statements Mixed 3",
        options_template: "(a) 3 only (b) 1 and 4 only (c) 1, 2 and 4 only (d) None of the above",
        options: ["3 only", "1 and 4 only", "1, 2 and 4 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 4 Statements Mixed 4",
        options_template: "(a) 4 only (b) 3 and 4 only (c) 1, 3 and 4 only (d) None of the above",
        options: ["4 only", "3 and 4 only", "1, 3 and 4 only", "None of the above"]
      },
      {
        name: "Select Correct Combination 4 Statements All",
        options_template: "(a) 1 only (b) 1 and 2 only (c) 1, 2, 3 and 4 (d) None of the above",
        options: ["1 only", "1 and 2 only", "1, 2, 3 and 4", "None of the above"]
      }
    ]
  };

  // Randomly select number of statements (2, 3, or 4)
  const statementCounts = [2, 3, 4];
  const selectedCount = statementCounts[Math.floor(Math.random() * statementCounts.length)];

  // Shuffle the statements
  const shuffledStatements = [...statements].sort(() => Math.random() - 0.5);

  // Randomly select indices based on selectedCount
  const indices = [0, 1, 2, 3];
  indices.sort(() => Math.random() - 0.5); // Shuffle indices
  let selectedIndices;
  if (selectedCount === 2) {
    selectedIndices = indices.slice(0, 2).sort((a, b) => a - b); // Pick 2, sort for display
  } else if (selectedCount === 3) {
    selectedIndices = indices.slice(0, 3).sort((a, b) => a - b); // Pick 3, sort for display
  } else {
    selectedIndices = indices; // All 4
  }

  // Select statements based on shuffled indices
  const selectedStatements = selectedIndices.map(index => shuffledStatements[index]);

  // Map display indices (1-based) for question and options
  const displayIndices = selectedIndices.map((_, i) => i + 1);

  // Determine correct answer based on isTrue status
  const trueIndices = selectedStatements
    .map((stmt, index) => (stmt.isTrue ? index + 1 : null))
    .filter(index => index !== null);

  let correctOption;
  if (trueIndices.length === 0) {
    correctOption = "None of the above";
  } else if (trueIndices.length === 1) {
    correctOption = `${trueIndices[0]} only`;
  } else if (trueIndices.length === 2 && selectedCount === 2) {
    correctOption = "Both 1 and 2";
  } else if (trueIndices.length === 2) {
    correctOption = `${trueIndices.join(' and ')} only`;
  } else if (trueIndices.length === 3 && selectedCount === 3) {
    correctOption = "1, 2 and 3";
  } else if (trueIndices.length === 3) {
    correctOption = `${trueIndices.join(', ').replace(/, (\d+)$/, ', and $1')} only`;
  } else if (trueIndices.length === 4 && selectedCount === 4) {
    correctOption = "1, 2, 3 and 4";
  } else {
    correctOption = trueIndices.length > 0 ? `${trueIndices.join(' and ')} only` : "None of the above";
  }

  // Filter eligible templates where correctOption is an option
  let eligibleTemplates = templates[selectedCount].filter(template =>
    template.options.includes(correctOption)
  );

  // If no matching template, select a default template and adjust correctOption
  if (eligibleTemplates.length === 0) {
    console.warn(`No template found for correctOption: "${correctOption}", falling back to default`);
    eligibleTemplates = [templates[selectedCount][0]];
    correctOption = eligibleTemplates[0].options[0]; // Default to first option
  }

  // Randomly select an eligible template
  const selectedTemplate = eligibleTemplates[Math.floor(Math.random() * eligibleTemplates.length)] || templates[selectedCount][0];

  // Generate question stem
  const question = [
    `Consider the following statements:`,
    ...selectedStatements.map((stmt, index) => `${index + 1}. ${stmt.text}`),
    'Which of the following is correct?'
  ];

  // Generate options based on selected template
  const options = {};
  selectedTemplate.options.forEach((opt, index) => {
    options[String.fromCharCode(65 + index)] = opt; // A, B, C, D
  });

  // Determine correct answer letter
  let correctAnswer = String.fromCharCode(65 + selectedTemplate.options.indexOf(correctOption));
  if (correctAnswer === '@') {
    console.error(`Invalid correctAnswer for ${correctOption}, defaulting to A`);
    correctAnswer = 'A'; // Fallback to A
  }

  // Generate explanation
  const explanations = selectedStatements.map((stmt, index) => {
    const stmtNumber = index + 1;
    const cleanedReason = stmt.reason.replace(/^(Correct|Incorrect):\s*/i, '');
    return `Statement ${stmtNumber} is ${stmt.isTrue ? 'correct' : 'incorrect'}: ${cleanedReason}`;
  });
  const explanation = explanations.join(' ');

  return {
    question,
    options,
    correctAnswer,
    explanation
  };
}

// New endpoint to save transformed MCQs to transformer collection
app.post("/admin/save-transformed-mcq", async (req, res) => {
  try {
    const { book, category, chapter, mcq } = req.body;
    if (!book || !category || !chapter || !mcq) {
      return res.status(400).json({ error: "Missing required fields: book, category, chapter, or mcq" });
    }

    const result = await db.collection("transformer").insertOne({
      book,
      category,
      chapter,
      mcq,
      createdAt: new Date()
    });

    res.status(200).json({ message: "MCQ saved successfully", id: result.insertedId });
  } catch (error) {
    console.error("Error in /admin/save-transformed-mcq:", error.message, error.stack);
    res.status(500).json({ error: "Failed to save MCQ", details: error.message });
  }
});

// New endpoint to start batch production of false statements and MCQs for a specific category
app.get("/admin/start-statement-batch-production/:category", async (req, res) => {
  const category = req.params.category;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let batchRunning = true;
  const batchSize = 100;
  let current = 0;

  // Initialize batchRunning state for category if not exists
  if (!app.locals.batchRunning) {
    app.locals.batchRunning = {};
  }
  if (!app.locals.batchRunning[category]) {
    app.locals.batchRunning[category] = false;
  }
  app.locals.batchRunning[category] = true;

  try {
    const booksResponse = await axios.get('http://localhost:5001/admin/get-book-mappings');
    const books = booksResponse.data.books || [];
    const book = books.find(b => b.category === category);

    if (!book) {
      res.write(`data: ${JSON.stringify({ status: 'error', message: `Book with category ${category} not found` })}\n\n`);
      return;
    }

    const bookName = book.bookName;

    while (current < batchSize && batchRunning && app.locals.batchRunning[category]) {
      // Randomly select chapter
      const mappedChapters = book.chapters.filter(ch => ch.isMapped);
      if (mappedChapters.length === 0) {
        res.write(`data: ${JSON.stringify({ status: 'error', message: `No mapped chapters for ${category}` })}\n\n`);
        return;
      }
      const chapterData = mappedChapters[Math.floor(Math.random() * mappedChapters.length)];
      const chapter = chapterData.chapter;

      // Fetch nodes for the chapter
      let treeStructure;
      try {
        treeStructure = await fetchTreeStructure(category, chapter);
      } catch (error) {
        console.error(`Failed to fetch tree structure for ${category} - ${chapter}:`, error.message);
        continue;
      }

      const nodes = [];
      function traverse(node) {
        if (!node || typeof node !== 'object') return;
        if (typeof node === 'string') {
          nodes.push(node);
          return;
        }
        if (node.topic || node.subtopic || node.detail || node.subdetail) {
          nodes.push(node.topic || node.subtopic || node.detail || node.subdetail);
        }
        ['topics', 'subtopics', 'details', 'subdetails', 'particulars'].forEach(key => {
          if (node[key] && Array.isArray(node[key])) {
            node[key].forEach(child => traverse(child));
          }
        });
      }

      if (!treeStructure || !treeStructure.topics || !Array.isArray(treeStructure.topics)) {
        console.error(`Invalid tree structure for ${category} - ${chapter}`);
        continue;
      }

      treeStructure.topics.forEach(topic => {
        if (topic) traverse(topic);
      });

      if (nodes.length === 0) {
        console.error(`No nodes found for ${category} - ${chapter}`);
        continue;
      }

      // Randomly select node
      const node = nodes[Math.floor(Math.random() * nodes.length)];

      // Randomly select falseCount
      const falseCount = Math.floor(Math.random() * 4) + 1;

      // Generate statements
      const thread = await openai.beta.threads.create();
      const threadId = thread.id;

      let statementsResult;
      try {
        statementsResult = await generateFalseStatements(threadId, category, chapter, node, falseCount);
      } catch (error) {
        console.error(`Failed to generate statements for ${category} - ${chapter} - ${node}:`, error.message);
        continue;
      }

      // Transform to MCQ
      const mcqData = transformStatementsToMCQ(statementsResult, bookName);

      // Save to transformer collection
      try {
        await axios.post('http://localhost:5001/admin/save-transformed-mcq', {
          book: bookName,
          category,
          chapter,
          mcq: mcqData
        });
      } catch (error) {
        console.error(`Failed to save MCQ for ${category} - ${chapter} - ${node}:`, error.message);
        continue;
      }

      current++;
      res.write(`data: ${JSON.stringify({ status: 'progress', current, total: batchSize })}\n\n`);
    }

    if (batchRunning && app.locals.batchRunning[category]) {
      res.write(`data: ${JSON.stringify({ status: 'complete' })}\n\n`);
    }
  } catch (error) {
    console.error(`Error in /admin/start-statement-batch-production/${category}:`, error.message, error.stack);
    res.write(`data: ${JSON.stringify({ status: 'error', message: error.message })}\n\n`);
  } finally {
    app.locals.batchRunning[category] = false;
    res.end();
  }
});

// New endpoint to stop batch production for a specific category
app.post("/admin/stop-statement-batch-production/:category", async (req, res) => {
  const category = req.params.category;
  try {
    if (!app.locals.batchRunning) {
      app.locals.batchRunning = {};
    }
    app.locals.batchRunning[category] = false;
    res.status(200).json({ message: `Batch production stopped for ${category}` });
  } catch (error) {
    console.error(`Error in /admin/stop-statement-batch-production/${category}:`, error.message, error.stack);
    res.status(500).json({ error: "Failed to stop batch production", details: error.message });
  }
});

app.use((req, res, next) => {
  if (!mongoConnected || !db) {
    console.error(`MongoDB not connected for request: ${req.method} ${req.path}`);
    return res.status(503).json({ error: "Service Unavailable: Database not connected", details: "Please try again later" });
  }
  next();
});

const PORT = process.env.ADMIN_PORT || 5001;
connectToMongoDB(process.env.MONGODB_URI).then(({ db: database, mongoConnected: connected }) => {
  db = database;
  mongoConnected = connected;
  fetchAndCacheBookMappings().then(() => {
    app.listen(PORT, '127.0.0.1', () => {
      console.log(`Admin server running on http://127.0.0.1:${PORT}`);
    });
  }).catch(err => {
    console.error("Failed to initialize book mappings cache:", err.message, err.stack);
    process.exit(1);
  });
}).catch(err => {
  console.error("MongoDB connection failed:", err.message, err.stack);
  process.exit(1);
});

// Utility
function safeJsonParse(text) {
  let jsonText = text.trim();
  jsonText = jsonText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  const firstBrace = jsonText.indexOf('{');
  const lastBrace = jsonText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    jsonText = jsonText.substring(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(jsonText);
  } catch (e) {
    console.error('Failed to parse JSON:', e.message, jsonText);
    return { error: "Unable to generate valid JSON response", details: e.message };
  }
}
// MongoDB Atlas connection string
const MONGO_URI = 'mongodb+srv://yy838381:24TbbKWPpzmpXrqJ@cluster0.swtwa.mongodb.net/trainwithme?retryWrites=true&w=majority&appName=Cluster0&tls=true&tlsAllowInvalidCertificates=true';


// Insert before /admin/generate-parsed-mcq (around line ~3170)
async function refineNode(threadId, rawNode, bookName) {
  const prompt = `
You are an AI designed to refine raw, disjointed sentences into a concise, highly factual, and well-organized node for the TrainWithMe platform, aligned with UPSC-style MCQ generation. The raw sentences are from "${bookName}". Using these sentences and your general knowledge, create a node of 100–150 words that is precise, coherent, and rich in factual details relevant to the book’s content.

**Instructions:**
- **Input**: Raw sentences: "${rawNode}".
- **Output**: A single paragraph (100–150 words) summarizing key facts, organized logically (e.g., broad concept to specifics).
- **Content**: Focus on the book’s subject, using raw sentences as a base and supplementing with accurate details from "${bookName}".
- **Style**: Clear, academic, UPSC-relevant, avoiding fluff or unrelated topics.
- **Format**: Return only the pointers like this 1) - , 2) , no JSON, markdown, or extra text.
- **factual Accuracy** : verify the factual accuaracy of pointers before presenting them.
`;

  try {
    await acquireLock(threadId);
    console.log(`Sending node refinement request to OpenAI thread ${threadId}`);
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: prompt,
    });

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: assistantId,
    }, { maxRetries: 2 });

    const runStatus = await waitForRunToComplete(threadId, run.id);
    if (runStatus.status === "failed") {
      throw new Error(`OpenAI run failed: ${runStatus.last_error?.message || "Unknown failure reason"}`);
    }

    const messages = await openai.beta.threads.messages.list(threadId);
    const latestMessage = messages.data.find(m => m.role === "assistant");
    if (!latestMessage || !latestMessage.content[0]?.text?.value) {
      throw new Error("No response from OpenAI for node refinement");
    }

    return latestMessage.content[0].text.value.trim();
  } finally {
    releaseLock(threadId);
  }
}
// Add parsedBookMappings before /admin/generate-parsed-mcq (around line ~3170)
const parsedBookMappings = {
  "Shankar IAS Environment Book": { id: "6835979fea2da5f5106eab3f", category: "Environment" },
  "Laxmikanth Indian Polity": { id: "68369a960d09b7b6f7f11280", category: "Politics" },
  "TamilNadu History Book": { id: "68369f1d0d09b7b6f7f11281", category: "History" },
  "Spectrum Modern History": { id: "6836a9b90d09b7b6f7f11282", category: "History" },
  "Nitin Singhania Indian Art and Culture": { id: "6836ac2b0d09b7b6f7f11283", category: "Culture" },
  "Ramesh Singh Economy": { id: "6836b16e6380699f68709461", category: "Economy" },
  "Disha Ias Previous Year Papers": { id: "6836bb236380699f68709462", category: "General Studies" },
  "Disha Ias Science Book": { id: "6836be676380699f68709463", category: "Science" },
  "Disha Ias CSAT Book": { id: "6836bfdf6380699f68709464", category: "CSAT" },
  "Vision Ias April Magzine": { id: "6836c2da6380699f68709465", category: "Current Affairs" },
  "Indian Physical Environment": { id: "6836dddb6380699f68709466", category: "Geography" },
  "Fundamentals of Physical Geography": { id: "6836df6d6380699f68709469", category: "Geography" },
};
// Replace /admin/generate-parsed-mcq (lines ~3198–3292)
app.post('/admin/generate-parsed-mcq', async (req, res) => {
  try {
    const { falseCount, bookName } = req.body;
    console.log(`Handling request for /admin/generate-parsed-mcq: falseCount=${falseCount}, bookName=${bookName}`);

    if (!Number.isInteger(falseCount) || falseCount < 0 || falseCount > 4) {
      console.error('Invalid falseCount:', falseCount);
      return res.status(400).json({ error: 'falseCount must be an integer between 0 and 4' });
    }
    if (!bookName || !parsedBookMappings[bookName]) {
      console.error('Invalid or missing bookName:', bookName);
      return res.status(400).json({ error: 'Invalid or missing bookName' });
    }

    const bookId = parsedBookMappings[bookName].id;
    const category = parsedBookMappings[bookName].category;
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    console.log('Connected to MongoDB Atlas at', process.env.MONGODB_URI.replace(/\/\/.*@/, '//****:****@'));

    const db = client.db('trainwithme');
    console.log('Accessing database: trainwithme');

    const collections = await db.listCollections({ name: 'parsed_book' }).toArray();
    if (collections.length === 0) {
      console.log('Collection parsed_book not found, creating it');
      await db.createCollection('parsed_book');
    }

    const collection = db.collection('parsed_book');
    console.log('Accessing collection: parsed_book');

    let bookDoc = await collection.findOne({ _id: new ObjectId(bookId) });
    console.log(`Queried document by _id: ${bookId}, found:`, bookDoc ? 'Yes' : 'No');

    if (!bookDoc) {
      console.log('Debugging: Attempting to find any document in parsed_book');
      bookDoc = await collection.findOne({});
      if (bookDoc) {
        console.log('Fallback document found with _id:', bookDoc._id.toString());
      }
    }

    if (!bookDoc) {
      console.log('Debugging: Collection stats for parsed_book');
      const stats = await collection.stats();
      console.log('Collection stats:', { documentCount: stats.count, size: stats.size, storageSize: stats.storageSize });

      console.log('Debugging: Listing all databases and collections');
      const adminDb = client.db().admin();
      const databases = await adminDb.listDatabases();
      console.log('Available databases:', databases.databases.map(db => db.name));

      console.log('Debugging: Listing collections in trainwithme');
      const collectionsList = await db.listCollections().toArray();
      console.log('Collections in trainwithme:', collectionsList.map(col => col.name));

      console.log('Debugging: Listing all documents in parsed_book');
      const allDocs = await collection.find({}).toArray();
      console.log('Found documents:', allDocs.map(doc => ({
        _id: doc._id.toString(),
        hasPages: !!doc.pages,
        pageCount: Array.isArray(doc.pages) ? doc.pages.length : 0,
        fields: Object.keys(doc)
      })));

      console.log('Debugging: Checking other collections in trainwithme for pages array');
      const otherCollections = ['book_mappings', 'mcqs', 'book_themes'];
      for (const colName of otherCollections) {
        const col = db.collection(colName);
        const docs = await col.find({ pages: { $exists: true } }).limit(5).toArray();
        if (docs.length > 0) {
          console.log(`Found documents with pages in ${colName}:`, docs.map(doc => ({
            _id: doc._id.toString(),
            pageCount: Array.isArray(doc.pages) ? doc.pages.length : 0
          })));
        }
      }

      await client.close();
      return res.status(400).json({ 
        error: `Document not found by _id: ${bookId}`,
        debug: 'trainwithme.parsed_book is empty or document missing. Re-import JSON file or check _id. See server logs.'
      });
    }

    if (!bookDoc.pages || !Array.isArray(bookDoc.pages) || bookDoc.pages.length === 0) {
      console.error('Invalid or empty pages array in document:', bookDoc._id.toString());
      await client.close();
      return res.status(400).json({ error: 'Invalid or empty pages array in document' });
    }

    console.log(`Document has ${bookDoc.pages.length} pages`);

    console.log('Debugging: Sample page content (first 5 pages with text):');
    for (let i = 0; i < Math.min(5, bookDoc.pages.length); i++) {
      if (bookDoc.pages[i]?.text) {
        console.log(`Page ${i + 1} text (first 100 chars):`, bookDoc.pages[i].text.substring(0, 100));
      }
    }

    const pageIndices = [];
    const maxRetries = 30;
    let retries = 0;
    while (pageIndices.length < 3 && retries < maxRetries) {
      const index = Math.floor(Math.random() * bookDoc.pages.length);
      if (!pageIndices.includes(index)) {
        const page = bookDoc.pages[index];
        if (
          page?.text &&
          typeof page.text === 'string' &&
          page.text.trim().length > 500 &&
          page.text.trim().split(/\s+/).length >= 50
        ) {
          pageIndices.push(index);
          console.log(`Selected page ${index + 1} with text length: ${page.text.length}`);
        } else {
          console.log(`Skipping page ${index + 1}: insufficient or invalid text`);
        }
      }
      retries++;
    }

    if (pageIndices.length === 0) {
      console.error('No valid pages with sufficient text found after retries');
      await client.close();
      return res.status(500).json({ error: 'No valid pages with sufficient text found' });
    }

    console.log(`Selected ${pageIndices.length} pages: ${pageIndices.map(i => i + 1).join(', ')}`);

    let sentences = [];
    try {
      const tokenizer = new natural.SentenceTokenizer();
      for (const index of pageIndices) {
        const page = bookDoc.pages[index];
        const pageSentences = tokenizer.tokenize(page.text);
        const validSentences = pageSentences
          .filter((sentence) => {
            const wordCount = sentence.trim().split(/\s+/).length;
            const isValid = wordCount >= 5 && !sentence.match(/^(Figure|Table|Chapter|Section|NetShop|SHANKAR|[a-d]\.|[\d]+\.)/i);
            if (!isValid) {
              console.log(`Filtered out sentence from page ${index + 1}: "${sentence}"`);
            }
            return isValid;
          })
          .slice(0, 5);

        sentences = sentences.concat(validSentences);
        console.log(`Extracted ${validSentences.length} sentences from page ${index + 1}`);
      }
    } catch (error) {
      console.error('Failed to tokenize sentences:', error.message);
      await client.close();
      return res.status(500).json({ error: 'Failed to tokenize sentences', details: error.message });
    }

    if (sentences.length < 10) {
      console.warn(`Only ${sentences.length} sentences extracted, attempting to select more pages`);
      let additionalRetries = 0;
      const maxAdditionalRetries = 10;
      while (sentences.length < 10 && additionalRetries < maxAdditionalRetries && pageIndices.length < bookDoc.pages.length) {
        const index = Math.floor(Math.random() * bookDoc.pages.length);
        if (!pageIndices.includes(index)) {
          const page = bookDoc.pages[index];
          if (
            page?.text &&
            typeof page.text === 'string' &&
            page.text.trim().length > 500 &&
            page.text.trim().split(/\s+/).length >= 50
          ) {
            pageIndices.push(index);
            const pageSentences = new natural.SentenceTokenizer().tokenize(page.text);
            const validSentences = pageSentences
              .filter((sentence) => {
                const wordCount = sentence.trim().split(/\s+/).length;
                const isValid = wordCount >= 5 && !sentence.match(/^(Figure|Table|Chapter|Section|NetShop|SHANKAR|[a-d]\.|[\d]+\.)/i);
                return isValid;
              })
              .slice(0, 5);
            sentences = sentences.concat(validSentences);
            console.log(`Extracted ${validSentences.length} additional sentences from page ${index + 1}`);
          }
        }
        additionalRetries++;
      }
    }

    if (sentences.length === 0) {
      console.error('No valid sentences extracted from selected pages');
      await client.close();
      return res.status(500).json({ error: 'No valid sentences found in selected pages' });
    }

    console.log(`Total sentences extracted: ${sentences.length}`);

    let rawNode = sentences.join(' ');
    const words = rawNode.split(/\s+/);
    if (words.length > 300) {
      rawNode = words.slice(0, 300).join(' ') + '...';
      console.log('Raw node truncated to ~300 words');
    }
    rawNode = sentences.join('\n');

    const thread = await openai.beta.threads.create();
    const threadId = thread.id;
    let refinedNode;
    try {
      refinedNode = await refineNode(threadId, rawNode, bookName);
      console.log('Refined node:', refinedNode);
    } catch (error) {
      console.error('Failed to refine node:', error.message);
      await client.close();
      return res.status(500).json({ error: 'Failed to refine node', details: error.message });
    }

    let result;
    try {
      result = await generateFalseStatements(threadId, category, 'Unknown Chapter', refinedNode, falseCount);
      console.log('Generated statements:', result.statements.length);
    } catch (error) {
      console.error('Failed to generate statements:', error.message);
      await client.close();
      return res.status(500).json({ error: 'Failed to generate statements', details: error.message });
    }

    const mcq = transformStatementsToMCQ({
      category,
      chapter: 'Unknown Chapter',
      node: refinedNode,
      statements: result.statements,
    }, bookName);

    await client.close();

    res.status(200).json({
      rawNode,
      refinedNode,
      statements: result.statements,
      mcq,
    });
  } catch (error) {
    console.error('Error in /admin/generate-parsed-mcq:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to process request', details: error.message });
  }
});
// New endpoint to get available parsed books (add after /admin/generate-parsed-mcq, around line ~3300)
app.get("/admin/get-parsed-books", async (req, res) => {
  try {
    const books = Object.keys(parsedBookMappings);
    res.status(200).json({ books });
  } catch (error) {
    console.error("Error in /admin/get-parsed-books:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch parsed books", details: error.message });
  }
});
// New batch production endpoint (add after /admin/get-parsed-books, around line ~3310)
app.get("/admin/start-parsed-mcq-batch-production/:category", async (req, res) => {
  const category = req.params.category;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const bookMapping = parsedBookMappings[category];
    if (!bookMapping) {
      res.write(`data: ${JSON.stringify({ status: 'error', message: `Book ${category} not found` })}\n\n`);
      res.end();
      return;
    }

    if (!app.locals.parsedBatchRunning) {
      app.locals.parsedBatchRunning = {};
    }
    app.locals.parsedBatchRunning[category] = true;

    const batchSize = 100;
    let current = 0;

    while (current < batchSize && app.locals.parsedBatchRunning[category]) {
      try {
        const falseCount = Math.floor(Math.random() * 4) + 1;
        const response = await axios.post('http://localhost:5001/admin/generate-parsed-mcq', {
          bookName: category,
          falseCount,
        });

        const { rawNode, refinedNode, statements, mcq } = response.data;
        const mcqDoc = {
          bookId: bookMapping.id,
          bookName: category,
          falseCount,
          rawNode,
          refinedNode,
          statements,
          mcq,
          createdAt: new Date(),
        };

        const insertResult = await db.collection('parsed_mcqs').insertOne(mcqDoc);
        current++;

        res.write(`data: ${JSON.stringify({ 
          status: 'progress', 
          current, 
          total: batchSize, 
          mcqId: insertResult.insertedId.toString() 
        })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Failed to generate MCQ for ${category}:`, error.message);
        continue;
      }
    }

    if (app.locals.parsedBatchRunning[category]) {
      res.write(`data: ${JSON.stringify({ status: 'complete', total: current })}\n\n`);
    }
  } catch (error) {
    console.error(`Error in /admin/start-parsed-mcq-batch-production/${category}:`, error.message, error.stack);
    res.write(`data: ${JSON.stringify({ status: 'error', message: error.message })}\n\n`);
  } finally {
    app.locals.parsedBatchRunning[category] = false;
    res.end();
  }
});

// New stop endpoint (add after batch production endpoint, around line ~3370)
app.post("/admin/stop-parsed-mcq-batch-production/:category", async (req, res) => {
  const category = req.params.category;
  try {
    if (!app.locals.parsedBatchRunning) {
      app.locals.parsedBatchRunning = {};
    }
    app.locals.parsedBatchRunning[category] = false;
    res.status(200).json({ message: `Batch production stopped for ${category}` });
  } catch (error) {
    console.error(`Error in /admin/stop-parsed-mcq-batch-production/${category}:`, error.message, error.stack);
    res.status(500).json({ error: "Failed to stop batch production", details: error.message });
  }
});
app.post("/admin/transfer-parsed-mcqs-to-mcqs", async (req, res) => {
  try {
    const parsedMcqs = await db.collection("parsed_mcqs").find({}).toArray();
    if (parsedMcqs.length === 0) {
      console.log("No MCQs found in parsed_mcqs collection to transfer");
      return res.status(200).json({ message: "No MCQs found in parsed_mcqs collection to transfer", transferredCount: 0 });
    }

    const finalMcqs = parsedMcqs.map(mcq => {
      const bookMapping = parsedBookMappings[mcq.bookName] || { category: "Unknown" };
      return {
        book: mcq.bookName,
        category: bookMapping.category,
        chapter: "Unknown Chapter",
        mcq: mcq.mcq,
        createdAt: new Date(),
      };
    });

    const insertResult = await db.collection("mcqs").insertMany(finalMcqs);
    console.log(`Transferred ${insertResult.insertedCount} MCQs to mcqs collection`);

    await db.collection("parsed_mcqs").deleteMany({});
    console.log(`Deleted ${parsedMcqs.length} MCQs from parsed_mcqs collection`);

    res.status(200).json({ message: `Successfully transferred ${insertResult.insertedCount} MCQs to mcqs collection`, transferredCount: insertResult.insertedCount });
  } catch (error) {
    console.error("Error in /admin/transfer-parsed-mcqs-to-mcqs:", error.message, error.stack);
    res.status(500).json({ error: "Failed to transfer MCQs", details: error.message });
  }
});
/* Add to connectToMongoDB (around line ~50, after existing index creation) */
async function initializeCurrentAffairsCollections() {
  const collections = await db.listCollections({ name: "current_affairs_raw" }).toArray();
  if (collections.length === 0) {
    await db.createCollection("current_affairs_raw");
    await db.collection("current_affairs_raw").createIndex({ date: -1, source: 1 }, { background: true });
    console.log("Created current_affairs_raw collection with indexes");
  }

  const articleCollections = await db.listCollections({ name: "current_affairs_articles" }).toArray();
  if (articleCollections.length === 0) {
    await db.createCollection("current_affairs_articles");
    await db.collection("current_affairs_articles").createIndex({ date: -1, category: 1 }, { background: true });
    console.log("Created current_affairs_articles collection with indexes");
  }
}

/* Add after existing endpoints (around line ~3400) */
async function scrapeCurrentAffairs() {
  const axios = require('axios');
  const cheerio = require('cheerio');
  const puppeteer = require('puppeteer');

  // Define sources array with single Drishti IAS source
  const sources = [
    { url: 'https://www.drishtiias.com/current-affairs-news-analysis-editorials/news-analysis/28-05-2025', name: 'drishtiias.com' }
  ];

  const articles = [];
  let browser;

  for (const source of sources) {
    try {
      console.log(`Scraping ${source.url}`);

      // Try Cheerio for static content
      let articleElements = [];
      try {
        const response = await axios.get(source.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          timeout: 15000
        });
        const $ = cheerio.load(response.data);

        // Broad selectors for Drishti IAS articles
        articleElements = $('.news-item, .article, .post, .news-card, .content-block, li a, h2 a, h3 a').slice(0, 20);

        console.log(`${source.name} found ${articleElements.length} elements via Cheerio`);

        articleElements.each((i, element) => {
          const title = $(element).text().trim() || $(element).find('h2, h3, a, .title').text().trim();
          const link = $(element).attr('href') || $(element).find('a').attr('href');
          if (title && link) {
            const fullUrl = link.startsWith('http') ? link : `https://www.drishtiias.com${link}`;
            const summary = $(element).closest('div, li, .content-block')
              .find('p, .summary, .description').first().text().trim().slice(0, 200) || title.slice(0, 200);
            articles.push({
              title,
              summary,
              url: fullUrl,
              source: source.name,
              date: new Date().toISOString().split('T')[0],
              createdAt: new Date()
            });
          }
        });
      } catch (cheerioError) {
        console.warn(`Cheerio failed for ${source.url}: ${cheerioError.message}, falling back to Puppeteer`);
      }

      // If Cheerio found no elements, use Puppeteer
      if (articleElements.length === 0) {
        browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.goto(source.url, { waitUntil: 'networkidle2', timeout: 30000 });

        articleElements = await page.evaluate(() => {
          const items = document.querySelectorAll('.news-item, .article, .post, .news-card, .content-block, li a, h2 a, h3 a');
          return Array.from(items).map(item => ({
            title: item.querySelector('h2, h3, a, .title')?.innerText?.trim() || 
                   item.innerText?.trim() || '',
            href: item.href || item.querySelector('a')?.href || ''
          })).filter(item => item.title && item.href);
        });

        console.log(`${source.name} found ${articleElements.length} elements via Puppeteer:`, articleElements.map(e => e.title));

        articleElements.forEach(item => {
          const fullUrl = item.href.startsWith('http') ? item.href : `https://www.drishtiias.com${item.href}`;
          articles.push({
            title: item.title,
            summary: item.title.slice(0, 200),
            url: fullUrl,
            source: source.name,
            date: new Date().toISOString().split('T')[0],
            createdAt: new Date()
          });
        });

        await browser.close();
        browser = null;
      }
    } catch (error) {
      console.error(`Failed to scrape ${source.url}:`, error.message);
    } finally {
      if (browser) await browser.close();
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  try {
    const uniqueArticles = articles.filter((article, index, self) =>
      index === self.findIndex(a => a.title === article.title && a.source === article.source && a.date === article.date)
    );
    console.log(`Total unique articles: ${uniqueArticles.length}`);
    if (uniqueArticles.length > 0) {
      await db.collection("current_affairs_raw").insertMany(uniqueArticles);
      console.log(`Saved ${uniqueArticles.length} raw articles to current_affairs_raw`);
    }
    return { success: true, count: uniqueArticles.length, articles: uniqueArticles };
  } catch (error) {
    console.error("Failed to save raw articles:", error.message);
    return { success: false, error: error.message };
  }
}
async function processArticles(threadId) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const rawArticles = await db.collection("current_affairs_raw").find({ date: today }).toArray();
    console.log(`Processing ${rawArticles.length} raw articles`);

    const processedArticles = [];
    for (const article of rawArticles) {
      try {
        const prompt = `
You are an AI for the TrainWithMe platform, creating UPSC-style current affairs articles from scraped news. Summarize the news item into a concise, fact-based article (150–200 words) tailored for UPSC aspirants, focusing on exam-relevant details (e.g., policy, governance, international relations). Highlight 1–2 key facts and conclude with UPSC significance. Categorize into one of: National, International, Economy, Science and Technology, Editorial, Miscellaneous. Return JSON: {"article": String, "category": String}.

**News Item**:
- Title: "${article.title}"
- Summary: "${article.summary}"
- Source: ${article.source}
- URL: ${article.url}
`;

        await acquireLock(threadId);
        await openai.beta.threads.messages.create(threadId, {
          role: "user",
          content: prompt,
        });

        const run = await openai.beta.threads.runs.create(threadId, {
          assistant_id: assistantId,
        }, { maxRetries: 2 });

        const runStatus = await waitForRunToComplete(threadId, run.id);
        if (runStatus.status === "failed") {
          throw new Error(`OpenAI run failed: ${runStatus.last_error?.message || "Unknown failure reason"}`);
        }

        const messages = await openai.beta.threads.messages.list(threadId);
        const latestMessage = messages.data.find(m => m.role === "assistant");
        if (!latestMessage || !latestMessage.content[0]?.text?.value) {
          throw new Error("No response from OpenAI");
        }

        const response = JSON.parse(latestMessage.content[0].text.value);
        if (!response.article || !response.category) {
          throw new Error("Invalid AI response format");
        }

        processedArticles.push({
          title: article.title,
          article: response.article,
          category: response.category,
          source: article.source,
          date: article.date,
          createdAt: new Date()
        });
      } catch (error) {
        console.error(`Failed to process article "${article.title}":`, error.message);
      } finally {
        releaseLock(threadId);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (processedArticles.length > 0) {
      await db.collection("current_affairs_articles").insertMany(processedArticles);
      console.log(`Saved ${processedArticles.length} processed articles to current_affairs_articles`);
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    await db.collection("current_affairs_raw").deleteMany({ createdAt: { $lt: thirtyDaysAgo } });
    await db.collection("current_affairs_articles").deleteMany({ createdAt: { $lt: thirtyDaysAgo } });
    console.log("Cleaned up articles older than 30 days");
  } catch (error) {
    console.error("Failed to process articles:", error.message);
  }
}

function scheduleCurrentAffairsTasks() {
  cron.schedule('0 6 * * *', async () => {
    console.log("Starting daily current affairs scrape at 6 AM IST");
    await scrapeCurrentAffairs();
  }, { timezone: "Asia/Kolkata" });

  cron.schedule('15 6 * * *', async () => {
    console.log("Starting daily article processing at 6:15 AM IST");
    const thread = await openai.beta.threads.create();
    await processArticles(thread.id);
  }, { timezone: "Asia/Kolkata" });
}

app.get("/admin/get-current-affairs-articles", async (req, res) => {
  try {
    const { date, category, page = 1, limit = 10 } = req.query;
    const query = {};
    if (date) query.date = date;
    if (category) query.category = category;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const articles = await db.collection("current_affairs_articles")
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const totalArticles = await db.collection("current_affairs_articles").countDocuments(query);

    res.status(200).json({
      articles,
      totalArticles,
      currentPage: parseInt(page)
    });
  } catch (error) {
    console.error("Error in /admin/get-current-affairs-articles:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch articles", details: error.message });
  }
});
app.post("/admin/scrape-current-affairs", async (req, res) => {
  if (!mongoConnected || !db) {
    console.error("MongoDB not connected for scraping request");
    return res.status(503).json({ error: "Service Unavailable: Database not connected" });
  }
  try {
    console.log("Starting current affairs scraping...");
    const result = await scrapeCurrentAffairs();
    res.status(200).json({
      success: result.success,
      count: result.count,
      articles: result.articles,
      message: result.count > 0 ? `Successfully scraped and saved ${result.count} articles` : "No articles scraped"
    });
  } catch (error) {
    console.error("Scraping error:", error.message, error.stack);
    res.status(500).json({ error: "Failed to scrape articles", details: error.message });
  }
});
// Fetch parsed current affairs documents
app.get("/admin/get-parsed-current-affairs", async (req, res) => {
  if (!mongoConnected || !db) {
    return res.status(503).json({ error: "Database not connected" });
  }
  try {
    const documents = await db.collection("current_affairs_raw").find({}).sort({ date: -1 }).limit(50).toArray();
    res.status(200).json({ documents });
  } catch (error) {
    console.error("Error fetching parsed documents:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch parsed documents", details: error.message });
  }
});

// Generate current affairs article
// Replace /admin/generate-current-affairs-article (around line ~3624)
app.post("/admin/generate-current-affairs-article", async (req, res) => {
  console.log("Entering /admin/generate-current-affairs-article");
  if (!mongoConnected || !db) {
    console.error("MongoDB not connected");
    return res.status(503).json({ error: "Database not connected" });
  }
  const { documentId } = req.body;
  if (!documentId) {
    console.error("Missing documentId");
    return res.status(400).json({ error: "Document ID is required" });
  }

  try {
    console.log(`Fetching document: ${documentId}`);
    // Fetch parsed document with timeout
    const document = await Promise.race([
      db.collection("current_affairs_raw").findOne({ _id: new mongodb.ObjectId(documentId) }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("MongoDB query timeout")), 5000))
    ]);
    if (!document) {
      console.error("Document not found");
      return res.status(404).json({ error: "Document not found" });
    }
    console.log("Document fetched:", document._id);

    // Extract content from pages
    console.log("Extracting pages");
    const pages = Array.isArray(document.pages)
      ? document.pages.map(page => typeof page === 'string' ? page : page.text || '').filter(text => text)
      : [];
    if (pages.length === 0) {
      console.error("No content in pages");
      throw new Error("No content found in document pages");
    }
    console.log(`Found ${pages.length} pages`);

    // Extract metadata
    const title = document.job_metadata?.title || document.title || 'Daily Current Affairs';
    const date = document.job_metadata?.date || document.date || new Date().toISOString().split('T')[0];
    const source = document.job_metadata?.source || document.source || 'unknown';
    console.log(`Metadata: title=${title}, date=${date}, source=${source}`);

    const articles = [];
    const batchSize = 5; // Process 5 pages at a time
    for (let i = 0; i < pages.length; i += batchSize) {
      console.log(`Processing batch ${i / batchSize + 1}`);
      const batchPages = pages.slice(i, i + batchSize);
      const batchContent = batchPages.join('\n\n');

      // Split batch content into topics
      console.log("Calling OpenAI for topic extraction");
      const topicResponse = await Promise.race([
        openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            {
              role: "system",
              content: "You are an expert in UPSC exam preparation. Analyze the provided current affairs content and identify distinct topics or sections (up to 3 per batch). Return a JSON array of topics, each with a 'title' (short heading) and 'description' (up to 50 words)."
            },
            {
              role: "user",
              content: `Title: ${title}\nContent: ${batchContent}\nReturn JSON: [{ "title": "...", "description": "..." }, ...]`
            }
          ]
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("OpenAI topic extraction timeout")), 30000))
      ]);
      console.log("Topic response received");

      let topics = [];
      try {
        topics = JSON.parse(topicResponse.choices[0].message.content);
      } catch (e) {
        console.warn(`Failed to parse topics for batch ${i / batchSize + 1}: ${e.message}`);
        continue;
      }
      if (!Array.isArray(topics) || topics.length === 0) {
        console.warn(`No topics identified in batch ${i / batchSize + 1}`);
        continue;
      }
      console.log(`Identified ${topics.length} topics`);

      for (const topic of topics.slice(0, 3)) { // Limit to 3 topics per batch
        console.log(`Generating article for topic: ${topic.title}`);
        // Generate article
        const articleResponse = await Promise.race([
          openai.chat.completions.create({
            model: "gpt-4",
            messages: [
              {
                role: "system",
                content: "You are an expert in UPSC exam preparation. Create a precise and concise article (150–200 words) based on the provided topic and content, suitable for UPSC aspirants. Include a clear heading and focus on key facts, implications, and relevance."
              },
              {
                role: "user",
                content: `Document Title: ${title}\nContent: ${batchContent}\nTopic: ${topic.title}\nDescription: ${topic.description}\nWrite a 150–200 word article with a heading.`
              }
            ]
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("OpenAI article generation timeout")), 30000))
        ]);

        const articleText = articleResponse.choices[0].message.content;
        const headingMatch = articleText.match(/^#+\s*(.+)$/m);
        const heading = headingMatch ? headingMatch[1] : topic.title;
        const contentText = articleText.replace(/^#+\s*.+$/m, '').trim();
        console.log(`Article generated: ${heading}`);

        // Fetch image from Unsplash with retry and fallback
        let imageUrl = 'https://via.placeholder.com/300';
        try {
          if (!process.env.UNSPLASH_ACCESS_KEY) {
            throw new Error("Unsplash API key missing");
          }
          if (unsplashRequestCount >= unsplashRateLimit) {
            throw new Error("Unsplash rate limit exceeded");
          }
          unsplashRequestCount++;
          console.log(`Fetching Unsplash image for "${heading}"`);
          const unsplashResponse = await retryRequest(() =>
            axios.get('https://api.unsplash.com/search/photos', {
              params: { query: heading, per_page: 1 },
              headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
              timeout: 10000 // 10s timeout
            })
          );
          imageUrl = unsplashResponse.data.results[0]?.urls?.regular || imageUrl;
          console.log(`Image URL: ${imageUrl}`);
        } catch (unsplashError) {
          console.warn(`Failed to fetch Unsplash image for "${heading}": ${unsplashError.message}`);
        }

        // Save article
        console.log("Saving article to MongoDB");
        const articleDoc = {
          heading,
          content: contentText,
          imageUrl,
          date,
          source,
          createdAt: new Date()
        };
        await db.collection("current_affairs_articles").insertOne(articleDoc);
        articles.push(articleDoc);
        console.log("Article saved");
      }
    }

    if (articles.length === 0) {
      console.error("No articles generated");
      throw new Error("No articles generated from document");
    }

    console.log(`Generated ${articles.length} articles`);
    res.status(200).json({ articles, count: articles.length });
  } catch (error) {
    console.error("Error generating articles:", error.message, error.stack);
    res.status(500).json({ error: "Failed to generate articles", details: error.message });
  }
});