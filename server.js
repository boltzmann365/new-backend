const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");

dotenv.config();
const app = express();

const allowedOrigins = [
  "https://frontend-nine-jet-66.vercel.app",
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

      try {
        await db.collection("battleground_rankings").dropIndex("username_1");
        console.log("Dropped outdated username_1 index");
      } catch (err) {
        if (err.codeName === "IndexNotFound") {
          console.log("username_1 index not found, no need to drop");
        } else {
          console.error("Error dropping username_1 index:", err.message);
        }
      }

      await db.collection("mcqs").createIndex({ category: 1, createdAt: -1 });
      await db.collection("users").createIndex({ email: 1 }, { unique: true });
      await db.collection("battleground_rankings").createIndex({ username: 1, questionCount: 1 }, { unique: true });
      await db.collection("battleground_rankings").createIndex({ questionCount: 1, score: -1, date: 1 });
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
      await db.collection("userseenmcqs").createIndex(
        { userId: 1, mcqId: 1 },
        { unique: true, background: false }
      );
      await db.collection("userseenarticles").createIndex(
        { userId: 1, articleId: 1 },
        { unique: true, background: false }
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

const categoryToBookMap = {
  TamilnaduHistory: { bookName: "Tamilnadu History Book", category: "TamilnaduHistory" },
  Spectrum: { bookName: "Spectrum Book", category: "Spectrum" },
  ArtAndCulture: { bookName: "Nitin Singhania Art and Culture Book", category: "ArtAndCulture" },
  FundamentalGeography: { bookName: "NCERT Class 11th Fundamentals of Physical Geography", category: "FundamentalGeography" },
  IndianGeography: { bookName: "NCERT Class 11th Indian Geography", category: "IndianGeography" },
  Science: { bookName: "Disha IAS Previous Year Papers (Science Section)", category: "Science" },
  Environment: { bookName: "Shankar IAS Environment Book", category: "Environment" },
  Economy: { bookName: "Ramesh Singh Indian Economy Book", category: "Economy" },
  CSAT: { bookName: "Disha IAS Previous Year Papers (CSAT Section)", category: "CSAT" },
  CurrentAffairs: { bookName: "Vision Ias April Magzine", category: "Current Affairs" },
  PreviousYearPapers: { bookName: "Disha Publication’s UPSC Prelims Previous Year Papers", category: "PreviousYearPapers" },
  Polity: { bookName: "Laxmikanth Indian Polity", category: "Politics" },
  VisionIasMayMagazine: { bookName: "Vision Ias May Magzine", category: "Current Affairs" },

};

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    mongoConnected,
    message: "TrainWithMe Backend API",
    timestamp: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.status(200).json({ status: "OK", message: "TrainWithMe Backend API", mongoConnected });
});
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.get("/favicon.png", (req, res) => res.status(204).end());

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
    if (book) {
      query.bookName = categoryToBookMap[book].bookName;
    } else if (bookName && bookName !== "All") {
      query.bookName = bookName;
    } else if (category && category !== "All") {
      query.category = category;
    }

    const qanda = await db.collection("QandA")
      .aggregate([
        { $match: query },
        { $skip: (parseInt(page) - 1) * parseInt(limit) },
        { $limit: parseInt(limit) },
        { $sample: { size: parseInt(limit) } }
      ])
      .toArray();

    console.log(`Fetched ${qanda.length} QandA pairs for query:`, query);
    res.status(200).json({ qanda });
  } catch (error) {
    console.error("Error fetching QandA:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch QandA", details: error.message });
  }
});

app.post("/user/get-book-mcqs", async (req, res) => {
  try {
    const { book, requestedCount } = req.body;
    console.log(`Fetching MCQs for book: ${book}, requestedCount: ${requestedCount}`);

    if (!book || !categoryToBookMap[book] || !requestedCount) {
      console.log(`Validation failed: Missing or invalid parameters - book: ${book}, requestedCount: ${requestedCount}`);
      return res.status(400).json({ error: "Missing or invalid parameters" });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const query = {
      category: categoryToBookMap[book].category,
      book: categoryToBookMap[book].bookName 
    };

    const totalAvailable = await db.collection("mcqs").countDocuments(query);
    console.log(`Available MCQs for book "${book}" (category: "${categoryToBookMap[book].category}"): ${totalAvailable}`);

    const mcqs = await db.collection("mcqs")
      .aggregate([
        { $match: query },
        { $sample: { size: Math.min(parseInt(requestedCount), 100) } }
      ])
      .toArray();

    console.log(`Fetched ${mcqs.length} MCQs for book: ${book}`);
    if (!mcqs || mcqs.length === 0) {
      console.log(`No MCQs found for category: "${categoryToBookMap[book].category}"`);
      return res.status(404).json({ error: `No MCQs available for category: ${categoryToBookMap[book].category}` });
    }

    res.status(200).json({ mcqs });
  } catch (error) {
    console.error("Error fetching MCQs:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch MCQs", details: error.message });
  }
});

