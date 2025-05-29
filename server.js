const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");

dotenv.config();
const app = express();

// CORS Configuration
const allowedOrigins = ["https://trainwithme.in", "http://localhost:3000", "http://localhost:3001"];
app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

app.use((req, res, next) => {
  console.log(`Request: ${req.method} ${req.path}, Origin: ${req.headers.origin}`);
  next();
});

app.use(express.json());

// MongoDB Setup
let db;
let mongoConnected = false;

async function connectToMongoDB(uri) {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    console.log("Connected to MongoDB Atlas");
    db = client.db("trainwithme");
    mongoConnected = true;

    // Create indexes for collections
    await db.collection("mcqs").createIndex({ category: 1, createdAt: -1 });
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    await db.collection("battleground_rankings").createIndex({ username: 1 }, { unique: true });
    await db.collection("battleground_rankings").createIndex({ score: -1, date: 1 });
    await db.collection("user_seen_mcqs").createIndex(
      { userId: 1, mcqId: 1 },
      { unique: true, background: true }
    );
    await db.collection("reported_mcqs").createIndex(
      { userId: 1, mcqId: 1 },
      { unique: true, background: true }
    );
    await db.collection("current_affairs_articles").createIndex({ date: -1, category: 1 }, { background: true }); // Added index
    console.log("MongoDB indexes created");
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error.message);
    mongoConnected = false;
    throw error;
  }
  return { client, db, mongoConnected };
}

connectToMongoDB(process.env.MONGODB_URI).then(({ db: database, mongoConnected: connected }) => {
  db = database;
  mongoConnected = connected;
}).catch(err => {
  console.error("MongoDB connection failed:", err.message);
  process.exit(1);
});

// Category to Book Map
const categoryToBookMap = {
  TamilnaduHistory: { bookName: "Tamilnadu History Book" },
  Spectrum: { bookName: "Spectrum Book" },
  ArtAndCulture: { bookName: "Nitin Singhania Art and Culture Book" },
  FundamentalGeography: { bookName: "NCERT Class 11th Fundamentals of Physical Geography" },
  IndianGeography: { bookName: "NCERT Class 11th Indian Geography" },
  Science: { bookName: "Disha IAS Previous Year Papers (Science Section)" },
  Environment: { bookName: "Shankar IAS Environment Book" },
  Economy: { bookName: "Ramesh Singh Indian Economy Book" },
  CSAT: { bookName: "Disha IAS Previous Year Papers (CSAT Section)" },
  CurrentAffairs: { bookName: "Vision IAS Current Affairs Magazine" },
  PreviousYearPapers: { bookName: "Disha Publication’s UPSC Prelims Previous Year Papers" },
  Polity: { bookName: "Laxmikanth Book" }
};

