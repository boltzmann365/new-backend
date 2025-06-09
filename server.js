const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");

dotenv.config();
const app = express();

// CORS Configuration
const allowedOrigins = [
  "https://trainwithme.in",
  "http://localhost:3000",
  "https://localhost:3000",
  "http://localhost:3001",
  "https://trainwithme-backend.vercel.app",
  "https://trainwithme-backend-fpbqr9rqr-yogesh-yadavs-projects-b7fc36f0.vercel.app",
  "https://backend-lyart-one-89.vercel.app",
  "https://backend-krowav4fm-yogesh-yadavs-projects-b7fc36f0.vercel.app",
  "https://backend-n5ubeeejd-yogesh-yadavs-projects-b7fc36f0.vercel.app",
  "https://backend-production-d60b.up.railway.app",
  "https://your-frontend.up.railway.app",
  "https://frontend-1wn4bppay-yogesh-yadavs-projects-b7fc36f0.vercel.app",
  "https://frontend-9i4djmspa-yogesh-yadavs-projects-b7fc36f0.vercel.app"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, origin || '*');
    } else {
      console.warn(`Blocked CORS request from origin: ${origin}`);
      callback(new Error(`CORS policy: Origin ${origin} not allowed`));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204
}));

app.use((req, res, next) => {
  res.on('finish', () => {
    if (!res.get('Access-Control-Allow-Origin')) {
      res.set('Access-Control-Allow-Origin', allowedOrigins.includes(req.headers.origin) ? req.headers.origin : '*');
    }
  });
  next();
});

app.use((req, res, next) => {
  console.log(`Request: ${req.method} ${req.path}, Origin: ${req.headers.origin || 'none'}, Headers: ${JSON.stringify(req.headers)}`);
  next();
});

app.use(express.json());

// MongoDB Setup
let db;
let mongoConnected = false;

async function connectToMongoDB(uri) {
  if (!uri) {
    console.error("MONGODB_URI is undefined or not set in environment variables");
    throw new Error("MONGODB_URI is not defined");
  }
  console.log("Using MONGODB_URI:", uri.replace(/:([^:@]+)@/, ':****@'));
  const client = new MongoClient(uri, {
    maxPoolSize: 10,
    connectTimeoutMS: 30000,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    retryWrites: true,
    retryReads: true,
    w: 'majority',
    serverApi: { version: '1', strict: true, deprecationErrors: true }
  });
  const maxRetries = 5;
  let attempt = 1;

  while (attempt <= maxRetries) {
    try {
      console.log(`Attempting MongoDB connection (Attempt ${attempt}/${maxRetries})`);
      await client.connect();
      console.log("Connected to MongoDB Atlas");
      db = client.db("trainwithme");
      mongoConnected = true;

      await db.collection("mcqs").createIndex({ category: 1, createdAt: -1 });
      await db.collection("users").createIndex({ email: 1 }, { unique: true });
      await db.collection("battleground_rankings").createIndex({ username: 1 }, { unique: true });
      await db.collection("battleground_rankings").createIndex({ score: -1, date: 1 });
      await db.collection("user_seen_mcqs").createIndex(
        { userId: 1, mcqId: 1 },
        { unique: true, background: false }
      );
      await db.collection("reported_mcqs").createIndex(
        { userId: 1, mcqId: 1 },
        { unique: true, background: false }
      );
      await db.collection("current_affairs_articles").createIndex(
        { date: -1, category: 1 },
        { background: false }
      );
      await db.collection("parsed_current_affairs").createIndex(
        { createdAt: -1 },
        { background: false }
      );
      await db.collection("QandA").createIndex(
        { bookName: 1, createdAt: -1 },
        { background: false }
      );
      console.log("MongoDB indexes created");

      client.on('error', (err) => {
        console.error("MongoDB client error:", err.message);
        mongoConnected = false;
      });
      client.on('close', () => {
        console.warn("MongoDB connection closed");
        mongoConnected = false;
      });
      return { client, db, mongoConnected };
    } catch (error) {
      console.error(`MongoDB connection attempt ${attempt} failed:`, error.code, error.message, error.stack);
      if (attempt === maxRetries) {
        mongoConnected = false;
        throw error;
      }
      attempt++;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

connectToMongoDB(process.env.MONGODB_URI).then(({ db: database, mongoConnected: connected }) => {
  db = database;
  mongoConnected = connected;
  console.log("MongoDB connection established successfully");
}).catch(err => {
  console.error("MongoDB connection failed permanently:", err.message);
  mongoConnected = false;
});

// Category to Book Map
const categoryToBookMap = {
  TamilnaduHistory: { bookName: "Tamilnadu History Book", category: "History" },
  Spectrum: { bookName: "Spectrum Book", category: "History" },
  ArtAndCulture: { bookName: "Nitin Singhania Art and Culture Book", category: "History" },
  FundamentalGeography: { bookName: "NCERT Class 11th Fundamentals of Physical Geography", category: "Geography" },
  IndianGeography: { bookName: "NCERT Class 11th Indian Geography", category: "Geography" },
  Science: { bookName: "Disha IAS Previous Year Papers (Science Section)", category: "Science" },
  Environment: { bookName: "Shankar IAS Environment Book", category: "Environment" },
  Economy: { bookName: "Ramesh Singh Indian Economy Book", category: "Economy" },
  CSAT: { bookName: "Disha IAS Previous Year Papers (CSAT Section)", category: "CSAT" },
  CurrentAffairs: { bookName: "Vision IAS Current Affairs Magazine", category: "Current Affairs" },
  PreviousYearPapers: { bookName: "Disha Publication’s UPSC Prelims Previous Year Papers", category: "Previous Year Papers" },
  Polity: { bookName: "Laxmikanth Indian Polity", category: "Politics" }
};

// Health Check Endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    mongoConnected,
    message: "TrainWithMe Backend API",
    timestamp: new Date().toISOString()
  });
});