app.get("/admin/get-current-affairs-articles", async (req, res) => {
  try {
    const { startDate, page = 1, limit = 10, userId } = req.query;
    console.log(`Fetching current affairs articles: userId=${userId || 'guest'}, startDate=${startDate}, page=${page}, limit=${limit}`);

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const query = {};
    if (startDate) {
      query.date = { $gte: new Date(startDate).toISOString() };
    }

    const articles = await db.collection("current_affairs_articles")
      .aggregate([
        { $match: query },
        {
          $lookup: {
            from: "userseenarticles",
            let: { articleId: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$articleId", "$$articleId"] },
                      { $eq: ["$userId", userId || "guest"] }
                    ]
                  }
                }
              }
            ],
            as: "seenInfo"
          }
        },
        {
          $addFields: {
            seenCount: {
              $cond: {
                if: { $gt: [{ $size: "$seenInfo" }, 0] },
                then: { $arrayElemAt: ["$seenInfo.seenCount", 0] },
                else: 0
              }
            }
          }
        },
        // ========================================================
        // START: FIX FOR PAGINATION
        // Adding `_id: 1` as a final tie-breaker makes the sort order
        // completely stable, preventing duplicate articles across pages.
        // ========================================================
        { $sort: { seenCount: 1, date: -1, _id: 1 } },
        // ========================================================
        // END: FIX FOR PAGINATION
        // ========================================================
        { $skip: (parseInt(page) - 1) * parseInt(limit) },
        { $limit: parseInt(limit) },
        {
          $project: {
            _id: 1,
            heading: 1,
            content: 1,
            date: 1,
            createdAt: 1,
            imageUrl: 1,
            seenCount: 1
          }
        }
      ])
      .toArray();

    console.log(`Fetched ${articles.length} current affairs articles for userId=${userId || 'guest'}, startDate=${startDate}, page=${page}`);
    res.status(200).json({ articles });
  } catch (error) {
    console.error("Error fetching current affairs articles:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch articles", details: error.message });
  }
});