// Endpoint to fetch MCQs for a specified book/category for a user, resetting seen MCQs if necessary
app.post("/user/get-book-mcqs", async (req, res) => {
  try {
    console.log("Request body:", req.body);
    const { userId, book, requestedCount, position } = req.body;

    // Validate request parameters
    if (!userId) {
      console.log("Validation failed: Missing userId");
      return res.status(400).json({ error: "Missing userId in request body" });
    }
    if (!book || !categoryToBookMap[book]) {
      console.log(`Validation failed: Invalid or missing book - ${book}`);
      return res.status(400).json({ error: "Missing or invalid book in request body. Valid books are: " + Object.keys(categoryToBookMap).join(", ") });
    }
    if (requestedCount === undefined || typeof requestedCount !== "number") {
      console.log(`Validation failed: Invalid requestedCount - ${requestedCount}`);
      return res.status(400).json({ error: "Missing or invalid requestedCount in request body" });
    }
    if (requestedCount !== 0 && requestedCount <= 0) {
      console.log(`Validation failed: requestedCount must be positive - ${requestedCount}`);
      return res.status(400).json({ error: "requestedCount must be a positive number or 0 for LAW mode" });
    }
    if (position !== undefined && (typeof position !== "number" || position < 0)) {
      console.log(`Validation failed: Invalid position - ${position}`);
      return res.status(400).json({ error: "Position must be a non-negative number" });
    }

    if (!mongoConnected) {
      return res.status(503).json({ error: "Database not connected" });
    }

    const category = book; // The 'book' parameter directly maps to the category (e.g., "Polity", "Economy")

    // Fetch seen MCQ IDs for the user
    const seenMcqs = await db.collection("user_seen_mcqs")
      .find({ userId })
      .toArray();
    const seenMcqIds = seenMcqs.map(entry => entry.mcqId);

    // Fetch all MCQ IDs for the specified category to determine which ones the user has seen
    const categoryMcqs = await db.collection("mcqs")
      .find({ category })
      .toArray();
    const categoryMcqIds = categoryMcqs.map(mcq => mcq._id.toString());

    // Filter seen MCQs to only include those in the specified category
    const seenCategoryMcqIds = seenMcqIds.filter(id => categoryMcqIds.includes(id));

    // Fetch unseen MCQs for the specified category
    let mcqs;
    if (requestedCount === 0) {
      // LAW mode: Fetch one MCQ at the specified position (or the first unseen MCQ if position is not specified)
      const query = {
        category,
        _id: { $nin: seenCategoryMcqIds.map(id => new ObjectId(id)) }
      };
      const options = {
        sort: { createdAt: -1 }
      };
      if (position !== undefined) {
        // Skip to the specified position among unseen MCQs
        options.skip = position;
        options.limit = 1;
      } else {
        // Fetch the first unseen MCQ
        options.limit = 1;
      }
      mcqs = await db.collection("mcqs")
        .find(query, options)
        .toArray();
      console.log(`LAW mode: Fetched ${mcqs.length} MCQ(s) at position ${position !== undefined ? position : 0} for user ${userId} in category ${category}`);
    } else {
      // WIS mode: Fetch the requested number of MCQs
      mcqs = await db.collection("mcqs")
        .find({
          category,
          _id: { $nin: seenCategoryMcqIds.map(id => new ObjectId(id)) }
        })
        .sort({ createdAt: -1 })
        .toArray();

      if (mcqs.length < requestedCount) {
        console.log(`Not enough unseen MCQs (${mcqs.length}/${requestedCount}) for user ${userId} in category ${category}. Resetting seen MCQs for this category.`);
        await db.collection("user_seen_mcqs").deleteMany({
          userId,
          mcqId: { $in: seenCategoryMcqIds }
        });
        console.log(`Reset ${seenCategoryMcqIds.length} seen MCQs for user ${userId} in category ${category}.`);

        mcqs = await db.collection("mcqs")
          .find({ category })
          .sort({ createdAt: -1 })
          .limit(requestedCount)
          .toArray();
      } else {
        mcqs = mcqs.slice(0, requestedCount);
      }
    }

    if (mcqs.length === 0) {
      return res.status(404).json({ error: `No MCQs available for category ${category}.` });
    }

    console.log(`Fetched ${mcqs.length} MCQs for user ${userId} (requested: ${requestedCount === 0 ? 'one' : requestedCount}) in category ${category}`);
    res.status(200).json({ mcqs });
  } catch (error) {
    console.error("Error fetching user MCQs:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch MCQs", details: error.message });
  }
});

// Endpoint to mark MCQs as seen by a user
app.post("/user/mark-mcqs-seen", async (req, res) => {
  try {
    const { userId, mcqIds } = req.body;
    if (!userId || !mcqIds || !Array.isArray(mcqIds)) {
      return res.status(400).json({ error: "Missing or invalid userId or mcqIds in request body" });
    }

    if (!mongoConnected) {
      return res.status(503).json({ error: "Database not connected" });
    }

    // Prepare documents to insert
    const seenDocs = mcqIds.map(mcqId => ({
      userId,
      mcqId,
      seenAt: new Date()
    }));

    // Insert seen MCQs, ignoring duplicates
    await db.collection("user_seen_mcqs").insertMany(seenDocs, { ordered: false }).catch(err => {
      if (err.code !== 11000) throw err; // Ignore duplicate key errors
    });

    console.log(`Marked ${mcqIds.length} MCQs as seen for user ${userId}`);
    res.status(200).json({ message: "MCQs marked as seen" });
  } catch (error) {
    console.error("Error marking MCQs as seen:", error.message, error.stack);
    res.status(500).json({ error: "Failed to mark MCQs as seen", details: error.message });
  }
});

// Endpoint to report an MCQ
app.post("/user/report-mcq", async (req, res) => {
  try {
    const { userId, mcqId, mcq } = req.body;
    if (!userId || !mcqId || !mcq) {
      return res.status(400).json({ error: "Missing userId, mcqId, or mcq in request body" });
    }

    if (!mongoConnected) {
      return res.status(503).json({ error: "Database not connected" });
    }

    // Save the reported MCQ to the reported_mcqs collection
    const reportDoc = {
      userId,
      mcqId,
      mcq, // Store the full MCQ object for admin review
      reportedAt: new Date()
    };

    await db.collection("reported_mcqs").insertOne(reportDoc);
    console.log(`Reported MCQ ${mcqId} by user ${userId}`);
    res.status(200).json({ message: "MCQ reported successfully" });
  } catch (error) {
    console.error("Error reporting MCQ:", error.message, error.stack);
    if (error.code === 11000) {
      res.status(400).json({ error: "This MCQ has already been reported by this user" });
    } else {
      res.status(500).json({ error: "Failed to report MCQ", details: error.message });
    }
  }
});

