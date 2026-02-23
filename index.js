const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");
const app = express();
require("dotenv").config();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.u1z8wkz.mongodb.net/?appName=Cluster0`;
const uri = `mongodb+srv://zyplo:pgoBF0Lp0UPN9LtU@cluster0.u1z8wkz.mongodb.net/`;
console.log(uri);
// const uri = `mongodb://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0-shard-00-00.u1z8wkz.mongodb.net:27017,cluster0-shard-00-01.u1z8wkz.mongodb.net:27017,cluster0-shard-00-02.u1z8wkz.mongodb.net:27017/zyplo?ssl=true&authSource=admin&retryWrites=true&w=majority`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
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
