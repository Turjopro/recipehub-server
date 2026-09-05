# 🍳 RecipeHub — Recipe Sharing Platform (Server)

This is the backend API for **RecipeHub**, a recipe sharing platform. It handles authentication, recipe management, favorites, reports, admin operations, and Stripe payments.

🔗 **Live API:** [https://recipehub-server-czq1.onrender.com](https://recipehub-server-czq1.onrender.com)
🔗 **Client Repository:** [github.com/Turjopro/recipehub-client](https://github.com/Turjopro/recipehub-client)
🔗 **Client Live Site:** [https://recipehub-client-ten.vercel.app](https://recipehub-client-ten.vercel.app)

---

## 🛠️ Tech Stack

- **Node.js** + **Express.js**
- **MongoDB** (native driver)
- **Better Auth** — authentication (email/password + Google), JWT sessions via HTTPOnly cookies
- **Stripe** — payments (recipe purchases + premium membership)
- **CORS** — configured for cross-origin client requests

---

## ✨ Key Features

- 🔐 Better Auth integration with email/password + Google login, HTTPOnly cookie sessions, and cross-domain cookie support for production.
- 🛡️ Role-based middleware (`verifyToken`, `verifyAdmin`) protecting all sensitive routes.
- 🍽️ Full CRUD for recipes, with owner-only edit/delete enforcement.
- ⭐ Favorites collection with add/remove/check endpoints.
- 🚩 Recipe reporting system with reason validation and admin resolution (dismiss / remove recipe).
- 💳 Stripe Checkout sessions for recipe purchases and premium membership, with server-side payment verification and transaction logging.
- 📊 Admin stats and user dashboard stats endpoints.
- 🔎 Category filtering (`$in`) and server-side pagination on the recipes list.
- 🔒 Environment-based configuration for MongoDB credentials, Better Auth secrets, and Stripe keys — nothing hardcoded.

---

## 📁 Environment Variables

Create a `.env` file in the root directory with the following:

```env
PORT=5000

# MongoDB
DB_USER=your_mongo_username
DB_PASS=your_mongo_password
MONGO_URI=your_mongo_connection_string

# Better Auth
BETTER_AUTH_SECRET=your_better_auth_secret
BETTER_AUTH_URL=https://your-server-url.onrender.com

# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Stripe
STRIPE_SECRET_KEY=your_stripe_secret_key

# Client
CLIENT_URL=https://your-client-url.vercel.app
```

> ⚠️ Never commit your `.env` file. Make sure it's listed in `.gitignore`.

---

## 🚀 Getting Started (Local Setup)

1. **Clone the repository**
   ```bash
   git clone https://github.com/Turjopro/recipehub-server.git
   cd recipehub-server
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   Create a `.env` file as shown above.

4. **Run the server**
   ```bash
   node index.js
   ```

5. The API will be running at `http://localhost:5000`.

---

## 📂 API Overview

| Category | Endpoints |
|---|---|
| **Auth** | `/api/auth/*` (handled by Better Auth) |
| **Recipes** | `GET /recipes`, `GET /recipes/featured`, `GET /recipes/popular`, `GET /recipes/:id`, `POST /recipes`, `PATCH /recipes/:id`, `DELETE /recipes/:id`, `PATCH /recipes/:id/like` |
| **My Recipes / Stats** | `GET /my-recipes/:email`, `GET /user-stats/:email` |
| **Favorites** | `GET /favorites/:email`, `GET /favorites/check/:email/:recipeId`, `POST /favorites`, `DELETE /favorites/:email/:recipeId` |
| **Reports** | `POST /reports`, `GET /reports` (admin), `PATCH /reports/:id/dismiss` (admin), `PATCH /reports/:id/remove-recipe` (admin) |
| **Payments** | `POST /create-checkout-session`, `GET /verify-payment/:sessionId`, `GET /purchased-recipes/:email`, `GET /payments` (admin) |
| **Users / Profile** | `PATCH /users/:email` (self), `GET /users` (admin), `PATCH /users/:id/block` (admin) |
| **Admin** | `GET /admin-stats`, `PATCH /recipes/:id/feature` |

---

## 🔒 Security Notes

- All protected routes require a valid Better Auth session (HTTPOnly cookie) via the `verifyToken` middleware.
- Admin-only routes are additionally guarded by `verifyAdmin`.
- Recipe edit/delete is restricted to the recipe's original author (or an admin).
- Report reasons are validated against an allowed list (`Spam`, `Offensive Content`, `Copyright Issue`).
- Password complexity (uppercase + lowercase, min 6 characters) is enforced server-side during sign-up.

---

## 👤 Author

**Turjo**
GitHub: [@Turjopro](https://github.com/Turjopro)