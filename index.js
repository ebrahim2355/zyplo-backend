const { setServers } = require("node:dns/promises");
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 5000;

setServers(["1.1.1.1", "8.8.8.8"]);

app.use(express.json());
app.use(
  cors({
    origin: ["http://localhost:3000", "https://your-frontend.vercel.app"],
    credentials: true,
  }),
);

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.u1z8wkz.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    const decoded = jwt.verify(token, process.env.NEXTAUTH_SECRET);

    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ message: "Invalid token" });
  }
};

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zyplo-db");
    const usersCollection = db.collection("users");

    // register api
    const bcrypt = require("bcryptjs");

    app.post("/auth/register", async (req, res) => {
      try {
        const { name, email, password } = req.body;

        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) {
          return res.status(400).json({ message: "User already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await usersCollection.insertOne({
          name,
          email,
          password: hashedPassword,
          provider: "credentials",
          createdAt: new Date(),
        });

        res.json({ message: "User registered successfully" });
      } catch (err) {
        res.status(500).json({ message: "Registration failed" });
      }
    });

    app.post("/auth/oauth", async (req, res) => {
      try {
        const { name, email, provider } = req.body;

        let user = await usersCollection.findOne({ email });

        if (!user) {
          const result = await usersCollection.insertOne({
            name,
            email,
            provider,
            createdAt: new Date(),
          });

          user = {
            _id: result.insertedId,
            name,
            email,
          };
        }

        res.json({
          id: user._id,
          name: user.name,
          email: user.email,
        });
      } catch (err) {
        res.status(500).json({ message: "OAuth failed" });
      }
    });

    // login api
    const jwt = require("jsonwebtoken");

    app.post("/auth/login", async (req, res) => {
      try {
        const { email, password } = req.body;

        const user = await usersCollection.findOne({ email });

        if (!user) return res.status(400).json({ message: "User not found" });

        const isValid = await bcrypt.compare(password, user.password);

        if (!isValid)
          return res.status(400).json({ message: "Invalid password" });

        res.json({
          id: user._id,
          name: user.name,
          email: user.email,
        });
      } catch (err) {
        res.status(500).json({ message: "Login failed" });
      }
    });

    // users api

    app.get("/users", async (req, res) => {});

    app.post("/users", async (req, res) => {
      const users = req.body;
      const result = await usersCollection.insertOne(users);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zyplo server is running!");
});

app.listen(port, () => {
  console.log(`Zyplo is listening on port ${port}`);
});
