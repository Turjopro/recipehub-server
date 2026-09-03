import { auth } from "./auth.js";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";

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

    console.log("Connected to MongoDB successfully!");
  } finally {
    // client stays connected while server runs
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`RecipeHub server running on port ${port}`);
});