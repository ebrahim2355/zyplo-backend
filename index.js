const { setServers } = require("node:dns/promises");
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const app = express();
require("dotenv").config();
const jwt = require("jsonwebtoken");
const port = process.env.PORT || 5000;

setServers(["1.1.1.1", "8.8.8.8"]);

app.use(express.json());
app.use(
  cors({
    origin: ["http://localhost:3000", "zyplo-six.vercel.app"],
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
    //added for workspace
    const workspacesCollection = db.collection("workspaces");
    const projectsCollection = db.collection("projects");
    const tasksCollection = db.collection("tasks");
    const notificationsCollection = db.collection("notifications");

    // register api
    const bcrypt = require("bcryptjs");

    // New variables
    const toId = (v) => new ObjectId(String(v));
    const now = () => new Date().toISOString();

    const getUserIdentity = (req) => ({
      id: req.user?.id || req.headers["x-user-id"],
      email: req.user?.email || req.headers["x-user-email"] || "",
      name: req.user?.name || req.headers["x-user-name"] || "User",
    });

    app.post("/auth/register", async (req, res) => {
      try {
        const { name, email, password, role } = req.body;

        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) {
          return res.status(400).json({ message: "User already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await usersCollection.insertOne({
          name,
          email,
          password: hashedPassword,
          role,
          provider: "credentials",
          createdAt: new Date().toISOString(),
        });

        res.json({ message: "User registered successfully" });
      } catch (err) {
        res.status(500).json({ message: "Registration failed" });
      }
    });

    app.post("/auth/oauth", async (req, res) => {
      try {
        const { name, email, provider, providerId, image, role } = req.body;

        let user = await usersCollection.findOne({ email });

        if (!user) {
          const result = await usersCollection.insertOne({
            name,
            email,
            image,
            role,
            provider,
            providerId,
            createdAt: new Date().toISOString(),
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

    app.get("/users", async (req, res) => { });

    app.post("/users", async (req, res) => {
      const users = req.body;
      const result = await usersCollection.insertOne(users);
      res.send(result);
    });

    // GET /dashboard/bootstrap
    app.get("/dashboard/bootstrap", verifyToken, async (req, res) => {
      const me = getUserIdentity(req);
      if (!me.id) return res.status(401).json({ error: "Unauthorized" });

      const workspaceDocs = await workspacesCollection
        .find({ "members.userId": String(me.id) })
        .sort({ createdAt: -1 })
        .toArray();

      const workspaceIds = workspaceDocs.map((w) => w._id);
      const projects = await projectsCollection.find({ workspaceId: { $in: workspaceIds } }).toArray();
      const tasks = await tasksCollection.find({ workspaceId: { $in: workspaceIds } }).sort({ createdAt: -1 }).toArray();
      const notifications = await notificationsCollection
        .find({ userId: String(me.id) })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

      const workspaces = workspaceDocs.map((w) => ({
        id: String(w._id),
        name: w.name,
        slug: w.slug,
        members: w.members || [],
      }));

      res.json({
        currentUser: { id: String(me.id), name: me.name, email: me.email },
        workspaces,
        projects: projects.map((p) => ({
          id: String(p._id),
          workspaceId: String(p.workspaceId),
          name: p.name,
          key: p.key,
          status: p.status || "active",
          createdAt: p.createdAt,
        })),
        tasks: tasks.map((t) => ({
          id: String(t._id),
          workspaceId: String(t.workspaceId),
          projectId: t.projectId ? String(t.projectId) : "",
          projectName: t.projectName || "",
          title: t.title,
          description: t.description || "",
          priority: t.priority || "P2",
          status: t.status || "todo",
          dueDate: t.dueDate || "",
          assigneeId: t.assigneeId || "",
          assigneeName: t.assigneeName || "Unassigned",
          createdAt: t.createdAt,
        })),
        activity: [],
        notifications: notifications.map((n) => ({
          id: String(n._id),
          text: n.text,
          read: !!n.read,
          createdAt: n.createdAt,
        })),
        lastVisited: null,
      });
    });

    // POST /dashboard/workspaces
    app.post("/dashboard/workspaces", verifyToken, async (req, res) => {
      const me = getUserIdentity(req);
      const { name, memberEmails = [] } = req.body || {};
      if (!name?.trim()) return res.status(400).json({ error: "Workspace name is required" });

      const members = [
        { id: String(me.id), userId: String(me.id), name: me.name, email: me.email, role: "Owner" },
      ];

      for (const raw of memberEmails) {
        const email = String(raw || "").trim().toLowerCase();
        if (!email || members.some((m) => m.email.toLowerCase() === email)) continue;
        members.push({
          id: new ObjectId().toString(),
          userId: "",
          name: email.split("@")[0],
          email,
          role: "Member",
        });
      }

      const doc = {
        name: name.trim(),
        slug: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
        members,
        createdBy: String(me.id),
        createdAt: now(),
      };

      const result = await workspacesCollection.insertOne(doc);
      res.status(201).json({
        workspace: { id: String(result.insertedId), name: doc.name, slug: doc.slug, members: doc.members },
      });
    });

    // POST /dashboard/workspaces/:workspaceId/members
    app.post("/dashboard/workspaces/:workspaceId/members", verifyToken, async (req, res) => {
      const { workspaceId } = req.params;
      const { email, role = "Member" } = req.body || {};
      const clean = String(email || "").trim().toLowerCase();
      if (!clean) return res.status(400).json({ error: "Member email is required" });

      const workspace = await workspacesCollection.findOne({ _id: toId(workspaceId) });
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const exists = (workspace.members || []).find((m) => m.email.toLowerCase() === clean);
      if (exists) return res.status(201).json({ member: exists });

      const member = {
        id: new ObjectId().toString(),
        userId: "",
        name: clean.split("@")[0],
        email: clean,
        role,
      };

      await workspacesCollection.updateOne(
        { _id: toId(workspaceId) },
        { $push: { members: member } }
      );

      res.status(201).json({ member });
    });

    // POST /dashboard/projects
    app.post("/dashboard/projects", verifyToken, async (req, res) => {
      const { workspaceId, name, key = "" } = req.body || {};
      if (!workspaceId || !name?.trim()) return res.status(400).json({ error: "workspaceId and project name are required" });

      const workspace = await workspacesCollection.findOne({ _id: toId(workspaceId) });
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      const project = {
        workspaceId: toId(workspaceId),
        name: name.trim(),
        key: String(key || name).toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 6) || "PROJ",
        status: "active",
        createdAt: now(),
      };

      const result = await projectsCollection.insertOne(project);
      res.status(201).json({
        project: {
          id: String(result.insertedId),
          workspaceId: String(project.workspaceId),
          name: project.name,
          key: project.key,
          status: project.status,
          createdAt: project.createdAt,
        },
      });
    });

    // POST /dashboard/tasks
    app.post("/dashboard/tasks", verifyToken, async (req, res) => {
      const { workspaceId, projectId = "", title, description = "", priority = "P2", status = "todo", dueDate = "", assigneeId = "" } = req.body || {};
      if (!workspaceId || !title?.trim()) return res.status(400).json({ error: "workspaceId and title are required" });

      const workspace = await workspacesCollection.findOne({ _id: toId(workspaceId) });
      if (!workspace) return res.status(404).json({ error: "Workspace not found" });

      let projectName = "";
      if (projectId) {
        const project = await projectsCollection.findOne({ _id: toId(projectId), workspaceId: toId(workspaceId) });
        projectName = project?.name || "";
      }

      const assignee = (workspace.members || []).find((m) => m.id === assigneeId) || (workspace.members || [])[0] || null;

      const task = {
        workspaceId: toId(workspaceId),
        projectId: projectId ? toId(projectId) : null,
        projectName,
        title: title.trim(),
        description,
        priority,
        status,
        dueDate,
        assigneeId: assignee?.id || "",
        assigneeName: assignee?.name || "Unassigned",
        createdAt: now(),
      };

      const result = await tasksCollection.insertOne(task);
      res.status(201).json({
        task: {
          id: String(result.insertedId),
          workspaceId,
          projectId: projectId || "",
          projectName,
          title: task.title,
          description: task.description,
          priority: task.priority,
          status: task.status,
          dueDate: task.dueDate,
          assigneeId: task.assigneeId,
          assigneeName: task.assigneeName,
          createdAt: task.createdAt,
        },
      });
    });

    // PATCH /dashboard/tasks/:taskId
    app.patch("/dashboard/tasks/:taskId", verifyToken, async (req, res) => {
      const { taskId } = req.params;
      const patch = req.body || {};

      const $set = {};
      for (const k of ["title", "description", "priority", "status", "dueDate", "assigneeId", "assigneeName", "projectName"]) {
        if (typeof patch[k] === "string") $set[k] = patch[k];
      }
      if (patch.projectId !== undefined) $set.projectId = patch.projectId ? toId(patch.projectId) : null;

      const result = await tasksCollection.findOneAndUpdate(
        { _id: toId(taskId) },
        { $set },
        { returnDocument: "after" }
      );

      if (!result.value) return res.status(404).json({ error: "Task not found" });

      const t = result.value;
      res.json({
        task: {
          id: String(t._id),
          workspaceId: String(t.workspaceId),
          projectId: t.projectId ? String(t.projectId) : "",
          projectName: t.projectName || "",
          title: t.title,
          description: t.description || "",
          priority: t.priority || "P2",
          status: t.status || "todo",
          dueDate: t.dueDate || "",
          assigneeId: t.assigneeId || "",
          assigneeName: t.assigneeName || "Unassigned",
          createdAt: t.createdAt,
        },
      });
    });

    // POST /dashboard/notifications/read-all
    app.post("/dashboard/notifications/read-all", verifyToken, async (req, res) => {
      const me = getUserIdentity(req);
      await notificationsCollection.updateMany({ userId: String(me.id), read: false }, { $set: { read: true } });
      res.json({ ok: true });
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
