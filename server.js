const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");

dotenv.config();
const app = express();

// CORS Configuration
const allowedOrigins = ["https://trainwithme.in", "http://localhost:3000"];
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

// Category to Book Map (simplified)
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

// Endpoint to fetch Laxmikanth MCQs for a user, excluding seen MCQs
app.post("/user/get-laxmikanth-mcqs", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId in request body" });
    }

    if (!mongoConnected) {
      return res.status(503).json({ error: "Database not connected" });
    }

    // Fetch seen MCQ IDs for the user
    const seenMcqs = await db.collection("user_seen_mcqs")
      .find({ userId })
      .toArray();
    const seenMcqIds = seenMcqs.map(entry => entry.mcqId);

    // Fetch MCQs from the mcqs collection for category "Polity", excluding seen MCQs
    const mcqs = await db.collection("mcqs")
      .find({
        category: "Polity",
        _id: { $nin: seenMcqIds.map(id => new ObjectId(id)) }
      })
      .sort({ createdAt: -1 }) // Latest first
      .toArray();

    if (mcqs.length === 0) {
      return res.status(404).json({ error: "No new MCQs available for this user." });
    }

    console.log(`Fetched ${mcqs.length} unseen MCQs for user ${userId}`);
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

// Start the server
const PORT = process.env.USER_PORT || 5000;
app.listen(PORT, () => {
  console.log(`User server running on port ${PORT}`);
});