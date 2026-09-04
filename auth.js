import dotenv from "dotenv";
dotenv.config({ override: true });
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { MongoClient } from "mongodb";
import { createAuthMiddleware, APIError } from "better-auth/api";

const client = new MongoClient(process.env.MONGO_URI);
const db = client.db("recipeHubDB");

export const auth = betterAuth({
  database: mongodbAdapter(db, { usePlural: true }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  // production client URL যোগ করা হয়েছে
  trustedOrigins: [
    "http://localhost:5173",
    "https://recipehub-client-ten.vercel.app",
  ],

  // cross-domain cookie config — নাহলে refresh করলে logged-out হয়ে যায়
  advanced: {
    useSecureCookies: true,
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
      partitioned: true,
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
  },

  // password এ uppercase + lowercase enforce করা হচ্ছে (backend)
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email") {
        const password = ctx.body?.password;
        if (!password || !/[A-Z]/.test(password) || !/[a-z]/.test(password)) {
          throw new APIError("BAD_REQUEST", {
            message:
              "Password must contain at least one uppercase and one lowercase letter.",
          });
        }
      }
    }),
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },
  user: {
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "user",
        input: false,
      },
      isPremium: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
      isBlocked: {
        type: "boolean",
        defaultValue: false,
        input: false,
      },
    },
  },
});