app.post("/user/mark-article-seen", async (req, res) => {
  try {
    const { userId, articleId } = req.body;
    console.log(`Marking article as seen: userId=${userId}, articleId=${articleId}`);

    if (!userId || typeof userId !== 'string' || !articleId) {
      console.log("Validation failed: Missing or invalid userId or articleId");
      return res.status(400).json({ error: "Missing or invalid userId or articleId" });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const result = await db.collection("userseenarticles").updateOne(
      { userId: userId, articleId: new ObjectId(articleId) },
      {
        $inc: { seenCount: 1 },
        $set: { lastSeen: new Date() },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    console.log(`Article marked as seen: userId=${userId}, articleId=${articleId}, result:`, result);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error marking article as seen:", error.message, error.stack);
    res.status(500).json({ error: "Failed to mark article as seen", details: error.message });
  }
});

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

app.post("/user/get-multi-book-mcqs", async (req, res) => {
  try {
    const { books, userId } = req.body;
    console.log(`Fetching MCQs for books: ${JSON.stringify(books)}, userId: ${userId}`);

    if (!Array.isArray(books) || books.length === 0) {
      console.log("Validation failed: Missing or invalid books array");
      return res.status(400).json({ error: "Missing or invalid books array", diagnostics: [] });
    }
    if (!userId || typeof userId !== 'string') {
      console.log("Validation failed: Missing or invalid userId");
      return res.status(400).json({ error: "Missing or invalid userId", diagnostics: [] });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected", diagnostics: [] });
    }

    const seenMcqs = await db.collection("userseenmcqs")
      .find({ userId })
      .project({ mcqId: 1 })
      .toArray();
    const seenMcqIds = seenMcqs.map(mcq => new ObjectId(mcq.mcqId));
    console.log(`Found ${seenMcqIds.length} seen MCQs for userId: ${userId}`);

    const results = await Promise.all(
      books.map(async ({ book, requestedCount }) => {
        if (!book || !categoryToBookMap[book] || !requestedCount) {
          console.log(`Invalid parameters for book: ${book}, requestedCount: ${requestedCount}`);
          return { book, mcqs: [], totalAvailable: 0, excludedSeen: 0, error: "Invalid book or requestedCount" };
        }
        const category = categoryToBookMap[book].category;

        let query = {
          category,
          _id: { $nin: seenMcqIds }
        };
        let totalAvailable = await db.collection("mcqs").countDocuments({ category });
        let totalUnseen = await db.collection("mcqs").countDocuments(query);
        console.log(`Total available MCQs for category ${category}: ${totalAvailable}, Unseen: ${totalUnseen}`);

        let mcqs = [];
        let error = null;
        let usingSeenMcqs = false;

        if (totalUnseen > 0) {
          mcqs = await db.collection("mcqs")
            .aggregate([
              { $match: query },
              { $sample: { size: Math.min(parseInt(requestedCount) * 10, 100) } },
              { $limit: Math.min(parseInt(requestedCount), totalUnseen) }
            ])
            .toArray();
        }

        if (mcqs.length === 0 && totalUnseen === 0 && totalAvailable > 0) {
          console.log(`No unseen MCQs for ${category}, fetching seen MCQs with lowest seenCount`);
          usingSeenMcqs = true;
          mcqs = await db.collection("mcqs")
            .aggregate([
              { $match: { category } },
              {
                $lookup: {
                  from: "userseenmcqs",
                  let: { mcqId: "$_id" },
                  pipeline: [
                    {
                      $match: {
                        $expr: {
                          $and: [
                            { $eq: ["$mcqId", "$$mcqId"] },
                            { $eq: ["$userId", userId] }
                          ]
                        }
                      }
                    }
                  ],
                  as: "seenInfo"
                }
              },
              {
                $addFields: {
                  seenCount: {
                    $cond: {
                      if: { $gt: [{ $size: "$seenInfo" }, 0] },
                      then: { $arrayElemAt: ["$seenInfo.seenCount", 0] },
                      else: 0
                    }
                  }
                }
              },
              { $sort: { seenCount: 1 } },
              { $sample: { size: Math.min(parseInt(requestedCount) * 10, 100) } },
              { $limit: parseInt(requestedCount) }
            ])
            .toArray();

          if (mcqs.length === 0) {
            error = `No MCQs available for category ${category}, even with seen MCQs`;
          }
        } else if (mcqs.length === 0 && totalAvailable === 0) {
          error = `No MCQs available for category ${category}`;
        }

        return { 
          book, 
          mcqs, 
          totalAvailable, 
          excludedSeen: totalAvailable - totalUnseen, 
          usingSeenMcqs,
          error 
        };
      })
    );

    const allMCQs = results.flatMap(r => r.mcqs);
    const diagnostics = results.map(r => ({
      book: r.book,
      category: categoryToBookMap[r.book]?.category,
      requested: parseInt(r.mcqs?.length || 0),
      available: r.totalAvailable || 0,
      excludedSeen: r.excludedSeen || 0,
      usingSeenMcqs: r.usingSeenMcqs || false,
      error: r.error || null
    }));

    console.log("Fetched MCQs:", allMCQs.length, "Diagnostics:", diagnostics);

    const uniqueMCQs = [];
    const seenIds = new Set();
    for (const mcq of allMCQs) {
      const mcqIdStr = mcq._id.toString();
      if (!seenIds.has(mcqIdStr)) {
        seenIds.add(mcqIdStr);
        uniqueMCQs.push(mcq);
      } else {
        console.warn(`Duplicate MCQ ID filtered out on server: ${mcqIdStr}`);
      }
    }

    res.status(200).json({ mcqs: uniqueMCQs, diagnostics });
  } catch (error) {
    console.error("Error in get-multi-book-mcqs:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch MCQs", details: error.message, diagnostics: [] });
  }
});

app.post("/user/mark-mcq-seen", async (req, res) => {
  try {
    const { userId, mcqId } = req.body;
    console.log(`Marking MCQ as seen: userId=${userId}, mcqId=${mcqId}`);

    if (!userId || typeof userId !== 'string' || !mcqId) {
      console.log("Validation failed: Missing or invalid userId or mcqId");
      return res.status(400).json({ error: "Missing or invalid userId or mcqId" });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const result = await db.collection("userseenmcqs").updateOne(
      { userId: userId, mcqId: new ObjectId(mcqId) },
      {
        $inc: { seenCount: 1 },
        $set: { lastSeen: new Date() },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    console.log(`MCQ marked as seen: userId=${userId}, mcqId=${mcqId}, result:`, result);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error marking MCQ as seen:", error.message, error.stack);
    res.status(500).json({ error: "Failed to mark MCQ as seen", details: error.message });
  }
});

app.post("/save-user", async (req, res) => {
  try {
    const { email, username } = req.body;
    console.log(`Received request to save/update user: email=${email}, username=${username}`);

    if (!email || !username) {
      console.log("Validation failed: Missing email or username");
      return res.status(400).json({ error: "Missing email or username" });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected during user save");
      return res.status(503).json({ error: "Database not connected" });
    }

    const usersCollection = db.collection("users");
    const result = await usersCollection.updateOne(
      { email: email },
      {
        $set: { username: username, updatedAt: new Date() },
        $setOnInsert: { email: email, createdAt: new Date() }
      },
      { upsert: true }
    );

    console.log("User save/update result:", result);

    if (result.upsertedCount > 0) {
      console.log(`Successfully created new user: ${email}`);
      res.status(201).json({ message: "User created successfully", userId: result.upsertedId });
    } else if (result.modifiedCount > 0) {
      console.log(`Successfully updated username for: ${email}`);
      res.status(200).json({ message: "Username updated successfully" });
    } else {
      console.log(`User already up-to-date: ${email}`);
      res.status(200).json({ message: "User data is already up to date" });
    }
  } catch (error) {
    console.error("Error saving user:", error.message, error.stack);
    if (error.code === 11000) {
      return res.status(409).json({ error: "A user with this email already exists." });
    }
    res.status(500).json({ error: "Failed to save user", details: error.message });
  }
});

app.get("/battleground/leaderboard", async (req, res) => {
  try {
    const { questionCount } = req.query;
    console.log(`Fetching leaderboard for questionCount: ${questionCount}`);

    if (!questionCount || ![10, 25, 50, 100].includes(parseInt(questionCount))) {
      console.log(`Validation failed: Invalid or missing questionCount - ${questionCount}`);
      return res.status(400).json({ error: "Invalid or missing questionCount. Valid values are 10, 25, 50, 100." });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const rankings = await db.collection("battleground_rankings")
      .find({ questionCount: parseInt(questionCount) })
      .sort({ score: -1, date: 1 })
      .limit(50)
      .toArray();

    console.log(`Fetched ${rankings.length} leaderboard entries for ${questionCount}-question test`);
    res.status(200).json({ rankings });
  } catch (error) {
    console.error("Error fetching leaderboard:", error.message, error.stack);
    res.status(500).json({ error: "Failed to fetch leaderboard", details: error.message });
  }
});

app.post("/battleground/submit", async (req, res) => {
  try {
    const { username, score, questionCount } = req.body;
    console.log(`Received score submission: username=${username}, score=${score}, questionCount=${questionCount}`);

    if (!username || score === undefined || !questionCount) {
      console.log("Validation failed: Missing username, score, or questionCount");
      return res.status(400).json({ error: "Missing username, score, or questionCount" });
    }

    if (![10, 25, 50, 100].includes(parseInt(questionCount))) {
      console.log(`Validation failed: Invalid questionCount - ${questionCount}`);
      return res.status(400).json({ error: "Invalid questionCount. Valid values are 10, 25, 50, 100." });
    }

    if (!mongoConnected || !db) {
      console.error("Database not connected");
      return res.status(503).json({ error: "Database not connected" });
    }

    const rankingsCollection = db.collection("battleground_rankings");

    const result = await rankingsCollection.updateOne(
      { username, questionCount: parseInt(questionCount) },
      {
        $set: {
          score: parseFloat(score),
          questionCount: parseInt(questionCount),
          date: new Date(),
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    console.log("Score submission result:", result);

    const rankings = await rankingsCollection
      .find({ questionCount: parseInt(questionCount) })
      .sort({ score: -1, date: 1 })
      .limit(50)
      .toArray();

    console.log(`Fetched ${rankings.length} leaderboard entries after submission for ${questionCount}-question test`);

    res.status(200).json({ rankings });
  } catch (error) {
    console.error("Error submitting score:", error.message, error.stack);
    if (error.code === 11000) {
      return res.status(409).json({ 
        error: `Duplicate submission detected for username ${req.body.username} and questionCount ${req.body.questionCount}. Each user can have one score per test type.` 
      });
    }
    res.status(500).json({ error: "Failed to submit score", details: error.message });
  }
});

app.use((err, req, res, next) => {
  console.error(`Unhandled error: ${err.message}, Stack: ${err.stack}`);
  res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes(req.headers.origin) ? req.headers.origin : '*');
  res.status(500).json({
    error: "Internal server error",
    details: err.message || "An unexpected error occurred"
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

module.exports = app;
