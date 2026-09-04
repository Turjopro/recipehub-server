import Stripe from "stripe";
import { auth } from "./auth.js";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({
  origin: ["http://localhost:5173"],
  credentials: true,
}));

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

async function run() {
  try {
    await client.connect();

    const db = client.db("recipeHubDB");
    const usersCollection = db.collection("users");
    const recipesCollection = db.collection("recipes");
    const favoritesCollection = db.collection("favorites");
    const reportsCollection = db.collection("reports");
    const paymentsCollection = db.collection("payments");

    app.get("/", (req, res) => {
      res.send("RecipeHub server is running");
    });

    // ===== PAYMENTS (Stripe) =====

    // Create a checkout session (for recipe purchase or premium membership)
    app.post("/create-checkout-session", async (req, res) => {
      try {
        const { type, recipeId, recipeName, userEmail, userId } = req.body;

        const isPremium = type === "premium";
        const amount = isPremium ? 2000 : 500; // in cents: $20 premium, $5 recipe
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
          success_url: `http://localhost:5173/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `http://localhost:5173/recipe/${recipeId || ""}`,
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

    // Verify payment and record it (called from success page)
    app.get("/verify-payment/:sessionId", async (req, res) => {
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

    // Get purchased recipes for a user
    app.get("/purchased-recipes/:email", async (req, res) => {
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

    // Get all users (admin only)
    app.get("/users", async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.send(users);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch users", error: err.message });
      }
    });

    // Block/Unblock a user
    app.patch("/users/:id/block", async (req, res) => {
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

    // Admin dashboard stats
    app.get("/admin-stats", async (req, res) => {
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

    // Feature/Unfeature a recipe (admin)
    app.patch("/recipes/:id/feature", async (req, res) => {
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

    // Get all reports (admin)
    app.get("/reports", async (req, res) => {
      try {
        const reports = await reportsCollection.find().sort({ createdAt: -1 }).toArray();
        res.send(reports);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch reports", error: err.message });
      }
    });

    // Dismiss a report
    app.patch("/reports/:id/dismiss", async (req, res) => {
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

    // Get all transactions/payments (admin)
    app.get("/payments", async (req, res) => {
      try {
        const payments = await paymentsCollection.find().sort({ paidAt: -1 }).toArray();
        res.send(payments);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch payments", error: err.message });
      }
    });

    // ===== RECIPES =====

    // Get all recipes (with optional category filter + pagination)
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

    // Get featured recipes
    app.get("/recipes/featured", async (req, res) => {
      try {
        const recipes = await recipesCollection.find({ isFeatured: true }).limit(6).toArray();
        res.send(recipes);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch featured recipes", error: err.message });
      }
    });

    // Get popular recipes (most liked)
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

    // Get recipes by a specific user (My Recipes) — must come before /recipes/:id
    app.get("/my-recipes/:email", async (req, res) => {
      try {
        const recipes = await recipesCollection.find({ authorEmail: req.params.email }).toArray();
        res.send(recipes);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch your recipes", error: err.message });
      }
    });

    // Get dashboard stats for a user
    app.get("/user-stats/:email", async (req, res) => {
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

    // Get single recipe by id
    app.get("/recipes/:id", async (req, res) => {
      try {
        const recipe = await recipesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!recipe) return res.status(404).send({ message: "Recipe not found" });
        res.send(recipe);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch recipe", error: err.message });
      }
    });

    // Add a new recipe
    app.post("/recipes", async (req, res) => {
      try {
        const recipe = req.body;
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

    // Update a recipe
    app.patch("/recipes/:id", async (req, res) => {
      try {
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

    // Delete a recipe
    app.delete("/recipes/:id", async (req, res) => {
      try {
        const result = await recipesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.send(result);
      } catch (err) {
        res.status(500).send({ message: "Failed to delete recipe", error: err.message });
      }
    });

    // Like a recipe (increment likesCount)
    app.patch("/recipes/:id/like", async (req, res) => {
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

    // Get user's favorite recipes (with full recipe details)
    app.get("/favorites/:email", async (req, res) => {
      try {
        const favorites = await favoritesCollection.find({ userEmail: req.params.email }).toArray();
        const recipeIds = favorites.map((f) => new ObjectId(f.recipeId));
        const recipes = await recipesCollection.find({ _id: { $in: recipeIds } }).toArray();
        res.send(recipes);
      } catch (err) {
        res.status(500).send({ message: "Failed to fetch favorites", error: err.message });
      }
    });

    // Check if a recipe is favorited by user
    app.get("/favorites/check/:email/:recipeId", async (req, res) => {
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

    // Add to favorites
    app.post("/favorites", async (req, res) => {
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

    // Remove from favorites
    app.delete("/favorites/:email/:recipeId", async (req, res) => {
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

    // Submit a report
    app.post("/reports", async (req, res) => {
      try {
        const { recipeId, reporterEmail, reason } = req.body;
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

    console.log("Connected to MongoDB successfully!");
  } finally {
    // client stays connected while server runs
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`RecipeHub server running on port ${port}`);
});