// Endpoint for admin to update an MCQ and remove it from reported_mcqs
app.post("/admin/update-mcq", async (req, res) => {
  try {
    const { mcqId, updatedMcq } = req.body;
    if (!mcqId || !updatedMcq) {
      return res.status(400).json({ error: "Missing mcqId or updatedMcq in request body" });
    }

    if (!mongoConnected) {
      return res.status(503).json({ error: "Database not connected" });
    }

    // Update the MCQ in the mcqs collection
    const updateResult = await db.collection("mcqs").updateOne(
      { _id: new ObjectId(mcqId) },
      { $set: { mcq: updatedMcq, chapter: updatedMcq.chapter } }
    );

    if (updateResult.matchedCount === 0) {
      return res.status(404).json({ error: "MCQ not found in mcqs collection" });
    }

    // Remove the MCQ from reported_mcqs
    await db.collection("reported_mcqs").deleteOne({ mcqId });

    console.log(`Updated MCQ ${mcqId} and removed from reported_mcqs`);
    res.status(200).json({ message: "MCQ updated and removed from reported_mcqs successfully" });
  } catch (error) {
    console.error("Error updating MCQ:", error.message, error.stack);
    res.status(500).json({ error: "Failed to update MCQ", details: error.message });
  }
});

// Save user data with normalized email
app.post("/save-user", async (req, res) => {
  try {
    const { email, username } = req.body;
    if (!email || !username) {
      return res.status(400).json({ error: "Missing required fields: email and username" });
    }
    if (!mongoConnected) {
      return res.status(500).json({ error: "Database not connected" });
    }
    const normalizedEmail = email.toLowerCase();
    const userData = {
      email: normalizedEmail,
      username,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await db.collection("users").updateOne(
      { email: normalizedEmail },
      { $set: userData },
      { upsert: true }
    );
    console.log(`Saved/Updated user: ${normalizedEmail}, username: ${username}`);
    res.status(200).json({ message: "User saved successfully" });
  } catch (error) {
    console.error(`Error saving user:`, error.message);
    res.status(error.code === 11000 ? 400 : 500).json({
      error: error.code === 11000 ? "User with this email exists" : "Failed to save user",
      details: error.message
    });
  }
});

// Fetch user info for debugging
app.post("/user/info", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Missing email in request body" });
    }
    if (!mongoConnected) {
      return res.status(503).json({ error: "Database not connected" });
    }
    const normalizedEmail = email.toLowerCase();
    const user = await db.collection("users").findOne(
      { email: normalizedEmail },
      { projection: { email: 1, username: 1, createdAt: 1, updatedAt: 1, _id: 0 } }
    );
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.status(200).json({ user });
  } catch (error) {
    console.error("Error fetching user info:", error.message);
    res.status(500).json({ error: "Failed to fetch user info", details: error.message });
  }
});

// Battleground endpoints
app.post("/battleground/submit", async (req, res) => {
  try {
    const { username, score } = req.body;
    if (!username || typeof score !== "number") {
      throw new Error("Missing or invalid username or score");
    }
    if (!mongoConnected) {
      return res.status(503).json({ error: "Database not connected" });
    }
    const result = await db.collection("battleground_rankings").updateOne(
      { username },
      { $set: { score, date: new Date() } },
      { upsert: true }
    );
    console.log(`Updated/Inserted score for ${username}: score=${score}`);
    const rankings = await db.collection("battleground_rankings")
      .find({}, { projection: { username: 1, score: 1, _id: 0 } })
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
    if (!mongoConnected) {
      return res.status(503).json({ error: "Database not connected" });
    }
    const rankings = await db.collection("battleground_rankings")
      .find({}, { projection: { username: 1, score: 1, _id: 0 } })
      .sort({ score: -1, date: 1 })
      .limit(50)
      .toArray();
    res.json({ rankings });
  } catch (error) {
    console.error("Error in /battleground/leaderboard:", error.message);
    res.status(500).json({ error: "Failed to fetch leaderboard", details: error.message });
  }
});

// Endpoint to fetch current affairs articles
app.get("/admin/get-current-affairs-articles", async (req, res) => {
  try {
    if (!mongoConnected || !db) {
      console.error("MongoDB not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

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

    console.log(`Fetched ${articles.length} articles for date=${date || 'ALL'}, category=${category || 'ALL'}, page=${page}, limit=${limit}`);
    res.status(200).json({
      articles,
      totalArticles,
      currentPage: parseInt(page)
    });
  } catch (error) {
    console.error("Error fetching articles:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch articles", details: error.message });
  }
});

// Start the server
const PORT = process.env.USER_PORT || 5000;
app.listen(PORT, () => {
  console.log(`User server running on port ${PORT}`);
});