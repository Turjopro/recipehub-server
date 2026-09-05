import Stripe from "stripe";
import { auth } from "./auth.js";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";

dotenv.config({ override: true });

const app = express();
const port = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";

app.use(
  cors({
    origin: ["http://localhost:5173", "https://recipehub-client-ten.vercel.app"],
    credentials: true,
  })
);

app.all("/api/auth/*splat", toNodeHandler(auth));
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.r6qfvfv.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const VALID_REPORT_REASONS = ["Spam", "Offensive Content", "Copyright Issue"];

async function run() {
  try {
    await client.connect();

    const db = client.db("recipeHubDB");
    const usersCollection = db.collection("users");
    const recipesCollection = db.collection("recipes");
    const favoritesCollection = db.collection("favorites");
    const reportsCollection = db.collection("reports");
    const paymentsCollection = db.collection("payments");

    // ===== AUTH MIDDLEWARE =====

    const verifyToken = async (req, res, next) => {
      try {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
        if (!session?.user) {
          return res.status(401).send({ message: "Unauthorized access" });
        }
        req.user = session.user;
        next();
      } catch (err) {
        res.status(401).send({ message: "Unauthorized access" });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      const user = await usersCollection.findOne({ email: req.user.email });
      if (user?.role !== "admin") {
        return res.status(403).send({ message: "Forbidden: Admin access only" });
      }
      next();
    };

    app.get("/", (req, res) => {
      res.send("RecipeHub server is running");
    });

    // health check endpoint
    app.get("/health", (req, res) => {
      res.status(200).send({ status: "ok", timestamp: new Date() });
    });

    // ===== PAYMENTS (Stripe) =====

    app.post("/create-checkout-session", verifyToken, async (req, res) => {
      try {
        const { type, recipeId, recipeName, userEmail, userId } = req.body;

        const isPremium = type === "premium";
        const amount = isPremium ? 2000 : 500;
        const productName = isPremium ? "RecipeHub Premium Membership" : `Recipe: ${recipeName}`;

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: productName },
                unit_amount: amount,
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          success_url: `${CLIENT_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${CLIENT_URL}/recipe/${recipeId || ""}`,
          metadata: {
            type,
            recipeId: recipeId || "",
            userEmail,
            userId,
          },
        });

        res.send({ url: session.url });
      } catch (err) {
        res.status(500).send({ message: "Failed to create checkout session", error: err.message });
      }
    });

    app.get("/verify-payment/:sessionId", verifyToken, async (req, res) => {
      try {
        const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);

        if (session.payment_status !== "paid") {
          return res.status(400).send({ message: "Payment not completed" });
        }

        const { type, recipeId, userEmail, userId } = session.metadata;

        const existing = await paymentsCollection.findOne({ transactionId: session.id });
        if (existing) {
          return res.send({ message: "Already recorded", payment: existing });
        }

        const payment = {
          userEmail,
          userId,
          amount: session.amount_total / 100,
          recipeId: recipeId || null,
          transactionId: session.id,
          paymentStatus: "paid",
          type,
          paidAt: new Date(),
        };
        await paymentsCollection.insertOne(payment);

        if (type === "premium") {
          await usersCollection.updateOne({ email: userEmail }, { $set: { isPremium: true } });
        }

        res.send({ message: "Payment recorded", payment });
      } catch (err) {
        res.status(500).send({ message: "Failed to verify payment", error: err.message });
      }
    });

    app.get("/purchased-recipes/:email", verifyToken, async (req, res) => {
      try {
        const payments = await paymentsCollection.find({ userEmail: req.params.email, type: "recipe" }).toArray();
        const recipeIds = payments.map((p) => new ObjectId(p.recipeId));
        const recipes = await recipesCollection.find({ _id: { $in: recipeIds } }).toArray();
        res.send(recipes);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch purchased recipes", error: err.message });
      }
    });

    // ===== ADMIN =====

    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.send(users);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch users", error: err.message });
      }
    });

    app.patch("/users/:id/block", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { isBlocked } = req.body;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { isBlocked } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update user", error: err.message });
      }
    });

    // profile update (self only)
    app.patch("/users/:email", verifyToken, async (req, res) => {
      try {
        if (req.user.email !== req.params.email) {
          return res.status(403).send({ message: "Forbidden: You can only update your own profile" });
        }
        const { name, image } = req.body;
        const result = await usersCollection.updateOne(
          { email: req.params.email },
          { $set: { name, image, updatedAt: new Date() } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update profile", error: err.message });
      }
    });

    app.get("/admin-stats", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const totalUsers = await usersCollection.countDocuments();
        const totalRecipes = await recipesCollection.countDocuments();
        const totalPremium = await usersCollection.countDocuments({ isPremium: true });
        const totalReports = await reportsCollection.countDocuments();

        res.send({ totalUsers, totalRecipes, totalPremium, totalReports });
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch admin stats", error: err.message });
      }
    });

    app.patch("/recipes/:id/feature", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const { isFeatured } = req.body;
        const result = await recipesCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { isFeatured } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update recipe", error: err.message });
      }
    });

    app.get("/reports", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const reports = await reportsCollection.find().sort({ createdAt: -1 }).toArray();
        res.send(reports);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch reports", error: err.message });
      }
    });

    app.patch("/reports/:id/dismiss", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await reportsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: "dismissed" } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to dismiss report", error: err.message });
      }
    });

    // remove reported recipe + mark report resolved
    app.patch("/reports/:id/remove-recipe", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const report = await reportsCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!report) return res.status(404).send({ message: "Report not found" });

        await recipesCollection.deleteOne({ _id: new ObjectId(report.recipeId) });
        const result = await reportsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { status: "resolved" } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to remove recipe", error: err.message });
      }
    });

    app.get("/payments", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const payments = await paymentsCollection.find().sort({ paidAt: -1 }).toArray();
        res.send(payments);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch payments", error: err.message });
      }
    });

    // ===== RECIPES =====

    app.get("/recipes", async (req, res) => {
      try {
        const { category, page = 1, limit = 9 } = req.query;
        const query = {};

        if (category) {
          const categories = category.split(",");
          query.category = { $in: categories };
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await recipesCollection.countDocuments(query);
        const recipes = await recipesCollection
          .find(query)
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        res.send({ recipes, total, page: parseInt(page), totalPages: Math.ceil(total / limit) });
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch recipes", error: err.message });
      }
    });

    app.get("/recipes/featured", async (req, res) => {
      try {
        const recipes = await recipesCollection.find({ isFeatured: true }).limit(6).toArray();
        res.send(recipes);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch featured recipes", error: err.message });
      }
    });

    app.get("/recipes/popular", async (req, res) => {
      try {
        const recipes = await recipesCollection
          .find()
          .sort({ likesCount: -1 })
          .limit(6)
          .toArray();
        res.send(recipes);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch popular recipes", error: err.message });
      }
    });

    app.get("/my-recipes/:email", verifyToken, async (req, res) => {
      try {
        const recipes = await recipesCollection.find({ authorEmail: req.params.email }).toArray();
        res.send(recipes);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch your recipes", error: err.message });
      }
    });

    app.get("/user-stats/:email", verifyToken, async (req, res) => {
      try {
        const email = req.params.email;
        const myRecipes = await recipesCollection.find({ authorEmail: email }).toArray();
        const totalRecipes = myRecipes.length;
        const totalLikesReceived = myRecipes.reduce((sum, r) => sum + (r.likesCount || 0), 0);
        const totalFavorites = await favoritesCollection.countDocuments({ userEmail: email });

        const user = await usersCollection.findOne({ email });
        const isPremium = user?.isPremium || false;

        res.send({ totalRecipes, totalFavorites, totalLikesReceived, isPremium });
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch stats", error: err.message });
      }
    });

    app.get("/recipes/:id", async (req, res) => {
      try {
        const recipe = await recipesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).send({ message: "Recipe not found" });
        res.send(recipe);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch recipe", error: err.message });
      }
    });

    // input validation added
    app.post("/recipes", verifyToken, async (req, res) => {
      try {
        const recipe = req.body;

        const requiredFields = [
          "recipeName",
          "category",
          "cuisineType",
          "difficultyLevel",
          "preparationTime",
          "ingredients",
          "instructions",
          "authorEmail",
        ];
        const missingFields = requiredFields.filter((field) => !recipe[field]);
        if (missingFields.length > 0) {
          return res.status(400).send({
            message: `Missing required fields: ${missingFields.join(", ")}`,
          });
        }

        const user = await usersCollection.findOne({ email: recipe.authorEmail });
        const isPremium = user?.isPremium || false;

        if (!isPremium) {
          const existingCount = await recipesCollection.countDocuments({ authorEmail: recipe.authorEmail });
          if (existingCount >= 2) {
            return res.status(403).send({
              message: "Free users can add a maximum of 2 recipes. Upgrade to Premium for unlimited recipes.",
            });
          }
        }

        recipe.likesCount = 0;
        recipe.isFeatured = false;
        recipe.status = "active";
        recipe.createdAt = new Date();
        recipe.updatedAt = new Date();

        const result = await recipesCollection.insertOne(recipe);
        res.status(201).send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to add recipe", error: err.message });
      }
    });

    // owner (or admin) check added
    app.patch("/recipes/:id", verifyToken, async (req, res) => {
      try {
        const recipe = await recipesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).send({ message: "Recipe not found" });

        const user = await usersCollection.findOne({ email: req.user.email });
        if (recipe.authorEmail !== req.user.email && user?.role !== "admin") {
          return res.status(403).send({ message: "Forbidden: You can only edit your own recipe" });
        }

        const updatedData = { ...req.body, updatedAt: new Date() };
        const result = await recipesCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: updatedData }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to update recipe", error: err.message });
      }
    });

    // owner (or admin) check added
    app.delete("/recipes/:id", verifyToken, async (req, res) => {
      try {
        const recipe = await recipesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).send({ message: "Recipe not found" });

        const user = await usersCollection.findOne({ email: req.user.email });
        if (recipe.authorEmail !== req.user.email && user?.role !== "admin") {
          return res.status(403).send({ message: "Forbidden: You can only delete your own recipe" });
        }

        const result = await recipesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to delete recipe", error: err.message });
      }
    });

    app.patch("/recipes/:id/like", verifyToken, async (req, res) => {
      try {
        const result = await recipesCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $inc: { likesCount: 1 } }
        );
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to like recipe", error: err.message });
      }
    });

    // ===== FAVORITES =====

    app.get("/favorites/:email", verifyToken, async (req, res) => {
      try {
        const favorites = await favoritesCollection.find({ userEmail: req.params.email }).toArray();
        const recipeIds = favorites.map((f) => new ObjectId(f.recipeId));
        const recipes = await recipesCollection.find({ _id: { $in: recipeIds } }).toArray();
        res.send(recipes);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch favorites", error: err.message });
      }
    });

    app.get("/favorites/check/:email/:recipeId", verifyToken, async (req, res) => {
      try {
        const fav = await favoritesCollection.findOne({
          userEmail: req.params.email,
          recipeId: req.params.recipeId,
        });
        res.send({ isFavorited: !!fav });
      } catch (err) {
        res.status(500).send({ message: "Failed to check favorite", error: err.message });
      }
    });

    app.post("/favorites", verifyToken, async (req, res) => {
      try {
        const { userEmail, userId, recipeId } = req.body;
        const exists = await favoritesCollection.findOne({ userEmail, recipeId });
        if (exists) return res.status(400).send({ message: "Already in favorites" });

        const result = await favoritesCollection.insertOne({
          userEmail,
          userId,
          recipeId,
          addedAt: new Date(),
        });
        res.status(201).send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to add favorite", error: err.message });
      }
    });

    app.delete("/favorites/:email/:recipeId", verifyToken, async (req, res) => {
      try {
        const result = await favoritesCollection.deleteOne({
          userEmail: req.params.email,
          recipeId: req.params.recipeId,
        });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to remove favorite", error: err.message });
      }
    });

    // ===== REPORTS =====

    // reason validation added
    app.post("/reports", verifyToken, async (req, res) => {
      try {
        const { recipeId, reporterEmail, reason } = req.body;

        if (!VALID_REPORT_REASONS.includes(reason)) {
          return res.status(400).send({ message: "Invalid report reason" });
        }

        const result = await reportsCollection.insertOne({
          recipeId,
          reporterEmail,
          reason,
          status: "pending",
          createdAt: new Date(),
        });
        res.status(201).send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to submit report", error: err.message });
      }
    });

    // 404 handler for unmatched routes (must be after all other routes)
    app.use((req, res) => {
      res.status(404).send({ message: "Route not found" });
    });

    console.log("Connected to MongoDB successfully!");
  } finally {
    // client stays connected while server runs
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`RecipeHub server running on port ${port}`);
});