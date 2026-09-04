import { auth } from "./auth.js";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

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