// Routes for Default Handling
app.get("/", (req, res) => {
  res.status(200).json({ status: "OK", message: "TrainWithMe Backend API", mongoConnected });
});
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.get("/favicon.png", (req, res) => res.status(204).end());

// Endpoint to fetch QandA pairs
app.get("/user/get-qanda", async (req, res) => {
  try {
    const { userId, book, bookName, category, page = 1, limit = 10 } = req.query;
    console.log(`Fetching QandA for userId: ${userId}, book: ${book}, bookName: ${bookName}, category: ${category}, page: ${page}, limit: ${limit}`);

    if (!userId) {
      console.log(`Validation failed: Missing userId`);
      return res.status(400).json({ error: "Missing userId" });
    }

    if (book && !categoryToBookMap[book]) {
      console.log(`Validation failed: Invalid book - ${book}`);
      return res.status(400).json({ error: "Invalid book. Valid books are: " + Object.keys(categoryToBookMap).join(", ") });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const query = {};
    // Add userId to query if pairs are user-specific
    // query.userId = userId; // Uncomment if Q&A pairs have a userId field
    if (book) {
      query.bookName = categoryToBookMap[book].bookName;
    } else if (bookName && bookName !== "All") {
      query.bookName = bookName;
    } else if (category && category !== "All") {
      query.category = category; // Filter by category
    }

    const qanda = await db.collection("QandA")
      .find(query)
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .toArray();

    console.log(`Fetched ${qanda.length} QandA pairs for query:`, query);
    res.status(200).json({ qanda });
  } catch (error) {
    console.error("Error fetching QandA:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch QandA", details: error.message });
  }
});

// Endpoint to fetch MCQs for a book
app.post("/user/get-book-mcqs", async (req, res) => {
  try {
    const { userId, book, requestedCount } = req.body;
    console.log(`Fetching MCQs for userId: ${userId}, book: ${book}, requestedCount: ${requestedCount}`);

    if (!userId || !book || !categoryToBookMap[book] || !requestedCount) {
      console.log(`Validation failed: Missing or invalid parameters - userId: ${userId}, book: ${book}, requestedCount: ${requestedCount}`);
      return res.status(400).json({ error: "Missing or invalid parameters" });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const seenMcqs = await db.collection("user_seen_mcqs")
      .find({ userId })
      .project({ mcqId: 1 })
      .toArray();
    const seenMcqIds = seenMcqs.map(doc => doc.mcqId);
    console.log(`Found ${seenMcqIds.length} seen MCQs for userId: ${userId}`);

    const query = {
      category: categoryToBookMap[book].category, // Use mapped category
      _id: { $nin: seenMcqIds.map(id => new ObjectId(id)) }
    };
    console.log("Executing query:", query);

    const mcqs = await db.collection("mcqs")
      .find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(requestedCount, 100))
      .toArray();

    console.log(`Fetched ${mcqs.length} MCQs for userId: ${userId}, book: ${book}`, mcqs);
    if (!mcqs || mcqs.length === 0) {
      console.log(`No new MCQs found for userId: ${userId}, book: ${book}`);
      return res.status(404).json({ error: "No new MCQs available" });
    }

    res.status(200).json({ mcqs });
  } catch (error) {
    console.error("Error fetching MCQs:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch MCQs", details: error.message });
  }
});

// Endpoint to fetch current affairs articles
app.get("/admin/get-current-affairs-articles", async (req, res) => {
  try {
    const { startDate, page = 1, limit = 10 } = req.query;
    console.log(`Fetching current affairs articles: startDate=${startDate}, page=${page}, limit=${limit}`);

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const query = {};
    if (startDate) {
      // Fetch articles from startDate to present
      query.date = { $gte: new Date(startDate).toISOString() };
    }

    const articles = await db.collection("current_affairs_articles")
      .find(query)
      .sort({ date: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .toArray();

    console.log(`Fetched ${articles.length} current affairs articles for startDate=${startDate}, page=${page}`);
    res.status(200).json({ articles });
  } catch (error) {
    console.error("Error fetching current affairs articles:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch articles", details: error.message });
  }
});

// Global Error Middleware
app.use((err, req, res, next) => {
  console.error(`Unhandled error: ${err.message}, Stack: ${err.stack}`);
  res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes(req.headers.origin) ? req.headers.origin : '*');
  res.status(500).json({
    error: "Internal server error",
    details: err.message || "An unexpected error occurred"
  });
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Export for Vercel serverless
module.exports = app;
// In server.js, add this endpoint
// In server.js, replace or add this endpoint
app.get("/user/get-profile", async (req, res) => {
  try {
    const { email } = req.query;
    console.log(`Fetching profile for email: ${email}`);

    if (!email) {
      console.log(`Validation failed: Missing email`);
      return res.status(400).json({ error: "Missing email" });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const user = await db.collection("users").findOne({ email });
    if (!user) {
      console.log(`User not found for email: ${email}`);
      return res.status(404).json({ error: "User not found" });
    }

    console.log(`Fetched profile for email: ${email}`);
    res.status(200).json({ user: { username: user.username, email: user.email } });
  } catch (error) {
    console.error("Error fetching profile:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch profile", details: error.message });
  }
});
