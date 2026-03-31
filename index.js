const { setServers } = require("node:dns/promises");
const { Server } = require("socket.io");
const cors = require("cors");
const express = require("express");
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");
const Groq = require("groq-sdk");
const port = process.env.PORT || 5000;
// Clean quoted env values before using them as origins.
const cleanOrigin = (value) =>
  String(value || "")
    .trim()
    .replace(/^["']+|["']+$/g, "");
// Reuse the same frontend origins for HTTP and Socket.IO.
const allowedOrigins = [
  "http://localhost:3000",
  "https://zyplo-six.vercel.app",
  cleanOrigin(process.env.FRONTEND_URL),
].filter(Boolean);
// Keep one socket server instance for the whole app.
let io = null;

setServers(["1.1.1.1", "8.8.8.8"]);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);

// Capture raw body bytes for GitHub webhook signature verification while still
// parsing JSON for the rest of the app.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      const url = String(req.originalUrl || "");
      if (url === "/github/webhook" || url.startsWith("/api/billing/webhook")) {
        req.rawBody = buf; // Buffer
      }
    },
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

// Zod Schema -> Invite Member (Rifat)
const inviteSchema = z.object({
  email: z.email(),
  role: z.enum(["admin", "member"]),
});

// Put all tabs for one user in the same room.
const getUserRoom = (userId) => `user:${String(userId)}`;

// Keep generic task update notifications for non-status fields only.
const getGenericTaskUpdateChanges = (patch, existingTask) => {
  const changed = [];

  if (patch.dueDate !== undefined && patch.dueDate !== existingTask.dueDate)
    changed.push("due date");
  if (patch.title && patch.title !== existingTask.title) changed.push("title");

  return changed;
};

// Attach Socket.IO to the same server used by Express.
const attachSocketServer = (server) => {
  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
  });

  // Verify the socket with the same JWT secret used by HTTP auth.
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      String(socket.handshake.headers?.authorization || "")
        .replace(/^Bearer\s+/i, "")
        .trim();

    if (!token) {
      return next(new Error("Unauthorized"));
    }

    try {
      socket.user = jwt.verify(token, process.env.NEXTAUTH_SECRET);
      next();
    } catch (_error) {
      next(new Error("Unauthorized"));
    }
  });

  // Join every connected tab to the user's room.
  io.on("connection", (socket) => {
    socket.join(getUserRoom(socket.user.id));
  });

  return io;
};

async function run() {
  try {
    // Connect the client to the server (optional starting in v4.7)
    // await client.connect();

    const db = client.db("zyplo-db");
    const usersCollection = db.collection("users");
    //added for workspace
    const workspacesCollection = db.collection("workspaces");
    const projectsCollection = db.collection("projects");
    const boardsCollection = db.collection("boards");
    const tasksCollection = db.collection("tasks");
    const timeLogsCollection = db.collection("timeLogs");
    const notificationsCollection = db.collection("notifications");
    const inviteCollection = db.collection("invites");
    const commentsCollection = db.collection("comments");
    const activitiesCollection = db.collection("activities");
    const githubInstallationsCollection = db.collection("githubInstallations");
    const billingAccountsCollection = db.collection("billingAccounts");
    const billingEventsCollection = db.collection("billingWebhookEvents");
    const subscribersCollection = db.collection("subscribers");

    await notificationsCollection.createIndex({ userId: 1, createdAt: -1 });
    await notificationsCollection.createIndex({ userId: 1, read: 1 });
    await activitiesCollection.createIndex({ userId: 1, createdAt: -1 });
    await activitiesCollection.createIndex({ workspaceId: 1, createdAt: -1 });
    await tasksCollection.createIndex(
      { taskRef: 1 },
      { unique: true, sparse: true },
    );
    await timeLogsCollection.createIndex({ taskId: 1 });
    await timeLogsCollection.createIndex({ userId: 1 });
    await timeLogsCollection.createIndex({ projectId: 1 });
    await timeLogsCollection.createIndex({ workspaceId: 1 });
    await timeLogsCollection.createIndex({ startTime: 1 });
    await billingAccountsCollection.createIndex(
      { ownerType: 1, ownerId: 1 },
      { unique: true },
    );
    await billingAccountsCollection.createIndex(
      { stripeCustomerId: 1 },
      { unique: true, sparse: true },
    );
    await billingAccountsCollection.createIndex(
      { stripeSubscriptionId: 1 },
      { unique: true, sparse: true },
    );
    await billingAccountsCollection.createIndex({ workspaceId: 1 });
    await billingEventsCollection.createIndex({ eventId: 1 }, { unique: true });
    try {
      await timeLogsCollection.createIndex(
        { userId: 1, endTime: 1 },
        {
          unique: true,
          partialFilterExpression: { endTime: null },
        },
      );
    } catch (e) {
      const msg = String(e?.message || "");
      if (!msg.includes("Index already exists with a different name")) {
        console.error("Time log unique index skipped:", e?.message || e);
      }
    }

    // register api
    const bcrypt = require("bcryptjs");

    // New variables
    const toId = (v) => new ObjectId(String(v));
    const now = () => new Date().toISOString();
    const normalizeEmail = (value) =>
      String(value || "")
        .trim()
        .toLowerCase();

    // --Github Integration Start--
    const TASK_REF_PATTERN = /([A-Z]{2,6})-(\d+)/g;

    // For PR titles — returns first match only e.g. "AUTH-1"
    function extractTaskRef(text) {
      if (!text) return null;
      const match = TASK_REF_PATTERN.exec(text);
      TASK_REF_PATTERN.lastIndex = 0;
      if (!match) return null;
      return `${match[1]}-${match[2]}`;
    }

    // For commit messages — one commit can reference multiple tasks
    function extractAllTaskRefs(text) {
      if (!text) return [];
      const refs = [];
      let match;
      while ((match = TASK_REF_PATTERN.exec(text)) !== null) {
        refs.push(`${match[1]}-${match[2]}`);
      }
      TASK_REF_PATTERN.lastIndex = 0;
      return refs;
    }
    // Verify Signature
    function verifyGithubWebhookSignature(req) {
      try {
        const secret = process.env.GITHUB_WEBHOOK_SECRET;
        if (!secret) return true; // skip if no secret configured

        const signature = String(req.headers["x-hub-signature-256"] || "");
        if (!signature.startsWith("sha256=")) return false;

        // IMPORTANT: GitHub signs the raw request bytes, not the parsed JSON.
        // We capture raw bytes via express.json({ verify }) for /github/webhook.
        const raw = Buffer.isBuffer(req.rawBody)
          ? req.rawBody
          : Buffer.from(JSON.stringify(req.body || {}), "utf8");

        const hmac = crypto.createHmac("sha256", secret);
        const digest = "sha256=" + hmac.update(raw).digest("hex");

        const sigBuf = Buffer.from(signature, "utf8");
        const digBuf = Buffer.from(digest, "utf8");
        if (sigBuf.length !== digBuf.length) return false; // avoid timingSafeEqual throw

        return crypto.timingSafeEqual(sigBuf, digBuf);
      } catch (e) {
        return false;
      }
    }
    // get Workspace
    async function getWorkspaceByInstallation(installationId) {
      if (!installationId) return null;
      const installation = await githubInstallationsCollection.findOne({
        installationId: String(installationId),
      });
      if (!installation) return null;
      if (!isValidId(installation.workspaceId)) return null;
      return await workspacesCollection.findOne({
        _id: toId(installation.workspaceId),
      });
    }

    // Move task helper
    async function moveTaskToStatusColumn(task, newStatus) {
      // Find the board for this task — columns are embedded in the board document
      const board = await boardsCollection.findOne({
        projectId: task.projectId,
      });
      if (!board) {
        console.log("[Move] No board found for projectId:", task.projectId);
        return;
      }

      // Columns are stored as board.columns array (embedded)
      const columns = board.columns || [];
      if (!columns.length) {
        console.log("[Move] No columns found in board");
        return;
      }

      function normalizeStr(name) {
        return String(name || "")
          .toLowerCase()
          .replace(/[^a-z]/g, "");
      }

      function statusMatchesColumn(columnName, status) {
        const col = normalizeStr(columnName);
        const s = normalizeStr(status); // strips underscores too: "in_progress" → "inprogress"
        if (s === "todo" && (col === "todo" || col === "backlog")) return true;
        if (s === "inprogress" && (col === "inprogress" || col === "doing"))
          return true;
        if (s === "inreview" && (col === "inreview" || col === "review"))
          return true;
        if (s === "done" && (col === "done" || col === "completed"))
          return true;
        return false;
      }

      const targetColumn = columns.find((col) =>
        statusMatchesColumn(col.name, newStatus),
      );

      if (!targetColumn) {
        console.log(
          "[Move] No matching column for status:",
          newStatus,
          "| columns:",
          columns.map((c) => c.name),
        );
        return;
      }

      // Don't move if already in the right column
      if (String(task.columnId) === String(targetColumn._id)) {
        console.log("[Move] Task already in correct column");
        return;
      }

      console.log(
        "[Move] Moving task",
        task.taskRef,
        "to column:",
        targetColumn.name,
      );

      // Move task to target column
      await tasksCollection.updateOne(
        { _id: task._id },
        { $set: { columnId: targetColumn._id, updatedAt: now() } },
      );
    }

    // PR event handler
    async function handlePullRequestEvent(payload) {
      const {
        action,
        pull_request: pullRequest,
        repository,
        installation,
      } = payload;

      const taskRef = extractTaskRef(pullRequest.title);
      if (!taskRef) return;

      // Find workspace from installation
      const workspace = await getWorkspaceByInstallation(installation?.id);
      if (!workspace) {
        console.log(
          `[GitHub/PR] No workspace found for installation ${installation?.id}`,
        );
        return;
      }

      // Scope task search to this workspace
      const task = await tasksCollection.findOne({
        taskRef: taskRef,
        workspaceId: workspace._id,
      });
      if (!task) return;

      const newStatus =
        action === "opened"
          ? "in_progress"
          : action === "review_requested"
            ? "in_review"
            : action === "closed" && pullRequest.merged
              ? "done"
              : action === "closed" && !pullRequest.merged
                ? "todo"
                : null;

      if (newStatus) {
        await tasksCollection.updateOne(
          { taskRef: taskRef, workspaceId: workspace._id },
          { $set: { status: newStatus, updatedAt: now() } },
        );
        await moveTaskToStatusColumn(task, newStatus);
      }

      try {
        await activitiesCollection.insertOne({
          userId: "",
          workspaceId: String(workspace._id),
          projectId: String(task.projectId || ""),
          taskId: String(task._id),
          action: `github_pr_${action}`,
          text: `PR #${pullRequest.number} "${pullRequest.title}" ${action} by @${pullRequest.user.login}`,
          meta: {
            pullRequestNumber: pullRequest.number,
            pullRequestTitle: pullRequest.title,
            pullRequestUrl: pullRequest.html_url,
            repositoryName: repository.full_name,
            githubUsername: pullRequest.user.login,
            githubAvatarUrl: pullRequest.user.avatar_url,
          },
          createdAt: now(),
        });
      } catch (err) {
        console.error("[GitHub/PR] Activity insert failed:", err.message);
      }

      const assigneeUserId = getMemberUserId(workspace, task.assigneeId);
      if (assigneeUserId) {
        await createNotification({
          userId: assigneeUserId,
          text: `PR #${pullRequest.number} was ${action} by @${pullRequest.user.login}`,
          type: "github_pr",
          data: {
            taskId: String(task._id),
            taskRef,
            pullRequestUrl: pullRequest.html_url,
          },
        });
      }

      console.log(
        `[GitHub/PR] PR #${pullRequest.number} → task ${taskRef} → status: ${newStatus}`,
      );
    }

    // Push event handler
    async function handlePushEvent(payload) {
      const { commits, repository, ref, installation } = payload;
      if (!commits || commits.length === 0) return;

      // Find workspace from installation
      const workspace = await getWorkspaceByInstallation(installation?.id);
      if (!workspace) {
        console.log(
          `[GitHub/Push] No workspace found for installation ${installation?.id}`,
        );
        return;
      }

      const isMainBranch =
        ref === "refs/heads/main" || ref === "refs/heads/master";

      for (const commit of commits) {
        const taskRefs = extractAllTaskRefs(commit.message);
        if (taskRefs.length === 0) continue;

        for (const taskRef of taskRefs) {
          // Scope task search to this workspace
          const task = await tasksCollection.findOne({
            taskRef: taskRef,
            workspaceId: workspace._id,
          });
          if (!task) continue;

          const branch = ref.replace("refs/heads/", "");
          // GitHub push payloads often include API URLs; store a human URL for UI.
          const commitUrl = `https://github.com/${repository.full_name}/commit/${commit.id}`;
          const githubUser =
            commit.author?.username || commit.author?.name || "unknown";

          const newStatus = isMainBranch ? "done" : "in_progress";

          await tasksCollection.updateOne(
            { taskRef: taskRef, workspaceId: workspace._id },
            { $set: { status: newStatus, updatedAt: now() } },
          );
          await moveTaskToStatusColumn(task, newStatus);

          try {
            await activitiesCollection.insertOne({
              userId: "",
              workspaceId: String(workspace._id),
              projectId: String(task.projectId || ""),
              taskId: String(task._id),
              action: "github_commit_pushed",
              text: `Commit pushed to ${isMainBranch ? "main" : branch} by @${githubUser}: "${commit.message}"`,
              meta: {
                commitSha: commit.id,
                commitShort: commit.id.slice(0, 7),
                commitMessage: commit.message,
                commitUrl,
                repositoryName: repository.full_name,
                branch,
                githubUsername: githubUser,
              },
              createdAt: now(),
            });
          } catch (err) {
            console.error("[GitHub/Push] Activity insert failed:", err.message);
          }

          const assigneeUserId = getMemberUserId(workspace, task.assigneeId);
          if (assigneeUserId) {
            await createNotification({
              userId: assigneeUserId,
              text: `Commit pushed to ${branch} for "${task.title}"`,
              type: "github_commit",
              data: { taskId: String(task._id), taskRef, commitUrl },
            });
          }

          console.log(
            `[GitHub/Push] Commit ${commit.id.slice(0, 7)} → task ${taskRef}`,
          );
        }
      }
    }

    // WebHooks Handler
    const githubEventHandlers = {
      pull_request: handlePullRequestEvent,
      push: handlePushEvent,
    };

    // --Github Integration END--

    // post subscriber
    app.post("/subscriber", async (req, res) => {
      const data = req.body;
      const result = await subscribersCollection.insertOne(data);
      res.send(result);
    });

    // Basic Gmail SMTP sender using .env credentials.
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.USER_EMAIL,
        pass: process.env.USER_PASS,
      },
    });

    // Send Invite Function
    const sendInviteEmail = async ({ to, subject, html }) => {
      if (!process.env.USER_EMAIL || !process.env.USER_PASS) {
        throw new Error("Missing USER_EMAIL or USER_PASS");
      }

      return transporter.sendMail({
        from: process.env.USER_EMAIL,
        to,
        subject,
        html,
      });
    };

    const getUserIdentity = (req) => ({
      id: req.user?.id || req.headers["x-user-id"],
      email: req.user?.email || req.headers["x-user-email"] || "",
      name: req.user?.name || req.headers["x-user-name"] || "User",
    });

    const findAuthUserDoc = async (me) => {
      if (me?.id && isValidId(me.id)) {
        const byId = await usersCollection.findOne({ _id: toId(me.id) });
        if (byId) return byId;
      }

      const email = normalizeEmail(me?.email);
      if (!email) return null;

      return usersCollection.findOne({ email });
    };

    const mapUserProfile = (u) => ({
      id: String(u?._id || ""),
      email: u?.email || "",
      name: u?.name || "",
      phone: u?.phone || "",
      roleTitle: u?.roleTitle || "",
      company: u?.company || "",
      location: u?.location || "",
      website: u?.website || "",
      avatarUrl: u?.avatarUrl || "",
      bio: u?.bio || "",
      starredWorkspaceIds: Array.isArray(u?.starredWorkspaceIds)
        ? u.starredWorkspaceIds
        : [],
    });

    const isWorkspaceMember = (workspace, me) => {
      const myEmail = normalizeEmail(me?.email);
      return (workspace?.members || []).some(
        (m) =>
          String(m.userId || "") === String(me?.id || "") ||
          (myEmail && normalizeEmail(m.email) === myEmail),
      );
    };
    const isWorkspaceAdmin = (workspace, me) => {
      const myId = String(me?.id || "");
      const myEmail = normalizeEmail(me?.email);
      return (workspace?.members || []).some((m) => {
        const role = String(m.role || "").toLowerCase();
        const byId = myId && String(m.userId || "") === myId;
        const byEmail = myEmail && normalizeEmail(m.email) === myEmail;
        return (byId || byEmail) && role === "admin";
      });
    };

    const isValidId = (v) => ObjectId.isValid(String(v || ""));
    const statusFromColumnName = (name) =>
      String(name || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

    const createNotification = async ({
      userId,
      text,
      type = "info",
      data = {},
    }) => {
      if (!userId || !text) return;
      try {
        const result = await notificationsCollection.updateOne(
          {
            userId: String(userId),
            text: String(text),
            read: false,
          },
          {
            $setOnInsert: {
              userId: String(userId),
              text: String(text),
              type,
              data,
              read: false,
              createdAt: now(),
            },
          },
          { upsert: true },
        );

        // Push only new notifications to every open tab for that user.
        if (result.upsertedId && io) {
          const notification = await notificationsCollection.findOne({
            _id: result.upsertedId,
          });

          if (notification) {
            io.to(getUserRoom(String(userId))).emit("notification:new", {
              id: String(notification._id),
              userId: String(notification.userId),
              text: notification.text,
              type: notification.type,
              data: notification.data,
              read: notification.read,
              createdAt: notification.createdAt,
            });
          }
        }
      } catch (e) {
        console.error("Notification insert failed:", e?.message || e);
      }
    };

    const createActivity = async ({
      userId = "",
      workspaceId = "",
      projectId = "",
      taskId = "",
      action = "",
      text = "",
      meta = {},
    }) => {
      try {
        await activitiesCollection.insertOne({
          userId: String(userId || ""),
          workspaceId: String(workspaceId || ""),
          projectId: String(projectId || ""),
          taskId: String(taskId || ""),
          action,
          text,
          meta,
          createdAt: now(),
        });
      } catch (e) {
        console.error("Activity insert failed:", e?.message || e);
      }
    };

    const getWorkspaceMemberById = (workspace, memberId) =>
      (workspace?.members || []).find(
        (m) => String(m.id || m.userId || "") === String(memberId),
      );

    const isLastWorkspaceAdmin = (workspace, member, nextRole) => {
      if (String(member?.role || "").toLowerCase() !== "admin") return false;
      if (nextRole && String(nextRole).toLowerCase() === "admin") return false;

      return (
        (workspace?.members || []).filter(
          (m) => String(m.role || "").toLowerCase() === "admin",
        ).length === 1
      );
    };

    const getMemberUserId = (workspace, memberId) => {
      const member = getWorkspaceMemberById(workspace, memberId);
      return String(member?.userId || "");
    };

    const mapTaskReporter = (task) => ({
      reporterId: String(task?.reporterId || ""),
      reporterName: String(task?.reporterName || ""),
      reporterEmail: String(task?.reporterEmail || ""),
    });

    // ---- Status notification helpers ----
    const normalizeStatusKey = (value) =>
      String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

    const statusLabel = (value) => {
      const key = normalizeStatusKey(value);
      if (key === "todo") return "To Do";
      if (key === "inprogress") return "In Progress";
      if (key === "inreview") return "In Review";
      if (key === "done") return "Done";
      return String(value || "Unknown");
    };

    const getStatusRecipients = ({ workspace, task, actorUserId }) => {
      const assignerUserId = String(task?.assignedByUserId || "");
      const assigneeUserId = getMemberUserId(workspace, task?.assigneeId || "");

      const recipients = new Set(
        [assignerUserId, assigneeUserId].filter(Boolean),
      );

      recipients.delete(String(actorUserId || ""));
      return [...recipients];
    };

    const checkoutSessionSchema = z
      .object({
        planId: z.enum(["starter", "team", "studio"]),
        billingCycle: z.enum(["monthly", "yearly"]),
      })
      .strict();
    const billingRequestSchema = z.object({}).strict();

    const BILLING_ALLOWED_ACCESS_STATUSES = new Set(["active", "trialing"]);
    const BILLING_TERMINAL_STATUSES = new Set([
      "canceled",
      "incomplete_expired",
    ]);

    let stripeClient = null;

    const cleanEnvValue = (value) =>
      String(value || "")
        .trim()
        .replace(/^['"]+|['"]+$/g, "");

    const createBillingHttpError = (status, code, message, details) => {
      const error = new Error(message);
      error.status = status;
      error.code = code;
      if (details !== undefined) error.details = details;
      return error;
    };

    const sendBillingError = (res, error, fallbackMessage) => {
      const status = Number(error?.status || 500);
      const message =
        error?.message ||
        fallbackMessage ||
        "The billing request could not be completed";
      const payload = {
        error: message,
        code: error?.code || "BILLING_ERROR",
      };
      if (error?.details !== undefined) {
        payload.details = error.details;
      }
      return res.status(status).json(payload);
    };

    const pickDefined = (value) =>
      Object.fromEntries(
        Object.entries(value || {}).filter(([, entry]) => entry !== undefined),
      );

    const getStripeId = (value) => {
      if (!value) return "";
      if (typeof value === "string") return value;
      if (typeof value?.id === "string") return value.id;
      return "";
    };

    const toIsoFromUnix = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric <= 0) return null;
      return new Date(numeric * 1000).toISOString();
    };

    const getAppBaseUrl = () =>
      cleanEnvValue(process.env.APP_URL || process.env.FRONTEND_URL) ||
      "http://localhost:3000";

    const buildAppUrl = (pathname, params = {}) => {
      const url = new URL(pathname, getAppBaseUrl());
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || String(value) === "") {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
      return url.toString();
    };

    const buildCheckoutSuccessUrl = () => {
      const placeholder = "{CHECKOUT_SESSION_ID}";
      return buildAppUrl("/pricing", {
        checkout: "success",
        session_id: placeholder,
      }).replace(encodeURIComponent(placeholder), placeholder);
    };

    const buildBillingReturnUrl = () => buildAppUrl("/pricing");

    const getStripeClient = () => {
      const secretKey = cleanEnvValue(process.env.STRIPE_SECRET_KEY);
      if (!secretKey) {
        throw createBillingHttpError(
          500,
          "STRIPE_NOT_CONFIGURED",
          "Stripe is not configured on the server",
        );
      }

      if (!stripeClient) {
        stripeClient = new Stripe(secretKey);
      }

      return stripeClient;
    };

    const getStripePriceMap = () => ({
      starter: {
        monthly: cleanEnvValue(process.env.STRIPE_PRICE_STARTER_MONTHLY),
        yearly: cleanEnvValue(process.env.STRIPE_PRICE_STARTER_YEARLY),
      },
      team: {
        monthly: cleanEnvValue(process.env.STRIPE_PRICE_TEAM_MONTHLY),
        yearly: cleanEnvValue(process.env.STRIPE_PRICE_TEAM_YEARLY),
      },
    });

    const getStripePriceId = (planId, billingCycle) => {
      const planPricing = getStripePriceMap()?.[planId];
      const priceId = planPricing?.[billingCycle];
      if (!priceId) {
        throw createBillingHttpError(
          500,
          "PRICE_NOT_CONFIGURED",
          `Stripe price is not configured for ${planId} ${billingCycle}`,
        );
      }
      return priceId;
    };

    const getPlanByPriceId = (priceId) => {
      if (!priceId) return null;
      const priceMap = getStripePriceMap();

      for (const [planId, cycles] of Object.entries(priceMap)) {
        for (const [billingCycle, configuredPriceId] of Object.entries(
          cycles,
        )) {
          if (configuredPriceId && configuredPriceId === priceId) {
            return { planId, billingCycle };
          }
        }
      }

      return null;
    };

    const getBillingActor = async (req) => {
      const identity = getUserIdentity(req);
      const userDoc = await findAuthUserDoc(identity);
      return {
        id: String(userDoc?._id || identity.id || ""),
        email: normalizeEmail(userDoc?.email || identity.email || ""),
        name: userDoc?.name || identity.name || "User",
      };
    };

    const getBillingOwnerType = (value, fallback = "workspace") => {
      const ownerType = String(value || "")
        .trim()
        .toLowerCase();
      return ownerType || fallback;
    };

    const getBillingOwnerFromUser = (me) => {
      const userId = String(me?.id || "").trim();
      if (!userId) {
        throw createBillingHttpError(
          401,
          "UNAUTHORIZED",
          "Unable to resolve the authenticated user",
        );
      }

      return {
        type: "user",
        id: userId,
        billingContactUserId: userId,
        billingContactName: String(me?.name || "User").trim() || "User",
        email: normalizeEmail(me?.email),
      };
    };

    const getBillingOwnerFromDoc = (billingDoc) => {
      if (!billingDoc) return null;
      const ownerType = getBillingOwnerType(
        billingDoc.ownerType,
        billingDoc.workspaceId ? "workspace" : "user",
      );
      const ownerId = String(
        billingDoc.ownerId ||
          (ownerType === "user"
            ? billingDoc.billingContactUserId
            : billingDoc.workspaceId) ||
          billingDoc.workspaceId ||
          "",
      ).trim();
      if (!ownerId) return null;

      return {
        type: ownerType,
        id: ownerId,
        workspaceId:
          ownerType === "workspace"
            ? String(billingDoc.workspaceId || ownerId).trim()
            : "",
        workspaceName:
          ownerType === "workspace"
            ? String(billingDoc.workspaceName || "").trim()
            : "",
        billingContactUserId: String(
          billingDoc.billingContactUserId ||
            (ownerType === "user" ? ownerId : ""),
        ).trim(),
        billingContactName: String(
          billingDoc.billingContactName || "User",
        ).trim(),
        email: normalizeEmail(billingDoc.billingEmail || ""),
      };
    };

    const getBillingOwnerFromMetadata = (metadata = {}) => {
      const workspaceId = String(
        metadata.workspaceId || metadata.workspace_id || "",
      ).trim();
      const ownerType = getBillingOwnerType(
        metadata.ownerType || metadata.owner_type,
        workspaceId ? "workspace" : "user",
      );
      const ownerId = String(
        metadata.ownerId ||
          metadata.owner_id ||
          (ownerType === "user"
            ? metadata.billingContactUserId || metadata.billing_contact_user_id
            : workspaceId) ||
          workspaceId ||
          "",
      ).trim();

      if (!ownerId) return null;

      return {
        type: ownerType,
        id: ownerId,
        workspaceId: ownerType === "workspace" ? workspaceId || ownerId : "",
        workspaceName: String(
          metadata.workspaceName || metadata.workspace_name || "",
        ).trim(),
        billingContactUserId: String(
          metadata.billingContactUserId ||
            metadata.billing_contact_user_id ||
            (ownerType === "user" ? ownerId : "") ||
            "",
        ).trim(),
        billingContactName: String(
          metadata.billingContactName ||
            metadata.billing_contact_name ||
            "User",
        ).trim(),
        email: normalizeEmail(
          metadata.billingEmail || metadata.billing_email || "",
        ),
      };
    };

    const buildBillingOwnerMetadata = (owner) =>
      pickDefined({
        ownerType: owner.type,
        ownerId: owner.id,
        workspaceId:
          owner.type === "workspace"
            ? owner.workspaceId || undefined
            : undefined,
        workspaceName:
          owner.type === "workspace"
            ? owner.workspaceName || undefined
            : undefined,
        billingContactUserId:
          owner.billingContactUserId ||
          (owner.type === "user" ? owner.id : undefined),
        billingContactName: owner.billingContactName || undefined,
        billingEmail: owner.email || undefined,
      });

    const getBillingAccountByOwner = async (owner) =>
      billingAccountsCollection.findOne({
        ownerType: owner.type,
        ownerId: owner.id,
      });

    const upsertBillingAccount = async (owner, updates = {}) => {
      const timestamp = now();
      await billingAccountsCollection.updateOne(
        {
          ownerType: owner.type,
          ownerId: owner.id,
        },
        {
          $setOnInsert: {
            ownerType: owner.type,
            ownerId: owner.id,
            createdAt: timestamp,
          },
          $set: pickDefined({
            workspaceId: owner.workspaceId || undefined,
            workspaceName: owner.workspaceName || undefined,
            billingContactUserId: owner.billingContactUserId || undefined,
            billingContactName: owner.billingContactName || undefined,
            billingEmail: owner.email || undefined,
            updatedAt: timestamp,
            ...updates,
          }),
        },
        { upsert: true },
      );

      return getBillingAccountByOwner(owner);
    };

    const isSubscriptionAccessAllowed = (status) =>
      BILLING_ALLOWED_ACCESS_STATUSES.has(String(status || "").toLowerCase());

    const normalizeAccessState = (status) =>
      isSubscriptionAccessAllowed(status) ? "allowed" : "restricted";

    const mapSubscriptionResponse = ({ owner, billingDoc }) => {
      const status = String(billingDoc?.status || "inactive");
      return {
        owner: {
          type: owner.type,
          id: owner.id,
          billingContactUserId:
            owner.billingContactUserId ||
            (owner.type === "user" ? owner.id : ""),
          billingContactName: owner.billingContactName || "User",
          billingEmail: owner.email || billingDoc?.billingEmail || "",
        },
        subscription: {
          planId: billingDoc?.planId || null,
          billingCycle: billingDoc?.billingCycle || null,
          status,
          access: normalizeAccessState(status),
          hasAccess: isSubscriptionAccessAllowed(status),
          cancelAtPeriodEnd: !!billingDoc?.cancelAtPeriodEnd,
          currentPeriodStart: billingDoc?.currentPeriodStart || null,
          currentPeriodEnd: billingDoc?.currentPeriodEnd || null,
          portalAvailable: !!billingDoc?.stripeCustomerId,
          stripeManaged: !!billingDoc?.stripeCustomerId,
          lastInvoiceId: billingDoc?.lastInvoiceId || null,
          updatedAt: billingDoc?.updatedAt || null,
        },
      };
    };

    const ensureCheckoutAllowed = (billingDoc, owner) => {
      if (!billingDoc?.stripeSubscriptionId) return;

      const existingStatus = String(billingDoc.status || "").toLowerCase();
      if (BILLING_TERMINAL_STATUSES.has(existingStatus)) return;

      throw createBillingHttpError(
        409,
        "SUBSCRIPTION_EXISTS",
        "This account already has a Stripe subscription. Use the billing portal to manage it instead.",
        mapSubscriptionResponse({ owner, billingDoc }).subscription,
      );
    };

    const ensureStripeCustomer = async ({ owner }) => {
      const stripe = getStripeClient();
      const existingBilling = await getBillingAccountByOwner(owner);

      if (existingBilling?.stripeCustomerId) {
        try {
          const existingCustomer = await stripe.customers.retrieve(
            existingBilling.stripeCustomerId,
          );
          if (existingCustomer && !existingCustomer.deleted) {
            return existingCustomer;
          }
        } catch (error) {
          console.error(
            "[Billing] Failed to retrieve existing Stripe customer:",
            error?.message || error,
          );
        }
      }

      if (owner.email) {
        const matches = await stripe.customers.list({
          email: owner.email,
          limit: 20,
        });
        const matchedCustomer = matches.data.find(
          (customer) =>
            !customer.deleted &&
            String(customer.metadata?.ownerType || "") === owner.type &&
            String(customer.metadata?.ownerId || "") === owner.id,
        );

        if (matchedCustomer) {
          await upsertBillingAccount(owner, {
            stripeCustomerId: matchedCustomer.id,
          });
          return matchedCustomer;
        }
      }

      const customer = await stripe.customers.create(
        pickDefined({
          email: owner.email || undefined,
          name: owner.billingContactName || owner.workspaceName || undefined,
          metadata: buildBillingOwnerMetadata(owner),
        }),
      );

      await upsertBillingAccount(owner, {
        stripeCustomerId: customer.id,
      });

      return customer;
    };

    const buildCheckoutMetadata = ({ owner, planId, billingCycle }) =>
      pickDefined({
        ...buildBillingOwnerMetadata(owner),
        planId,
        billingCycle,
      });

    const getBillingAccountForStripeObject = async ({
      owner,
      stripeCustomerId,
      stripeSubscriptionId,
    }) => {
      if (owner?.id) {
        const byOwner = await getBillingAccountByOwner(owner);
        if (byOwner) return byOwner;
      }

      if (stripeSubscriptionId) {
        const bySubscription = await billingAccountsCollection.findOne({
          stripeSubscriptionId,
        });
        if (bySubscription) return bySubscription;
      }

      if (stripeCustomerId) {
        return billingAccountsCollection.findOne({ stripeCustomerId });
      }

      return null;
    };

    const getSubscriptionSnapshot = (subscription) => {
      const priceId = String(
        subscription?.items?.data?.[0]?.price?.id || "",
      ).trim();
      const mappedPlan = getPlanByPriceId(priceId);
      const metadataPlanId = String(
        subscription?.metadata?.planId || "",
      ).trim();
      const metadataBillingCycle = String(
        subscription?.metadata?.billingCycle || "",
      ).trim();

      return pickDefined({
        stripeCustomerId: getStripeId(subscription?.customer) || undefined,
        stripeSubscriptionId: getStripeId(subscription) || undefined,
        stripePriceId: priceId || undefined,
        planId: mappedPlan?.planId || metadataPlanId || undefined,
        billingCycle:
          mappedPlan?.billingCycle || metadataBillingCycle || undefined,
        status: String(subscription?.status || "").trim() || undefined,
        currentPeriodStart: toIsoFromUnix(subscription?.current_period_start),
        currentPeriodEnd: toIsoFromUnix(subscription?.current_period_end),
        cancelAtPeriodEnd: !!subscription?.cancel_at_period_end,
        lastInvoiceId: getStripeId(subscription?.latest_invoice) || undefined,
      });
    };

    const syncCheckoutSessionToBilling = async (session, event) => {
      if (String(session?.mode || "") !== "subscription") return false;

      const ownerFromMetadata = getBillingOwnerFromMetadata(session?.metadata);
      const billingDoc = await getBillingAccountForStripeObject({
        owner: ownerFromMetadata,
        stripeCustomerId: getStripeId(session?.customer),
        stripeSubscriptionId: getStripeId(session?.subscription),
      });
      const owner = ownerFromMetadata || getBillingOwnerFromDoc(billingDoc);

      if (!owner?.id) {
        console.warn(
          `[Billing] Unable to map checkout session ${session?.id} to a billing owner`,
        );
        return false;
      }

      await upsertBillingAccount(
        {
          ...owner,
          email:
            owner.email ||
            normalizeEmail(
              session?.customer_details?.email || billingDoc?.billingEmail,
            ),
        },
        pickDefined({
          stripeCustomerId: getStripeId(session?.customer) || undefined,
          stripeSubscriptionId: getStripeId(session?.subscription) || undefined,
          planId: String(session?.metadata?.planId || "").trim() || undefined,
          billingCycle:
            String(session?.metadata?.billingCycle || "").trim() || undefined,
          lastCheckoutSessionId: String(session?.id || "").trim() || undefined,
          checkoutCompletedAt: toIsoFromUnix(session?.created),
          lastEventId: event.id,
          lastEventType: event.type,
          lastWebhookAt: now(),
        }),
      );

      return true;
    };

    const syncSubscriptionToBilling = async (subscription, event) => {
      const ownerFromMetadata = getBillingOwnerFromMetadata(
        subscription?.metadata,
      );
      const billingDoc = await getBillingAccountForStripeObject({
        owner: ownerFromMetadata,
        stripeCustomerId: getStripeId(subscription?.customer),
        stripeSubscriptionId: getStripeId(subscription),
      });
      const owner = ownerFromMetadata || getBillingOwnerFromDoc(billingDoc);

      if (!owner?.id) {
        console.warn(
          `[Billing] Unable to map subscription ${subscription?.id} to a billing owner`,
        );
        return false;
      }

      await upsertBillingAccount(owner, {
        ...getSubscriptionSnapshot(subscription),
        lastEventId: event.id,
        lastEventType: event.type,
        lastWebhookAt: now(),
      });

      return true;
    };

    const syncInvoiceToBilling = async (invoice, event) => {
      const billingDoc = await getBillingAccountForStripeObject({
        stripeCustomerId: getStripeId(invoice?.customer),
        stripeSubscriptionId: getStripeId(invoice?.subscription),
      });
      const owner = getBillingOwnerFromDoc(billingDoc);

      if (!owner?.id) {
        console.warn(
          `[Billing] Unable to map invoice ${invoice?.id} to a billing owner`,
        );
        return false;
      }

      const isPaidEvent = event.type === "invoice.paid";
      const existingStatus = String(billingDoc?.status || "").toLowerCase();
      const nextStatus = isPaidEvent
        ? isSubscriptionAccessAllowed(existingStatus)
          ? undefined
          : "active"
        : BILLING_TERMINAL_STATUSES.has(existingStatus)
          ? undefined
          : "past_due";

      await upsertBillingAccount(owner, {
        stripeCustomerId: getStripeId(invoice?.customer) || undefined,
        stripeSubscriptionId: getStripeId(invoice?.subscription) || undefined,
        lastInvoiceId: String(invoice?.id || "").trim() || undefined,
        lastInvoiceStatus: isPaidEvent ? "paid" : "payment_failed",
        status: nextStatus,
        lastEventId: event.id,
        lastEventType: event.type,
        lastWebhookAt: now(),
      });

      return true;
    };

    const registerWebhookEvent = async (event) => {
      try {
        await billingEventsCollection.insertOne({
          eventId: event.id,
          type: event.type,
          receivedAt: now(),
          createdAt: toIsoFromUnix(event.created) || now(),
        });
        return { alreadyProcessed: false };
      } catch (error) {
        if (error?.code === 11000) {
          const existing = await billingEventsCollection.findOne({
            eventId: event.id,
          });
          return { alreadyProcessed: !!existing?.processedAt };
        }
        throw error;
      }
    };

    const markWebhookEventProcessed = async (event, handled) => {
      await billingEventsCollection.updateOne(
        { eventId: event.id },
        {
          $set: {
            processedAt: now(),
            handled: !!handled,
            processingError: null,
          },
        },
      );
    };

    const markWebhookEventFailed = async (event, error) => {
      await billingEventsCollection.updateOne(
        { eventId: event.id },
        {
          $set: {
            processingError: String(error?.message || error),
            lastFailedAt: now(),
          },
        },
      );
    };

    // billing api
    app.get("/api/billing/subscription", verifyToken, async (req, res) => {
      try {
        const parsedQuery = billingRequestSchema.safeParse(req.query || {});
        if (!parsedQuery.success) {
          throw createBillingHttpError(
            400,
            "INVALID_QUERY",
            "Invalid billing query",
            parsedQuery.error.issues,
          );
        }

        const me = await getBillingActor(req);
        const owner = getBillingOwnerFromUser(me);
        const billingDoc = await getBillingAccountByOwner(owner);

        return res.json(mapSubscriptionResponse({ owner, billingDoc }));
      } catch (error) {
        if (error?.status) {
          return sendBillingError(res, error);
        }

        console.error("[Billing] Failed to load subscription:", error);
        return sendBillingError(
          res,
          createBillingHttpError(
            500,
            "SUBSCRIPTION_FETCH_FAILED",
            "Failed to fetch subscription status",
          ),
        );
      }
    });

    app.post("/api/billing/checkout-session", verifyToken, async (req, res) => {
      try {
        const parsedBody = checkoutSessionSchema.safeParse(req.body || {});
        if (!parsedBody.success) {
          throw createBillingHttpError(
            400,
            "INVALID_BILLING_REQUEST",
            "Invalid checkout request payload",
            parsedBody.error.issues,
          );
        }

        const { planId, billingCycle } = parsedBody.data;
        if (planId === "studio") {
          throw createBillingHttpError(
            400,
            "PLAN_NOT_SELF_SERVE",
            "The studio plan must be handled through contact sales",
          );
        }

        const me = await getBillingActor(req);
        const owner = getBillingOwnerFromUser(me);
        const existingBilling = await getBillingAccountByOwner(owner);
        ensureCheckoutAllowed(existingBilling, owner);

        const priceId = getStripePriceId(planId, billingCycle);
        const customer = await ensureStripeCustomer({ owner });
        const metadata = buildCheckoutMetadata({
          owner,
          planId,
          billingCycle,
        });

        const stripe = getStripeClient();
        const session = await stripe.checkout.sessions.create({
          mode: "subscription",
          customer: customer?.id || undefined,
          customer_email: customer?.id ? undefined : owner.email || undefined,
          client_reference_id: owner.id,
          success_url: buildCheckoutSuccessUrl(),
          cancel_url: buildAppUrl("/pricing", {
            checkout: "cancelled",
          }),
          metadata,
          subscription_data: {
            metadata,
          },
          line_items: [
            {
              price: priceId,
              quantity: 1,
            },
          ],
          allow_promotion_codes: true,
        });

        await upsertBillingAccount(owner, {
          stripeCustomerId: customer?.id || undefined,
          stripePriceId: priceId,
          planId,
          billingCycle,
          lastCheckoutSessionId: session.id,
        });

        return res.json({ url: session.url });
      } catch (error) {
        if (error?.status) {
          return sendBillingError(res, error);
        }

        console.error("[Billing] Failed to create checkout session:", error);
        return sendBillingError(
          res,
          createBillingHttpError(
            500,
            "CHECKOUT_SESSION_FAILED",
            "Failed to create Stripe Checkout session",
          ),
        );
      }
    });

    app.post("/api/billing/portal-session", verifyToken, async (req, res) => {
      try {
        const parsedBody = billingRequestSchema.safeParse(req.body || {});
        if (!parsedBody.success) {
          throw createBillingHttpError(
            400,
            "INVALID_BILLING_REQUEST",
            "Invalid billing portal request payload",
            parsedBody.error.issues,
          );
        }

        const me = await getBillingActor(req);
        const owner = getBillingOwnerFromUser(me);
        const billingDoc = await getBillingAccountByOwner(owner);

        if (!billingDoc?.stripeCustomerId) {
          throw createBillingHttpError(
            404,
            "BILLING_CUSTOMER_NOT_FOUND",
            "No Stripe customer exists for this account yet",
          );
        }

        const stripe = getStripeClient();
        const session = await stripe.billingPortal.sessions.create({
          customer: billingDoc.stripeCustomerId,
          return_url: buildBillingReturnUrl(),
        });

        await upsertBillingAccount(owner, {
          lastPortalSessionAt: now(),
        });

        return res.json({ url: session.url });
      } catch (error) {
        if (error?.status) {
          return sendBillingError(res, error);
        }

        console.error("[Billing] Failed to create portal session:", error);
        return sendBillingError(
          res,
          createBillingHttpError(
            500,
            "PORTAL_SESSION_FAILED",
            "Failed to create Stripe Billing Portal session",
          ),
        );
      }
    });

    app.post("/api/billing/webhook", async (req, res) => {
      let stripe;
      try {
        stripe = getStripeClient();
      } catch (error) {
        return sendBillingError(res, error);
      }

      const webhookSecret = cleanEnvValue(process.env.STRIPE_WEBHOOK_SECRET);

      if (!webhookSecret) {
        console.error("[Billing] Missing STRIPE_WEBHOOK_SECRET");
        return res.status(500).json({
          error: "Stripe webhook secret is not configured",
          code: "STRIPE_WEBHOOK_NOT_CONFIGURED",
        });
      }

      const signature = String(req.headers["stripe-signature"] || "");
      if (!signature) {
        return res.status(400).json({
          error: "Missing Stripe signature",
          code: "MISSING_STRIPE_SIGNATURE",
        });
      }

      if (!Buffer.isBuffer(req.rawBody)) {
        return res.status(400).json({
          error: "Stripe webhook raw body is missing",
          code: "MISSING_WEBHOOK_PAYLOAD",
        });
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.rawBody,
          signature,
          webhookSecret,
        );
      } catch (error) {
        console.error("[Billing] Invalid Stripe webhook signature:", error);
        return res.status(400).json({
          error: "Invalid Stripe webhook signature",
          code: "INVALID_STRIPE_SIGNATURE",
        });
      }

      try {
        const registration = await registerWebhookEvent(event);
        if (registration.alreadyProcessed) {
          return res.json({ received: true, duplicate: true });
        }

        let handled = true;
        switch (event.type) {
          case "checkout.session.completed":
            handled = await syncCheckoutSessionToBilling(
              event.data.object,
              event,
            );
            break;
          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted":
            handled = await syncSubscriptionToBilling(event.data.object, event);
            break;
          case "invoice.paid":
          case "invoice.payment_failed":
            handled = await syncInvoiceToBilling(event.data.object, event);
            break;
          default:
            handled = false;
            break;
        }

        await markWebhookEventProcessed(event, handled);
        return res.json({ received: true, handled });
      } catch (error) {
        console.error("[Billing] Webhook processing failed:", error);
        await markWebhookEventFailed(event, error);
        return res.status(500).json({
          error: "Stripe webhook processing failed",
          code: "WEBHOOK_PROCESSING_FAILED",
        });
      }
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
          loginAttempts: 0,
          lockUntil: null,
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
    // const jwt = require("jsonwebtoken"); //DUPLICATE REQUIRE

    const MAX_LOGIN_ATTEMPTS = 5;
    const LOCK_TIME = 30 * 1000;

    app.post("/auth/login", async (req, res) => {
      // console.log("POST /auth/login hit", req.body);
      try {
        const { email, password } = req.body;

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(400).json({ message: "Invalid credentials" });
        }

        if (user.lockUntil && new Date(user.lockUntil) > new Date()) {
          return res.status(403).json({
            message: "Account locked",
            lockUntil: user.lockUntil,
          });
        }

        const isValid = await bcrypt.compare(password, user.password);

        if (!isValid) {
          const attempts = (user.loginAttempts || 0) + 1;

          const updateData = {
            loginAttempts: attempts,
          };

          if (attempts >= MAX_LOGIN_ATTEMPTS) {
            updateData.lockUntil = new Date(
              Date.now() + LOCK_TIME,
            ).toISOString();
          }

          await usersCollection.updateOne(
            { _id: user._id },
            { $set: updateData },
          );

          return res.status(400).json({
            message: "Invalid credentials",
          });
        }

        await usersCollection.updateOne(
          { _id: user._id },
          {
            $set: {
              loginAttempts: 0,
              lockUntil: null,
            },
          },
        );

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

    app.post("/users", async (req, res) => {
      const users = req.body;
      const result = await usersCollection.insertOne(users);
      res.send(result);
    });

    // GET /dashboard/profile
    app.get("/dashboard/profile", verifyToken, async (req, res) => {
      const me = getUserIdentity(req);

      const userDoc = await findAuthUserDoc(me);

      if (!userDoc) {
        return res.status(404).json({ error: "User not found" });
      }

      return res.json({
        currentUser: mapUserProfile(userDoc),
      });
    });

    // PATCH /dashboard/profile
    app.patch("/dashboard/profile", verifyToken, async (req, res) => {
      const me = getUserIdentity(req);

      const userDoc = await findAuthUserDoc(me);

      if (!userDoc) {
        return res.status(404).json({ error: "User not found" });
      }

      const patch = req.body || {};
      const $set = { updatedAt: now() };

      for (const key of [
        "name",
        "phone",
        "roleTitle",
        "company",
        "location",
        "website",
        "avatarUrl",
        "bio",
      ]) {
        if (patch[key] !== undefined) {
          $set[key] = String(patch[key] || "").trim();
        }
      }

      if (Array.isArray(patch.starredWorkspaceIds)) {
        $set.starredWorkspaceIds = patch.starredWorkspaceIds.map(String);
      }

      await usersCollection.updateOne({ _id: userDoc._id }, { $set });

      const updated = await usersCollection.findOne({ _id: userDoc._id });

      return res.json({
        currentUser: mapUserProfile(updated),
      });
    });

    // GET /dashboard/bootstrap
    app.get("/dashboard/bootstrap", verifyToken, async (req, res) => {
      const me = getUserIdentity(req);
      if (!me.id) return res.status(401).json({ error: "Unauthorized" });

      const workspaceDocs = await workspacesCollection
        .find({
          $or: [
            { "members.userId": String(me.id) },
            { "members.email": normalizeEmail(me.email) },
          ],
        })
        .sort({ createdAt: -1 })
        .toArray();

      const workspaceIds = workspaceDocs.map((w) => w._id);
      const projects = await projectsCollection
        .find({ workspaceId: { $in: workspaceIds } })
        .toArray();
      const tasks = await tasksCollection
        .find({ workspaceId: { $in: workspaceIds } })
        .sort({ createdAt: -1 })
        .toArray();
      const notifications = await notificationsCollection
        .find({ userId: String(me.id) })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

      const workspaces = workspaceDocs.map((w) => ({
        id: String(w._id),
        name: w.name,
        slug: w.slug,
        members: (w.members || []).map((member) => ({
          ...member,
          id: String(member?.id || member?.userId || ""),
          userId: String(member?.userId || ""),
          name:
            member?.name ||
            (member?.email ? member.email.split("@")[0] : "Member"),
          email: member?.email || "",
          role: member?.role || "member",
        })),
      }));

      const userDoc = await findAuthUserDoc(me);

      const activity = await activitiesCollection
        .find({ workspaceId: { $in: workspaceIds.map(String) } })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray();

      res.json({
        currentUser: userDoc
          ? mapUserProfile(userDoc)
          : {
              id: String(me.id || ""),
              name: me.name || "",
              email: me.email || "",
            },
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
          boardId: t.boardId ? String(t.boardId) : "",
          columnId: t.columnId ? String(t.columnId) : "",
          order: Number.isInteger(t.order) ? t.order : 0,
          taskNumber: t.taskNumber || "",
          taskRef: t.taskRef || "",
          projectName: t.projectName || "",
          title: t.title,
          description: t.description || "",
          priority: t.priority || "P2",
          status: t.status || "todo",
          dueDate: t.dueDate || "",
          assigneeId: t.assigneeId || "",
          assigneeName: t.assigneeName || "Unassigned",
          ...mapTaskReporter(t),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt || "",
          estimatedTime: Number(t.estimatedTime || 0),
          totalTimeSpent: Number(t.totalTimeSpent || 0),
          remainingTime: Math.max(
            Number(
              t.remainingTime !== undefined
                ? t.remainingTime
                : Number(t.estimatedTime || 0) - Number(t.totalTimeSpent || 0),
            ),
            0,
          ),
          // bayijid - file attach
          attachments: t.attachments || [],
          // bayijid - file attach
        })),
        activity: activity.map((a) => ({
          id: String(a._id),
          text: a.text,
          action: a.action,
          createdAt: a.createdAt,
          taskId: a.taskId,
          projectId: a.projectId,
        })),
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
    // Rifat Has Edited this Route //
    app.post("/dashboard/workspaces", verifyToken, async (req, res) => {
      const me = getUserIdentity(req);
      const { name, memberEmails = [] } = req.body || {};
      if (!name?.trim())
        return res.status(400).json({ error: "Workspace name is required" });

      // Workspace's Member (admin only)
      const members = [
        {
          id: String(me.id),
          userId: String(me.id),
          name: me.name,
          email: me.email,
          role: "admin", //changed to admin
        },
      ];
      // Workspace Data in DB
      const doc = {
        name: name.trim(),
        slug: name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, ""),
        members,
        createdBy: String(me.id),
        createdAt: now(),
      };
      // Insert Workspace Data in DB
      const result = await workspacesCollection.insertOne(doc);

      // Workspace Data
      const workspaceId = String(result.insertedId);
      const workspaceName = doc.name;

      // Invitation Link
      const frontendURL = process.env.FRONTEND_URL || "http://localhost:3000";
      const seenInviteEmails = new Set();

      //  invite data for db
      for (const raw of memberEmails) {
        const email = normalizeEmail(raw);
        if (
          !email ||
          members.some((m) => normalizeEmail(m.email) === email) ||
          seenInviteEmails.has(email)
        )
          continue;
        seenInviteEmails.add(email);

        const inviteRole = "member";

        // Generate and Hash Token
        const rawToken = crypto.randomBytes(32).toString("hex");
        const hashedToken = crypto
          .createHash("sha256")
          .update(rawToken)
          .digest("hex");

        const inviteLink = `${frontendURL}/accept-invite/${rawToken}`;

        const inviteData = {
          email,
          role: inviteRole,
          workspaceId,
          workspaceName,
          status: "pending",
          token: hashedToken,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
        };
        // Save Invite Data
        await inviteCollection.insertOne(inviteData);

        // After invite data is stored, send invite email via Gmail SMTP.
        try {
          await sendInviteEmail({
            to: email,
            subject: `You're invited to join ${doc.name}`,
            html: `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        /* Responsive styles for mobile clients */
        @media only screen and (max-width: 600px) {
          .container { width: 100% !important; border-radius: 0 !important; border: none !important; }
          .content { padding: 30px 20px !important; }
          .button { width: 100% !important; text-align: center; display: block !important; box-sizing: border-box; }
        }
      </style>
    </head>
    <body style="margin:0;padding:0;background-color:#f4f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#f4f7fa;padding:40px 0;">
        <tr>
          <td align="center">
            <table class="container" width="560" border="0" cellspacing="0" cellpadding="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);border:1px solid #e5e7eb;">
              
              <tr>
                <td class="content" style="padding:40px 40px 0 40px;">
                  <img src="https://res.cloudinary.com/dsyahfiyo/image/upload/v1772881604/logo1_b7iv2u.png" 
                       alt="${doc.name}" 
                       width="48" 
                       style="display:block; border:0; outline:none; text-decoration:none; max-width:120px; height:auto;">
                </td>
              </tr>

              <tr>
                <td class="content" style="padding:32px 40px 40px 40px;">
                  <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#111827;line-height:1.2;">
                    Join the workspace
                  </h1>
                  <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#4b5563;">
                    Hi there! You've been invited to join <strong>${doc.name}</strong> as a 
                    <span style="background:#f3f4f6;color:#111827;padding:2px 8px;border-radius:4px;font-weight:600;font-size:14px;text-transform:capitalize;">${inviteRole}</span>.
                  </p>
                  <p style="margin:0 0 32px;font-size:16px;line-height:1.6;color:#4b5563;">
                    Collaborate with your team, manage projects, and stay updated—all in one place.
                  </p>
                  
                  <a href="${inviteLink}" class="button" style="display:inline-block;background-color:#4f46e5;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 30px;border-radius:8px;">
                    Accept Invitation
                  </a>
                </td>
              </tr>

              <tr>
                <td style="padding:30px 40px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
                  <p style="margin:0 0 10px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;font-weight:700;">
                    Trouble with the button?
                  </p>
                  <p style="margin:0;font-size:13px;line-height:1.5;word-break:break-all;">
                    <a href="${inviteLink}" style="color:#4f46e5;text-decoration:none;">${inviteLink}</a>
                  </p>
                </td>
              </tr>
            </table>

            <table width="560" class="container" border="0" cellspacing="0" cellpadding="0">
              <tr>
                <td style="padding:24px 10px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.4;">
                    This invitation was sent to you by ${doc.name}.<br>
                    If you weren't expecting this, you can safely ignore this email.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `,
          });
        } catch (mailError) {
          // Keep invite creation successful even if email sending fails.
          console.error("SMTP send failed:", mailError?.message || mailError);
        }
      }

      // Send Invite to Users

      res.status(201).json({
        workspace: {
          id: String(result.insertedId),
          name: doc.name,
          slug: doc.slug,
          members: doc.members,
        },
      });
    });

    // POST /dashboard/workspaces/:workspaceId/members
    app.post(
      "/dashboard/workspaces/:workspaceId/members",
      verifyToken,
      async (req, res) => {
        const { workspaceId } = req.params;
        const { email, role = "member" } = req.body || {};
        const clean = normalizeEmail(email);
        if (!clean)
          return res.status(400).json({ error: "Member email is required" });

        const me = getUserIdentity(req);
        const workspace = await workspacesCollection.findOne({
          _id: toId(workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });
        // Admin-only: adding members changes workspace membership directly.
        if (!isWorkspaceAdmin(workspace, me))
          return res.status(403).json({ error: "Only admin can add members" });

        const exists = (workspace.members || []).find(
          (m) => normalizeEmail(m.email) === clean,
        );
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
          { $push: { members: member } },
        );

        res.status(201).json({ member });
      },
    );

    app.delete(
      "/dashboard/workspaces/:workspaceId",
      verifyToken,
      async (req, res) => {
        const { workspaceId } = req.params;
        const me = getUserIdentity(req);

        const workspace = await workspacesCollection.findOne({
          _id: toId(workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });
        // Admin-only: deleting a workspace is a destructive management action.
        if (!isWorkspaceAdmin(workspace, me))
          return res
            .status(403)
            .json({ error: "Only admin can delete workspace" });

        await projectsCollection.deleteMany({ workspaceId: toId(workspaceId) });
        await boardsCollection.deleteMany({ workspaceId: toId(workspaceId) });
        await tasksCollection.deleteMany({ workspaceId: toId(workspaceId) });
        await timeLogsCollection.deleteMany({ workspaceId: toId(workspaceId) });
        await workspacesCollection.deleteOne({ _id: toId(workspaceId) });

        return res.json({ ok: true });
      },
    );

    // POST /dashboard/projects
    app.post("/dashboard/projects", verifyToken, async (req, res) => {
      const { workspaceId, name, key = "" } = req.body || {};
      if (!workspaceId || !name?.trim())
        return res
          .status(400)
          .json({ error: "workspaceId and project name are required" });
      if (!isValidId(workspaceId))
        return res.status(400).json({ error: "Invalid workspaceId" });

      const workspace = await workspacesCollection.findOne({
        _id: toId(workspaceId),
      });
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });

      // Get the verified requester identity from token / forwarded headers.
      const me = getUserIdentity(req);
      // Role-based access example:
      // creating a project is treated as an admin-only workspace action.
      if (!isWorkspaceAdmin(workspace, me))
        return res
          .status(403)
          .json({ error: "Only admin can create projects" });

      const project = {
        workspaceId: toId(workspaceId),
        name: name.trim(),
        key:
          String(key || name)
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, "")
            .slice(0, 6) || "PROJ",
        status: "active",
        createdAt: now(),
      };

      const defaultColumns = [
        { _id: new ObjectId(), name: "To Do", order: 0 },
        { _id: new ObjectId(), name: "In Progress", order: 1 },
        { _id: new ObjectId(), name: "In Review", order: 2 },
        { _id: new ObjectId(), name: "Done", order: 3 },
      ];

      const session = client.startSession();
      let createdProjectId = null;
      let createdBoardId = null;

      try {
        await session.withTransaction(async () => {
          const projectResult = await projectsCollection.insertOne(project, {
            session,
          });
          createdProjectId = projectResult.insertedId;

          const boardDoc = {
            workspaceId: toId(workspaceId),
            projectId: createdProjectId,
            name: "Default Board",
            columns: defaultColumns,
            createdAt: now(),
          };

          const boardResult = await boardsCollection.insertOne(boardDoc, {
            session,
          });
          createdBoardId = boardResult.insertedId;
        });
      } finally {
        await session.endSession();
      }

      res.status(201).json({
        project: {
          id: String(createdProjectId),
          workspaceId: String(project.workspaceId),
          name: project.name,
          key: project.key,
          status: project.status,
          createdAt: project.createdAt,
        },
        board: {
          id: String(createdBoardId),
          name: "Default Board",
          columns: defaultColumns.map((c) => ({
            id: String(c._id),
            name: c.name,
            order: c.order,
          })),
        },
      });
    });

    // POST /dashboard/tasks
    app.post("/dashboard/tasks", verifyToken, async (req, res) => {
      const me = getUserIdentity(req);

      // ==========================================
      // 🤖 AI KICKSTART OVERRIDE (OFFICIAL GROQ SDK)
      // ==========================================
      if (req.body.isAiKickstart) {
        const { projectId } = req.body;
        try {
          if (!isValidId(projectId))
            return res.status(400).json({ error: "Invalid projectId" });

          const project = await projectsCollection.findOne({
            _id: toId(projectId),
          });
          if (!project)
            return res.status(404).json({ error: "Project not found" });

          const workspace = await workspacesCollection.findOne({
            _id: toId(project.workspaceId),
          });
          if (!isWorkspaceMember(workspace, me))
            return res
              .status(403)
              .json({ error: "Forbidden workspace access" });

          const board = await boardsCollection.findOne({
            projectId: toId(projectId),
          });
          if (!board) return res.status(404).json({ error: "Board not found" });

          const todoColumn = (board.columns || []).find(
            (c) =>
              c.name.toLowerCase().includes("to do") ||
              c.name.toLowerCase().includes("todo"),
          );
          if (!todoColumn)
            return res.status(400).json({ error: "No To Do column found" });

          // --- OFFICIAL GROQ CALL START ---
          const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

          const prompt = `You are an expert Agile Product Owner. 
          I just created a new software project named: "${project.name}". 
          Create a backlog of 5 essential starter tasks explicitly tailored to the domain of "${project.name}". 
          
          CRITICAL RULES:
          1. Do NOT give me generic tasks like "Setup repository".
          2. Every task MUST directly relate to the specific technology or business logic implied by the name "${project.name}".
          3. Return the result as a JSON object containing a "tasks" array.
          
          Use this exact JSON schema:
          {
            "tasks": [
              { 
                "title": "Specific task title related to ${project.name}", 
                "description": "Detailed technical description.", 
                "estimatedTime": 3600 
              }
            ]
          }`;

          const completion = await groq.chat.completions.create({
            messages: [
              { role: "system", content: "You output pure JSON." },
              { role: "user", content: prompt },
            ],
            model: "llama-3.3-70b-versatile", // The latest active model from the docs!
            response_format: { type: "json_object" }, // Forces valid JSON
          });

          // Easily parse the guaranteed JSON response
          const aiResponse = JSON.parse(completion.choices[0].message.content);
          const tasksData = aiResponse.tasks;
          // --- OFFICIAL GROQ CALL END ---

          const lastNumberedTask = await tasksCollection
            .find({ projectId: toId(projectId) })
            .sort({ taskNumber: -1 })
            .limit(1)
            .toArray();
          let nextTaskNumber =
            lastNumberedTask.length > 0
              ? lastNumberedTask[0].taskNumber || 0
              : 0;

          const newTasks = tasksData.map((t, index) => {
            nextTaskNumber++;
            return {
              workspaceId: project.workspaceId,
              projectId: project._id,
              boardId: board._id,
              columnId: todoColumn._id,
              order: index,
              taskNumber: nextTaskNumber,
              taskRef: `${project.key}-${nextTaskNumber}`,
              projectName: project.name,
              title: t.title,
              description: t.description,
              priority: "P2",
              status: "todo",
              dueDate: "",
              assigneeId: "",
              assigneeName: "Unassigned",
              reporterId: String(me.id || ""),
              reporterName: "AI Assistant 🤖",
              reporterEmail: "",
              estimatedTime: t.estimatedTime || 3600,
              totalTimeSpent: 0,
              remainingTime: t.estimatedTime || 3600,
              attachments: [],
              createdAt: now(),
              updatedAt: now(),
              assignedByUserId: String(me.id || ""),
              assignedByName: "AI Assistant 🤖",
            };
          });

          await tasksCollection.insertMany(newTasks);
          return res.status(201).json({
            message: "AI Kickstart complete",
            tasksAdded: newTasks.length,
          });
        } catch (error) {
          console.error("AI Kickstart failed:", error);
          return res.status(500).json({ error: "Failed to generate AI tasks" });
        }
      }
      // ==========================================

      const {
        workspaceId,
        projectId = "",
        boardId = "",
        columnId = "",
        title,
        description = "",
        priority = "P2",
        status = "todo",
        dueDate = "",
        assigneeId = "",
        estimatedTime = 0,
        // bayijid - file attach
        attachments = [],
        // bayijid - file attach
      } = req.body || {};
      if (!workspaceId || !projectId || !boardId || !columnId || !title?.trim())
        return res.status(400).json({
          error:
            "workspaceId, projectId, boardId, columnId and title are required",
        });
      if (
        !isValidId(workspaceId) ||
        !isValidId(projectId) ||
        !isValidId(boardId) ||
        !isValidId(columnId)
      ) {
        return res.status(400).json({
          error: "workspaceId, projectId, boardId or columnId is invalid",
        });
      }

      const workspace = await workspacesCollection.findOne({
        _id: toId(workspaceId),
      });
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });

      if (!isWorkspaceMember(workspace, me))
        return res.status(403).json({ error: "Forbidden workspace access" });

      const project = await projectsCollection.findOne({
        _id: toId(projectId),
        workspaceId: toId(workspaceId),
      });
      if (!project)
        return res
          .status(404)
          .json({ error: "Project not found in this workspace" });

      const board = await boardsCollection.findOne({
        _id: toId(boardId),
        workspaceId: toId(workspaceId),
        projectId: toId(projectId),
      });
      if (!board) return res.status(404).json({ error: "Board not found" });

      const hasColumn = (board.columns || []).some(
        (c) => String(c._id) === String(toId(columnId)),
      );
      if (!hasColumn)
        return res.status(400).json({ error: "Invalid columnId for board" });

      const parsedEstimatedTime = Number(estimatedTime);
      if (!Number.isFinite(parsedEstimatedTime) || parsedEstimatedTime < 0) {
        return res
          .status(400)
          .json({ error: "estimatedTime must be a non-negative number" });
      }
      const safeEstimatedTime = Math.floor(parsedEstimatedTime);

      const assignee =
        (workspace.members || []).find((m) => m.id === assigneeId) ||
        (workspace.members || [])[0] ||
        null;

      const lastTask = await tasksCollection
        .find({
          workspaceId: toId(workspaceId),
          projectId: toId(projectId),
          boardId: toId(boardId),
          columnId: toId(columnId),
        })
        .sort({ order: -1 })
        .limit(1)
        .toArray();
      const nextOrder =
        lastTask.length > 0 && Number.isInteger(lastTask[0].order)
          ? lastTask[0].order + 1
          : 0;

      // Rifat was here hehehahahaha
      // Find Last Number Task/Add it
      const lastNumberedTask = await tasksCollection
        .find({ projectId: toId(projectId) })
        .sort({ taskNumber: -1 })
        .limit(1)
        .toArray();

      const nextTaskNumber =
        lastNumberedTask.length > 0
          ? (lastNumberedTask[0].taskNumber || 0) + 1
          : 1;

      const taskRef = `${project.key}-${nextTaskNumber}`;

      const task = {
        workspaceId: toId(workspaceId),
        projectId: toId(projectId),
        boardId: toId(boardId),
        columnId: toId(columnId),
        order: nextOrder,
        // Added taskNumber & Ref --> Needed for Github Webhook
        taskNumber: nextTaskNumber,
        taskRef: taskRef,
        //
        projectName: project.name,
        title: title.trim(),
        description,
        priority,
        status,
        dueDate,
        assigneeId: assignee?.id || "",
        assigneeName: assignee?.name || "Unassigned",
        reporterId: String(me.id || ""),
        reporterName: String(me.name || me.email || "User"),
        reporterEmail: String(me.email || ""),
        estimatedTime: safeEstimatedTime,
        totalTimeSpent: 0,
        remainingTime: safeEstimatedTime,
        // file attach - bayijid
        attachments: Array.isArray(attachments) ? attachments : [],
        // file attach - bayijid
        createdAt: now(),
        updatedAt: now(),
        assignedByUserId: String(me.id || ""),
        assignedByName: String(me.name || "User"),
      };

      const result = await tasksCollection.insertOne(task);

      await createActivity({
        userId: me.id,
        workspaceId,
        projectId,
        taskId: String(result.insertedId),
        action: "task_created",
        text: `${me.name} created task "${task.title}"`,
      });

      const assigneeUserId = getMemberUserId(workspace, task.assigneeId);
      if (assigneeUserId && assigneeUserId !== String(me.id)) {
        await createNotification({
          userId: assigneeUserId,
          text: `${me.name || "Someone"} assigned you: ${task.title}`,
          type: "task_assigned",
          data: {
            taskId: String(result.insertedId),
            workspaceId,
            projectId: String(task.projectId),
          },
        });
      }

      res.status(201).json({
        task: {
          id: String(result.insertedId),
          workspaceId,
          projectId: String(task.projectId),
          boardId: String(task.boardId),
          columnId: String(task.columnId),
          // Keep taskRef/taskNumber in the response so the frontend can render
          // it immediately (and not "lose" it during store merges).
          taskNumber: task.taskNumber || "",
          taskRef: task.taskRef || "",
          order: task.order,
          projectName: task.projectName,
          title: task.title,
          description: task.description,
          priority: task.priority,
          status: task.status,
          dueDate: task.dueDate,
          assigneeId: task.assigneeId,
          assigneeName: task.assigneeName,
          ...mapTaskReporter(task),
          estimatedTime: task.estimatedTime,
          totalTimeSpent: task.totalTimeSpent,
          remainingTime: task.remainingTime,
          createdAt: task.createdAt,
          // file attach - helal / bayijid
          attachments: task.attachments || [],
          // file attach - helal / bayijid
        },
      });
    });

    // DELETE /dashboard/projects/:projectId
    app.delete(
      "/dashboard/projects/:projectId",
      verifyToken,
      async (req, res) => {
        const { projectId } = req.params;
        const me = getUserIdentity(req);

        if (!isValidId(projectId))
          return res.status(400).json({ error: "Invalid projectId" });

        const project = await projectsCollection.findOne({
          _id: toId(projectId),
        });
        if (!project)
          return res.status(404).json({ error: "Project not found" });

        const workspace = await workspacesCollection.findOne({
          _id: toId(project.workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });
        // Admin-only: deleting a project changes workspace structure.
        if (!isWorkspaceAdmin(workspace, me))
          return res
            .status(403)
            .json({ error: "Only admin can delete projects" });

        await tasksCollection.deleteMany({
          workspaceId: toId(project.workspaceId),
          projectId: toId(projectId),
        });
        await timeLogsCollection.deleteMany({
          workspaceId: toId(project.workspaceId),
          projectId: toId(projectId),
        });
        await boardsCollection.deleteMany({
          workspaceId: toId(project.workspaceId),
          projectId: toId(projectId),
        });
        await projectsCollection.deleteOne({ _id: toId(projectId) });

        return res.json({ ok: true });
      },
    );

    // DELETE /dashboard/tasks/:taskId
    app.delete("/dashboard/tasks/:taskId", verifyToken, async (req, res) => {
      const { taskId } = req.params;
      const me = getUserIdentity(req);

      if (!isValidId(taskId))
        return res.status(400).json({ error: "Invalid taskId" });

      const task = await tasksCollection.findOne({ _id: toId(taskId) });
      if (!task) return res.status(404).json({ error: "Task not found" });

      const workspace = await workspacesCollection.findOne({
        _id: toId(task.workspaceId),
      });
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      if (!isWorkspaceMember(workspace, me))
        return res.status(403).json({ error: "Forbidden workspace access" });

      const assigneeUserId = getMemberUserId(workspace, task.assigneeId);
      if (assigneeUserId && assigneeUserId !== String(me.id)) {
        await createNotification({
          userId: assigneeUserId,
          text: `${me.name || "Someone"} deleted task: ${task.title}`,
          type: "task_deleted",
          data: {
            taskId: String(task._id),
            workspaceId: String(task.workspaceId),
          },
        });
      }

      await createActivity({
        userId: me.id,
        workspaceId: String(task.workspaceId),
        projectId: task.projectId ? String(task.projectId) : "",
        taskId: String(task._id),
        action: "task_deleted",
        text: `${me.name} deleted task "${task.title}"`,
      });

      await tasksCollection.deleteOne({ _id: toId(taskId) });
      await timeLogsCollection.deleteMany({ taskId: toId(taskId) });
      return res.json({ ok: true });
    });

    // new api for board
    app.get("/dashboard/boards/:projectId", verifyToken, async (req, res) => {
      const { projectId } = req.params;
      const me = getUserIdentity(req);
      if (!isValidId(projectId))
        return res.status(400).json({ error: "Invalid projectId" });

      const project = await projectsCollection.findOne({
        _id: toId(projectId),
      });
      if (!project) return res.status(404).json({ error: "Project not found" });

      const workspace = await workspacesCollection.findOne({
        _id: toId(project.workspaceId),
      });
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      if (!isWorkspaceMember(workspace, me))
        return res.status(403).json({ error: "Forbidden workspace access" });

      const board = await boardsCollection.findOne({
        projectId: toId(projectId),
        workspaceId: toId(project.workspaceId),
      });
      if (!board) return res.status(404).json({ error: "Board not found" });

      const sortedColumns = [...(board.columns || [])].sort(
        (a, b) => Number(a.order || 0) - Number(b.order || 0),
      );
      const tasks = await tasksCollection
        .find({ boardId: toId(board._id), projectId: toId(projectId) })
        .sort({ order: 1, createdAt: 1 })
        .toArray();

      const columns = sortedColumns.map((col) => ({
        id: String(col._id),
        name: col.name,
        order: Number(col.order || 0),
        tasks: tasks
          .filter((t) => String(t.columnId) === String(col._id))
          .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
          .map((t) => ({
            id: String(t._id),
            workspaceId: String(t.workspaceId),
            projectId: t.projectId ? String(t.projectId) : "",
            boardId: t.boardId ? String(t.boardId) : "",
            columnId: t.columnId ? String(t.columnId) : "",
            taskNumber: t.taskNumber || "",
            taskRef: t.taskRef || "",
            order: Number(t.order || 0),
            projectName: t.projectName || "",
            title: t.title,
            description: t.description || "",
            priority: t.priority || "P2",
            status: t.status || "todo",
            dueDate: t.dueDate || "",
            assigneeId: t.assigneeId || "",
            assigneeName: t.assigneeName || "Unassigned",
            ...mapTaskReporter(t),
            createdAt: t.createdAt,
            updatedAt: t.updatedAt || "",
            estimatedTime: Number(t.estimatedTime || 0),
            totalTimeSpent: Number(t.totalTimeSpent || 0),
            remainingTime: Math.max(
              Number(
                t.remainingTime !== undefined
                  ? t.remainingTime
                  : Number(t.estimatedTime || 0) -
                      Number(t.totalTimeSpent || 0),
              ),
              0,
            ),
            // file attach - helal / bayijid
            attachments: t.attachments || [],
            // file attach - helal / bayijid
          })),
      }));

      return res.json({
        board: {
          id: String(board._id),
          workspaceId: String(board.workspaceId),
          projectId: String(board.projectId),
          name: board.name,
          createdAt: board.createdAt,
        },
        columns,
      });
    });

    app.patch(
      "/dashboard/tasks/:taskId/move",
      verifyToken,
      async (req, res) => {
        const { taskId } = req.params;
        const {
          sourceColumnId,
          destinationColumnId,
          destinationBoardId = "",
          newOrder,
          status,
        } = req.body || {};

        if (
          !taskId ||
          !sourceColumnId ||
          !destinationColumnId ||
          !Number.isInteger(newOrder) ||
          newOrder < 0
        ) {
          return res.status(400).json({
            error:
              "taskId, sourceColumnId, destinationColumnId and non-negative integer newOrder are required",
          });
        }
        if (
          !isValidId(taskId) ||
          !isValidId(sourceColumnId) ||
          !isValidId(destinationColumnId)
        ) {
          return res.status(400).json({
            error: "taskId, sourceColumnId or destinationColumnId is invalid",
          });
        }
        if (destinationBoardId && !isValidId(destinationBoardId)) {
          return res.status(400).json({
            error: "destinationBoardId is invalid",
          });
        }

        const me = getUserIdentity(req);
        const session = client.startSession();
        let pendingNotification = [];

        try {
          let responsePayload = null;

          await session.withTransaction(async () => {
            pendingNotification = null;
            const task = await tasksCollection.findOne(
              { _id: toId(taskId) },
              { session },
            );
            if (!task) throw { status: 404, message: "Task not found" };
            if (!task.workspaceId || !task.projectId || !task.boardId) {
              throw { status: 400, message: "Task is not linked to a board" };
            }

            if (String(task.columnId) !== String(toId(sourceColumnId))) {
              throw {
                status: 400,
                message: "sourceColumnId does not match current task columnId",
              };
            }

            const workspace = await workspacesCollection.findOne(
              { _id: toId(task.workspaceId) },
              { session },
            );
            if (!workspace)
              throw { status: 404, message: "Workspace not found" };
            if (!isWorkspaceMember(workspace, me)) {
              throw { status: 403, message: "Forbidden workspace access" };
            }

            const project = await projectsCollection.findOne(
              {
                _id: toId(task.projectId),
                workspaceId: toId(task.workspaceId),
              },
              { session },
            );
            if (!project)
              throw { status: 404, message: "Project not found in workspace" };

            const sourceBoard = await boardsCollection.findOne(
              {
                _id: toId(task.boardId),
                workspaceId: toId(task.workspaceId),
                projectId: toId(task.projectId),
              },
              { session },
            );
            const sourceId = toId(sourceColumnId);
            if (!sourceBoard) throw { status: 404, message: "Board not found" };

            const sourceBoardColumnIds = new Set(
              (sourceBoard.columns || []).map((c) => String(c._id)),
            );
            if (!sourceBoardColumnIds.has(String(sourceId))) {
              throw { status: 400, message: "Invalid source column for board" };
            }

            const targetBoardId = destinationBoardId
              ? toId(destinationBoardId)
              : toId(task.boardId);
            const destinationBoard =
              String(targetBoardId) === String(sourceBoard._id)
                ? sourceBoard
                : await boardsCollection.findOne(
                    {
                      _id: targetBoardId,
                      workspaceId: toId(task.workspaceId),
                      projectId: toId(task.projectId),
                    },
                    { session },
                  );
            if (!destinationBoard) {
              throw { status: 404, message: "Destination board not found" };
            }

            const destinationId = toId(destinationColumnId);
            const destinationBoardColumnIds = new Set(
              (destinationBoard.columns || []).map((c) => String(c._id)),
            );
            if (!destinationBoardColumnIds.has(String(destinationId))) {
              throw {
                status: 400,
                message: "Invalid destination column for destination board",
              };
            }

            const destinationColumn = (destinationBoard.columns || []).find(
              (c) => String(c._id) === String(destinationId),
            );
            const explicitStatus =
              typeof status === "string" ? status.trim() : "";
            const nextStatus =
              explicitStatus ||
              statusFromColumnName(destinationColumn?.name) ||
              task.status ||
              "todo";

            const sameBoard = String(sourceBoard._id) === String(targetBoardId);
            const sameColumn =
              sameBoard && String(sourceId) === String(destinationId);

            const sourceTasksWithoutMoved = await tasksCollection
              .find(
                {
                  boardId: toId(sourceBoard._id),
                  columnId: sourceId,
                  _id: { $ne: toId(taskId) },
                },
                { session },
              )
              .sort({ order: 1, createdAt: 1 })
              .toArray();

            const ops = [];
            const updatedAt = now();

            if (sameColumn) {
              const insertAt = Math.min(
                newOrder,
                sourceTasksWithoutMoved.length,
              );
              const reordered = [...sourceTasksWithoutMoved];
              reordered.splice(insertAt, 0, task);

              reordered.forEach((t, index) => {
                const $set = { order: index, updatedAt };
                if (String(t._id) === String(task._id) && explicitStatus) {
                  $set.status = nextStatus;
                }
                ops.push({
                  updateOne: {
                    filter: { _id: toId(t._id) },
                    update: { $set },
                  },
                });
              });
            } else {
              const destinationTasks = await tasksCollection
                .find(
                  { boardId: targetBoardId, columnId: destinationId },
                  { session },
                )
                .sort({ order: 1, createdAt: 1 })
                .toArray();

              sourceTasksWithoutMoved.forEach((t, index) => {
                ops.push({
                  updateOne: {
                    filter: { _id: toId(t._id) },
                    update: { $set: { order: index, updatedAt } },
                  },
                });
              });

              const insertAt = Math.min(newOrder, destinationTasks.length);
              const destinationReordered = [...destinationTasks];
              destinationReordered.splice(insertAt, 0, {
                ...task,
                boardId: targetBoardId,
                columnId: destinationId,
                status: nextStatus,
              });

              destinationReordered.forEach((t, index) => {
                if (String(t._id) === String(task._id)) {
                  ops.push({
                    updateOne: {
                      filter: { _id: toId(task._id) },
                      update: {
                        $set: {
                          boardId: targetBoardId,
                          columnId: destinationId,
                          order: index,
                          status: nextStatus,
                          updatedAt,
                        },
                      },
                    },
                  });
                } else {
                  ops.push({
                    updateOne: {
                      filter: { _id: toId(t._id) },
                      update: { $set: { order: index, updatedAt } },
                    },
                  });
                }
              });
            }

            if (ops.length > 0) {
              await tasksCollection.bulkWrite(ops, { session });
            }

            const responseBoard = destinationBoard;
            const sortedColumns = [...(responseBoard.columns || [])].sort(
              (a, b) => Number(a.order || 0) - Number(b.order || 0),
            );
            const boardTasks = await tasksCollection
              .find(
                {
                  boardId: toId(responseBoard._id),
                  workspaceId: toId(task.workspaceId),
                  projectId: toId(task.projectId),
                },
                { session },
              )
              .sort({ order: 1, createdAt: 1 })
              .toArray();

            const fromStatusKey = normalizeStatusKey(task.status);
            const toStatusKey = normalizeStatusKey(nextStatus);

            if (fromStatusKey !== toStatusKey) {
              const recipients = getStatusRecipients({
                workspace,
                task,
                actorUserId: me.id,
              });

              pendingNotification = recipients.map((userId) => ({
                userId,
                text: `${me.name || "Someone"} changed "${task.title}" status: ${statusLabel(task.status)} -> ${statusLabel(nextStatus)}`,
                type: "task_status_changed",
                data: {
                  taskId: String(task._id),
                  workspaceId: String(task.workspaceId),
                  projectId: task.projectId ? String(task.projectId) : "",
                  fromStatus: fromStatusKey,
                  toStatus: toStatusKey,
                  changedByUserId: String(me.id || ""),
                  changedByName: String(me.name || "User"),
                },
              }));
            }

            responsePayload = {
              boardId: String(responseBoard._id),
              projectId: String(project._id),
              workspaceId: String(workspace._id),
              columns: sortedColumns.map((col) => ({
                id: String(col._id),
                name: col.name,
                order: Number(col.order || 0),
                tasks: boardTasks
                  .filter((t) => String(t.columnId) === String(col._id))
                  .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
                  .map((t) => ({
                    id: String(t._id),
                    workspaceId: String(t.workspaceId),
                    projectId: t.projectId ? String(t.projectId) : "",
                    boardId: t.boardId ? String(t.boardId) : "",
                    columnId: t.columnId ? String(t.columnId) : "",
                    // Keep taskRef/taskNumber in move response so UI state
                    // doesn't drop it after drag/drop operations.
                    taskNumber: t.taskNumber || "",
                    taskRef: t.taskRef || "",
                    order: Number(t.order || 0),
                    projectName: t.projectName || "",
                    title: t.title,
                    description: t.description || "",
                    priority: t.priority || "P2",
                    status: t.status || "todo",
                    dueDate: t.dueDate || "",
                    assigneeId: t.assigneeId || "",
                    assigneeName: t.assigneeName || "Unassigned",
                    ...mapTaskReporter(t),
                    createdAt: t.createdAt,
                    updatedAt: t.updatedAt || "",
                    estimatedTime: Number(t.estimatedTime || 0),
                    totalTimeSpent: Number(t.totalTimeSpent || 0),
                    remainingTime: Math.max(
                      Number(
                        t.remainingTime !== undefined
                          ? t.remainingTime
                          : Number(t.estimatedTime || 0) -
                              Number(t.totalTimeSpent || 0),
                      ),
                      0,
                    ),
                    // file attach - helal / bayijid
                    attachments: t.attachments || [],
                    // file attach - helal / bayijid
                  })),
              })),
            };
          });

          for (const n of pendingNotification) {
            await createNotification(n);
          }

          return res.json(responsePayload);
        } catch (error) {
          if (error?.status && error?.message) {
            return res.status(error.status).json({ error: error.message });
          }
          console.error(error);
          return res.status(500).json({ error: "Failed to move task" });
        } finally {
          await session.endSession();
        }
      },
    );

    // PATCH /dashboard/tasks/:taskId
    app.patch("/dashboard/tasks/:taskId", verifyToken, async (req, res) => {
      const { taskId } = req.params;
      const patch = req.body || {};
      const me = getUserIdentity(req);
      if (!isValidId(taskId))
        return res.status(400).json({ error: "Invalid taskId" });

      const existingTask = await tasksCollection.findOne({ _id: toId(taskId) });
      if (!existingTask)
        return res.status(404).json({ error: "Task not found" });

      const workspace = await workspacesCollection.findOne({
        _id: toId(existingTask.workspaceId),
      });
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      if (!isWorkspaceMember(workspace, me))
        return res.status(403).json({ error: "Forbidden workspace access" });

      const $set = {};
      for (const k of [
        "title",
        "description",
        "priority",
        "status",
        "dueDate",
        "assigneeId",
        "assigneeName",
        "projectName",
        "attachments",
      ]) {
        if (typeof patch[k] === "string") $set[k] = patch[k];
      }

      // Bayijid - file attach
      if (Array.isArray(patch.attachments)) {
        $set.attachments = patch.attachments;
      }
      if (patch.estimatedTime !== undefined) {
        const parsedEstimatedTime = Number(patch.estimatedTime);
        if (!Number.isFinite(parsedEstimatedTime) || parsedEstimatedTime < 0) {
          return res
            .status(400)
            .json({ error: "estimatedTime must be a non-negative number" });
        }
        const safeEstimatedTime = Math.floor(parsedEstimatedTime);
        const currentTotal = Number(existingTask.totalTimeSpent || 0);
        $set.estimatedTime = safeEstimatedTime;
        $set.remainingTime = Math.max(safeEstimatedTime - currentTotal, 0);
      }

      if (patch.projectId !== undefined) {
        if (!patch.projectId) {
          $set.projectId = null;
        } else {
          if (!isValidId(patch.projectId))
            return res.status(400).json({ error: "Invalid projectId" });
          const nextProject = await projectsCollection.findOne({
            _id: toId(patch.projectId),
            workspaceId: toId(existingTask.workspaceId),
          });
          if (!nextProject)
            return res
              .status(404)
              .json({ error: "Project not found in this workspace" });
          $set.projectId = toId(patch.projectId);
        }
      }
      $set.updatedAt = now();

      const assigneeChanged =
        patch.assigneeId !== undefined &&
        String(patch.assigneeId || "") !==
          String(existingTask.assigneeId || "");

      if (assigneeChanged) {
        // if current actor changed assignment, treat them as latest assigner
        $set.assignedByUserId = String(me.id || "");
        $set.assignedByName = String(me.name || "User");
      }

      const result = await tasksCollection.findOneAndUpdate(
        { _id: toId(taskId) },
        { $set },
        { returnDocument: "after" },
      );

      await createActivity({
        userId: me.id,
        workspaceId: String(existingTask.workspaceId),
        projectId: existingTask.projectId ? String(existingTask.projectId) : "",
        taskId: String(taskId),
        action: "task_updated",
        text: `${me.name} updated task "${existingTask.title}"`,
      });

      // FIX MONGODB V6 RETURN DOCUMENT ISSUE
      const t = result?.value || result;

      const fromStatusKey = normalizeStatusKey(existingTask.status);
      const toStatusKey = normalizeStatusKey(t.status);

      if (fromStatusKey !== toStatusKey) {
        const recipients = getStatusRecipients({
          workspace,
          task: t,
          actorUserId: me.id,
        });

        for (const userId of recipients) {
          await createNotification({
            userId,
            text: `${me.name || "Someone"} changed "${t.title}" status: ${statusLabel(existingTask.status)} -> ${statusLabel(t.status)}`,
            type: "task_status_changed",
            data: {
              taskId: String(t._id),
              workspaceId: String(t.workspaceId),
              projectId: t.projectId ? String(t.projectId) : "",
              fromStatus: fromStatusKey,
              toStatus: toStatusKey,
              changedByUserId: String(me.id || ""),
              changedByName: String(me.name || "User"),
            },
          });
        }
      }

      if (!t || !t._id)
        return res.status(404).json({ error: "Task not found" });

      // Build the generic update summary without duplicating status notices.
      const changed = getGenericTaskUpdateChanges(patch, existingTask);

      const newAssigneeId = patch.assigneeId ?? existingTask.assigneeId;
      const assigneeUserId = getMemberUserId(workspace, newAssigneeId);

      // notify for meaningful updates OR assignment change, but never notify self
      if (
        assigneeUserId &&
        assigneeUserId !== String(me.id) &&
        (changed.length > 0 || assigneeChanged)
      ) {
        const message = assigneeChanged
          ? `${me.name || "Someone"} assigned you task: ${t.title || existingTask.title}`
          : `${me.name || "Someone"} updated "${existingTask.title}" (${changed.join(", ")})`;

        await createNotification({
          userId: assigneeUserId,
          text: message,
          type: assigneeChanged ? "task_assigned" : "task_updated",
          data: {
            taskId: String(taskId),
            workspaceId: String(existingTask.workspaceId),
          },
        });
      }

      res.json({
        task: {
          id: String(t._id),
          workspaceId: String(t.workspaceId),
          projectId: t.projectId ? String(t.projectId) : "",
          boardId: t.boardId ? String(t.boardId) : "",
          columnId: t.columnId ? String(t.columnId) : "",
          order: Number.isInteger(t.order) ? t.order : 0,
          projectName: t.projectName || "",
          title: t.title,
          description: t.description || "",
          priority: t.priority || "P2",
          status: t.status || "todo",
          dueDate: t.dueDate || "",
          assigneeId: t.assigneeId || "",
          assigneeName: t.assigneeName || "Unassigned",
          ...mapTaskReporter(t),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt || "",
          estimatedTime: Number(t.estimatedTime || 0),
          totalTimeSpent: Number(t.totalTimeSpent || 0),
          remainingTime: Math.max(
            Number(
              t.remainingTime !== undefined
                ? t.remainingTime
                : Number(t.estimatedTime || 0) - Number(t.totalTimeSpent || 0),
            ),
            0,
          ),
          // file attach - helal / bayijid
          attachments: t.attachments || [],
          // file attach - helal / bayijid
        },
      });
    });

    // POST /dashboard/notifications/read-all
    app.post(
      "/dashboard/notifications/read-all",
      verifyToken,
      async (req, res) => {
        const me = getUserIdentity(req);
        await notificationsCollection.updateMany(
          { userId: String(me.id), read: false },
          { $set: { read: true } },
        );
        // Tell every open tab for this user to clear unread notifications.
        if (io) {
          io.to(getUserRoom(String(me.id))).emit("notification:read-all", {
            userId: String(me.id),
            read: true,
            readAt: now(),
          });
        }
        res.json({ ok: true });
      },
    );

    // time tracking api
    const toSeconds = (value, fallback = 0) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return fallback;
      return Math.floor(n);
    };

    const getTaskTimeFields = (task = {}) => {
      const estimatedTime = toSeconds(task.estimatedTime, 0);
      const totalTimeSpent = toSeconds(task.totalTimeSpent, 0);
      const remainingTime = Math.max(
        toSeconds(task.remainingTime, estimatedTime - totalTimeSpent),
        0,
      );
      return { estimatedTime, totalTimeSpent, remainingTime };
    };

    const parseDateValue = (value) => {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      return d;
    };

    const parseBoundaryDate = (value, endOfDay = false) => {
      if (value === undefined || value === null || value === "") return null;
      const raw = String(value).trim();
      const parsed = parseDateValue(raw);
      if (!parsed) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        if (endOfDay) parsed.setUTCHours(23, 59, 59, 999);
        else parsed.setUTCHours(0, 0, 0, 0);
      }
      return parsed;
    };

    // POST /dashboard/tasks/:taskId/time/start
    app.post(
      "/dashboard/tasks/:taskId/time/start",
      verifyToken,
      async (req, res) => {
        const { taskId } = req.params;
        const me = getUserIdentity(req);
        if (!me.id) return res.status(401).json({ error: "Unauthorized" });
        if (!isValidId(taskId))
          return res.status(400).json({ error: "Invalid taskId" });

        const task = await tasksCollection.findOne({ _id: toId(taskId) });
        if (!task) return res.status(404).json({ error: "Task not found" });

        const workspace = await workspacesCollection.findOne({
          _id: toId(task.workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });
        if (!isWorkspaceMember(workspace, me))
          return res.status(403).json({ error: "Forbidden workspace access" });

        const active = await timeLogsCollection.findOne({
          userId: String(me.id),
          endTime: null,
        });

        if (active) {
          return res
            .status(409)
            .json({ error: "You already have an active timer" });
        }

        const startTime = new Date();
        try {
          const result = await timeLogsCollection.insertOne({
            taskId: toId(task._id),
            workspaceId: toId(task.workspaceId),
            projectId: task.projectId ? toId(task.projectId) : null,
            userId: String(me.id),
            startTime,
            endTime: null,
            duration: 0,
            description: String(req.body?.description || "").trim(),
            createdAt: new Date(),
          });
          return res.status(201).json({
            logId: String(result.insertedId),
            startTime,
          });
        } catch (e) {
          if (e?.code === 11000) {
            return res
              .status(409)
              .json({ error: "You already have an active timer" });
          }
          console.error(e);
          return res.status(500).json({ error: "Failed to start timer" });
        }
      },
    );

    // POST /dashboard/time/:logId/stop
    app.post("/dashboard/time/:logId/stop", verifyToken, async (req, res) => {
      const { logId } = req.params;
      const me = getUserIdentity(req);
      if (!me.id) return res.status(401).json({ error: "Unauthorized" });
      if (!isValidId(logId))
        return res.status(400).json({ error: "Invalid logId" });

      const session = client.startSession();
      let duration = 0;
      try {
        await session.withTransaction(async () => {
          const log = await timeLogsCollection.findOne(
            { _id: toId(logId), userId: String(me.id) },
            { session },
          );
          if (!log) throw { status: 404, message: "Time log not found" };
          if (log.endTime)
            throw { status: 400, message: "Timer already stopped" };

          const workspace = await workspacesCollection.findOne(
            { _id: toId(log.workspaceId) },
            { session },
          );
          if (!workspace) throw { status: 404, message: "Workspace not found" };
          if (!isWorkspaceMember(workspace, me))
            throw { status: 403, message: "Forbidden workspace access" };

          const start = parseDateValue(log.startTime);
          if (!start) throw { status: 400, message: "Invalid log startTime" };
          const endTime = new Date();
          duration = Math.max(
            0,
            Math.floor((endTime.getTime() - start.getTime()) / 1000),
          );

          await timeLogsCollection.updateOne(
            { _id: toId(logId) },
            { $set: { endTime, duration } },
            { session },
          );

          const task = await tasksCollection.findOne(
            { _id: toId(log.taskId) },
            { session },
          );
          if (!task) throw { status: 404, message: "Task not found" };

          const time = getTaskTimeFields(task);
          const nextTotalTime = time.totalTimeSpent + duration;
          const nextRemaining = Math.max(time.estimatedTime - nextTotalTime, 0);

          await tasksCollection.updateOne(
            { _id: toId(task._id) },
            {
              $set: {
                totalTimeSpent: nextTotalTime,
                remainingTime: nextRemaining,
                updatedAt: now(),
              },
            },
            { session },
          );
        });

        return res.json({ duration });
      } catch (e) {
        if (e?.status && e?.message) {
          return res.status(e.status).json({ error: e.message });
        }
        console.error(e);
        return res.status(500).json({ error: "Failed to stop timer" });
      } finally {
        await session.endSession();
      }
    });

    // GET /dashboard/tasks/:taskId/time
    app.get("/dashboard/tasks/:taskId/time", verifyToken, async (req, res) => {
      const { taskId } = req.params;
      const me = getUserIdentity(req);
      if (!isValidId(taskId))
        return res.status(400).json({ error: "Invalid taskId" });

      const task = await tasksCollection.findOne({ _id: toId(taskId) });
      if (!task) return res.status(404).json({ error: "Task not found" });

      const workspace = await workspacesCollection.findOne({
        _id: toId(task.workspaceId),
      });
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      if (!isWorkspaceMember(workspace, me))
        return res.status(403).json({ error: "Forbidden workspace access" });

      const logs = await timeLogsCollection
        .find({ taskId: toId(taskId) })
        .sort({ startTime: -1 })
        .toArray();

      return res.json(
        logs.map((l) => ({
          id: String(l._id),
          userId: String(l.userId || ""),
          startTime: l.startTime || null,
          endTime: l.endTime || null,
          duration: toSeconds(l.duration, 0),
        })),
      );
    });

    // GET /dashboard/time/active
    app.get("/dashboard/time/active", verifyToken, async (req, res) => {
      const me = getUserIdentity(req);
      if (!me.id) return res.status(401).json({ error: "Unauthorized" });

      const active = await timeLogsCollection.findOne(
        {
          userId: String(me.id),
          endTime: null,
        },
        { sort: { startTime: -1 } },
      );

      if (!active) return res.json({ activeTimer: null });

      return res.json({
        activeTimer: {
          id: String(active._id),
          taskId: String(active.taskId),
          workspaceId: String(active.workspaceId),
          projectId: active.projectId ? String(active.projectId) : "",
          userId: String(active.userId || ""),
          startTime: active.startTime || null,
          endTime: null,
          duration: toSeconds(active.duration, 0),
          description: active.description || "",
        },
      });
    });

    // POST /dashboard/tasks/:taskId/time/manual
    app.post(
      "/dashboard/tasks/:taskId/time/manual",
      verifyToken,
      async (req, res) => {
        const { taskId } = req.params;
        const me = getUserIdentity(req);
        if (!me.id) return res.status(401).json({ error: "Unauthorized" });
        if (!isValidId(taskId))
          return res.status(400).json({ error: "Invalid taskId" });

        const { startTime, endTime, description = "" } = req.body || {};
        const startAt = parseDateValue(startTime);
        const endAt = parseDateValue(endTime);
        if (!startAt || !endAt) {
          return res
            .status(400)
            .json({ error: "startTime and endTime must be valid dates" });
        }
        if (endAt <= startAt) {
          return res
            .status(400)
            .json({ error: "endTime must be greater than startTime" });
        }

        const task = await tasksCollection.findOne({ _id: toId(taskId) });
        if (!task) return res.status(404).json({ error: "Task not found" });

        const workspace = await workspacesCollection.findOne({
          _id: toId(task.workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });
        if (!isWorkspaceMember(workspace, me))
          return res.status(403).json({ error: "Forbidden workspace access" });

        const duration = Math.max(
          0,
          Math.floor((endAt.getTime() - startAt.getTime()) / 1000),
        );

        const session = client.startSession();
        let insertedLogId = null;
        try {
          await session.withTransaction(async () => {
            const insertResult = await timeLogsCollection.insertOne(
              {
                taskId: toId(task._id),
                workspaceId: toId(task.workspaceId),
                projectId: task.projectId ? toId(task.projectId) : null,
                userId: String(me.id),
                startTime: startAt,
                endTime: endAt,
                duration,
                description: String(description).trim(),
                createdAt: new Date(),
              },
              { session },
            );
            insertedLogId = insertResult.insertedId;

            const taskInside = await tasksCollection.findOne(
              { _id: toId(task._id) },
              { session },
            );
            if (!taskInside) throw { status: 404, message: "Task not found" };

            const time = getTaskTimeFields(taskInside);
            const nextTotalTime = time.totalTimeSpent + duration;
            const nextRemaining = Math.max(
              time.estimatedTime - nextTotalTime,
              0,
            );

            await tasksCollection.updateOne(
              { _id: toId(task._id) },
              {
                $set: {
                  totalTimeSpent: nextTotalTime,
                  remainingTime: nextRemaining,
                  updatedAt: now(),
                },
              },
              { session },
            );
          });

          return res.status(201).json({
            logId: String(insertedLogId),
            duration,
          });
        } catch (e) {
          if (e?.status && e?.message) {
            return res.status(e.status).json({ error: e.message });
          }
          console.error(e);
          return res.status(500).json({ error: "Failed to save manual time" });
        } finally {
          await session.endSession();
        }
      },
    );

    // GET /dashboard/reports/timesheet
    app.get("/dashboard/reports/timesheet", verifyToken, async (req, res) => {
      const me = getUserIdentity(req);
      if (!me.id) return res.status(401).json({ error: "Unauthorized" });

      const { userId = "", startDate = "", endDate = "" } = req.query || {};
      const targetUserId = String(userId || me.id);
      const startAt = parseBoundaryDate(startDate);
      const endAt = parseBoundaryDate(endDate, true);

      if (startDate && !startAt)
        return res.status(400).json({ error: "Invalid startDate" });
      if (endDate && !endAt)
        return res.status(400).json({ error: "Invalid endDate" });
      if (startAt && endAt && startAt > endAt) {
        return res
          .status(400)
          .json({ error: "startDate must be before or equal to endDate" });
      }

      let workspaceFilter = null;
      if (targetUserId !== String(me.id)) {
        const adminWorkspaces = await workspacesCollection
          .find({
            members: {
              $elemMatch: {
                userId: String(me.id),
                role: "admin",
              },
            },
          })
          .toArray();

        const sharedWorkspaceIds = adminWorkspaces
          .filter((w) =>
            (w.members || []).some(
              (m) => String(m.userId || "") === String(targetUserId),
            ),
          )
          .map((w) => toId(w._id));

        if (!sharedWorkspaceIds.length) {
          return res.status(403).json({ error: "Forbidden timesheet access" });
        }
        workspaceFilter = { $in: sharedWorkspaceIds };
      }

      const match = {
        userId: targetUserId,
        endTime: { $ne: null },
      };
      if (workspaceFilter) match.workspaceId = workspaceFilter;
      if (startAt || endAt) {
        match.startTime = {};
        if (startAt) match.startTime.$gte = startAt;
        if (endAt) match.startTime.$lte = endAt;
      }

      const data = await timeLogsCollection
        .aggregate([
          { $match: match },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$startTime",
                  timezone: "UTC",
                },
              },
              totalTime: { $sum: { $ifNull: ["$duration", 0] } },
            },
          },
          { $sort: { _id: 1 } },
          {
            $project: {
              _id: 0,
              date: "$_id",
              totalTime: { $toInt: "$totalTime" },
            },
          },
        ])
        .toArray();

      return res.json(data);
    });

    // GET /dashboard/reports/project/:projectId
    app.get(
      "/dashboard/reports/project/:projectId",
      verifyToken,
      async (req, res) => {
        const { projectId } = req.params;
        const me = getUserIdentity(req);
        if (!isValidId(projectId))
          return res.status(400).json({ error: "Invalid projectId" });

        const project = await projectsCollection.findOne({
          _id: toId(projectId),
        });
        if (!project)
          return res.status(404).json({ error: "Project not found" });

        const workspace = await workspacesCollection.findOne({
          _id: toId(project.workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });
        if (!isWorkspaceMember(workspace, me))
          return res.status(403).json({ error: "Forbidden workspace access" });

        const rows = await timeLogsCollection
          .aggregate([
            {
              $match: {
                projectId: toId(projectId),
                endTime: { $ne: null },
              },
            },
            {
              $group: {
                _id: "$userId",
                totalTime: { $sum: { $ifNull: ["$duration", 0] } },
              },
            },
            { $sort: { totalTime: -1 } },
            {
              $project: {
                _id: 0,
                userId: "$_id",
                totalTime: { $toInt: "$totalTime" },
              },
            },
          ])
          .toArray();

        return res.json(rows);
      },
    );

    // GET /dashboard/reports/workspace/:workspaceId
    app.get(
      "/dashboard/reports/workspace/:workspaceId",
      verifyToken,
      async (req, res) => {
        const { workspaceId } = req.params;
        const me = getUserIdentity(req);
        if (!isValidId(workspaceId))
          return res.status(400).json({ error: "Invalid workspaceId" });

        const workspace = await workspacesCollection.findOne({
          _id: toId(workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });
        if (!isWorkspaceMember(workspace, me))
          return res.status(403).json({ error: "Forbidden workspace access" });

        const rows = await timeLogsCollection
          .aggregate([
            {
              $match: {
                workspaceId: toId(workspaceId),
                endTime: { $ne: null },
              },
            },
            {
              $group: {
                _id: "$projectId",
                totalTime: { $sum: { $ifNull: ["$duration", 0] } },
              },
            },
            { $sort: { totalTime: -1 } },
          ])
          .toArray();

        const projectIds = rows
          .map((r) => r._id)
          .filter((id) => !!id)
          .map((id) => toId(id));
        const projects = projectIds.length
          ? await projectsCollection
              .find({ _id: { $in: projectIds } })
              .toArray()
          : [];
        const projectNameMap = new Map(
          projects.map((p) => [String(p._id), p.name || ""]),
        );

        return res.json(
          rows.map((r) => ({
            projectId: r._id ? String(r._id) : "",
            projectName: r._id ? projectNameMap.get(String(r._id)) || "" : "",
            totalTime: toSeconds(r.totalTime, 0),
          })),
        );
      },
    );

    // GET /dashboard/reports/task/:taskId
    app.get(
      "/dashboard/reports/task/:taskId",
      verifyToken,
      async (req, res) => {
        const { taskId } = req.params;
        const me = getUserIdentity(req);
        if (!isValidId(taskId))
          return res.status(400).json({ error: "Invalid taskId" });

        const task = await tasksCollection.findOne({ _id: toId(taskId) });
        if (!task) return res.status(404).json({ error: "Task not found" });

        const workspace = await workspacesCollection.findOne({
          _id: toId(task.workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });
        if (!isWorkspaceMember(workspace, me))
          return res.status(403).json({ error: "Forbidden workspace access" });

        const logs = await timeLogsCollection
          .find({ taskId: toId(taskId) })
          .sort({ startTime: -1 })
          .toArray();

        const time = getTaskTimeFields(task);
        return res.json({
          estimatedTime: time.estimatedTime,
          totalTimeSpent: time.totalTimeSpent,
          remainingTime: time.remainingTime,
          logs: logs.map((l) => ({
            id: String(l._id),
            userId: String(l.userId || ""),
            startTime: l.startTime || null,
            endTime: l.endTime || null,
            duration: toSeconds(l.duration, 0),
            description: l.description || "",
          })),
        });
      },
    );

    app.get(
      "/dashboard/tasks/:taskId/time-summary",
      verifyToken,
      async (req, res) => {
        const { taskId } = req.params;

        const task = await tasksCollection.findOne({ _id: toId(taskId) });

        if (!task) return res.status(404).json({ error: "Task not found" });

        const estimated = Number(task.estimatedTime || 0);
        const spent = Number(task.totalTimeSpent || 0);
        const remaining = Math.max(estimated - spent, 0);

        const progress = estimated ? Math.round((spent / estimated) * 100) : 0;

        res.json({
          estimated,
          spent,
          remaining,
          progress,
        });
      },
    );

    // Invite Feature--------->Rifat_START

    // get all invites for a workspace.
    app.get(
      "/workspaces/:workspaceId/invites",
      verifyToken,
      async (req, res) => {
        try {
          const { workspaceId } = req.params;
          const me = getUserIdentity(req);

          // isValidId--> checks valid workspaceId
          if (!isValidId(workspaceId)) {
            return res
              .status(400)
              .json({ ok: false, message: "Invalid workspace id" });
          }

          // find the workspace
          // toId--> converts to ObjectId
          const workspace = await workspacesCollection.findOne({
            _id: toId(workspaceId),
          });
          if (!workspace) {
            return res
              .status(404)
              .json({ ok: false, message: "Workspace not found" });
          }
          // Admin-only: invite management belongs to workspace admins.
          if (!isWorkspaceAdmin(workspace, me)) {
            return res.status(403).json({ ok: false, message: "Forbidden" });
          }

          // finds all invites under a workspace
          const invites = await inviteCollection
            .find({ workspaceId })
            .sort({ createdAt: -1 })
            .toArray();

          // UI-friendly response: include workspace.members with id/name/email/role.
          return res.json({
            ok: true,
            workspace: {
              id: String(workspace._id),
              name: workspace.name,
              // workspace members are in a arr
              members: (workspace.members || []).map((member) => ({
                id: member.id || member.userId || new ObjectId().toString(),
                name:
                  member.name ||
                  (member.email ? member.email.split("@")[0] : "Member"),
                email: member.email || "",
                role: member.role || "Member",
              })),
            },
            invites,
          });
        } catch (error) {
          console.error(error);
          return res.status(500).json({ ok: false, message: "Server error" });
        }
      },
    );

    // post invites
    app.post(
      "/workspaces/:workspaceId/invites",
      verifyToken,
      async (req, res) => {
        try {
          const clientSideData = inviteSchema.parse(req.body);
          const role = clientSideData.role;
          const email = normalizeEmail(clientSideData.email);
          const { workspaceId } = req.params;
          const me = getUserIdentity(req);

          // Checks valid workspace
          if (!isValidId(workspaceId)) {
            return res
              .status(400)
              .json({ ok: false, message: "Invalid workspace id" });
          }
          // find the workspace
          const workspace = await workspacesCollection.findOne({
            _id: toId(workspaceId),
          });

          if (!workspace) {
            return res
              .status(404)
              .json({ ok: false, message: "Workspace not found" });
          }
          if (!isWorkspaceAdmin(workspace, me)) {
            return res.status(403).json({ ok: false, message: "Forbidden" });
          }
          // generate random token for URL and hashed version for DB
          const rawToken = crypto.randomBytes(32).toString("hex");
          const hashedToken = crypto
            .createHash("sha256")
            .update(rawToken)
            .digest("hex");

          // Create a Link to send via Email/Console
          const frontendURL =
            process.env.FRONTEND_URL || "http://localhost:3000";
          const inviteLink = `${frontendURL}/accept-invite/${rawToken}`;

          // find if the user is already a member
          const existingMember = isWorkspaceMember(workspace, {
            id: "",
            email,
          });

          // do this if found in existing workspace
          if (existingMember) {
            return res.status(409).json({
              ok: false,
              message: "User is already in workspace",
            });
          }

          // find if the user is already invited
          const existingInvite = await inviteCollection.findOne({
            email,
            workspaceId,
            status: "pending",
            expiresAt: { $gt: new Date() },
          });

          // do this if found in existing db
          if (existingInvite) {
            return res.status(409).json({
              ok: false,
              message: "Invite already sent",
              expiresAt: existingInvite.expiresAt,
            });
          }

          //  invite data for db
          const inviteData = {
            email,
            role,
            workspaceId,
            workspaceName: workspace.name,
            status: "pending",
            token: hashedToken,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
          };

          // send invite data to db
          const result = await inviteCollection.insertOne(inviteData);

          // After invite data is stored, send invite email via Gmail SMTP.
          try {
            await sendInviteEmail({
              to: email,
              subject: `You're invited to join ${workspace.name}`,
              html: `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        /* Responsive styles for mobile clients */
        @media only screen and (max-width: 600px) {
          .container { width: 100% !important; border-radius: 0 !important; border: none !important; }
          .content { padding: 30px 20px !important; }
          .button { width: 100% !important; text-align: center; display: block !important; box-sizing: border-box; }
        }
      </style>
    </head>
    <body style="margin:0;padding:0;background-color:#f4f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:#f4f7fa;padding:40px 0;">
        <tr>
          <td align="center">
            <table class="container" width="560" border="0" cellspacing="0" cellpadding="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 10px 15px -3px rgba(0,0,0,0.1);border:1px solid #e5e7eb;">
              
              <tr>
                <td class="content" style="padding:40px 40px 0 40px;">
                  <img src="https://res.cloudinary.com/dsyahfiyo/image/upload/v1772881604/logo1_b7iv2u.png" 
                       alt="${workspace.name}" 
                       width="48" 
                       style="display:block; border:0; outline:none; text-decoration:none; max-width:120px; height:auto;">
                </td>
              </tr>

              <tr>
                <td class="content" style="padding:32px 40px 40px 40px;">
                  <h1 style="margin:0 0 16px;font-size:24px;font-weight:700;color:#111827;line-height:1.2;">
                    Join the workspace
                  </h1>
                  <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#4b5563;">
                    Hi there! You've been invited to join <strong>${workspace.name}</strong> as a 
                    <span style="background:#f3f4f6;color:#111827;padding:2px 8px;border-radius:4px;font-weight:600;font-size:14px;text-transform:capitalize;">${role}</span>.
                  </p>
                  <p style="margin:0 0 32px;font-size:16px;line-height:1.6;color:#4b5563;">
                    Collaborate with your team, manage projects, and stay updated—all in one place.
                  </p>
                  
                  <a href="${inviteLink}" class="button" style="display:inline-block;background-color:#4f46e5;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 30px;border-radius:8px;">
                    Accept Invitation
                  </a>
                </td>
              </tr>

              <tr>
                <td style="padding:30px 40px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
                  <p style="margin:0 0 10px;font-size:12px;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;font-weight:700;">
                    Trouble with the button?
                  </p>
                  <p style="margin:0;font-size:13px;line-height:1.5;word-break:break-all;">
                    <a href="${inviteLink}" style="color:#4f46e5;text-decoration:none;">${inviteLink}</a>
                  </p>
                </td>
              </tr>
            </table>

            <table width="560" class="container" border="0" cellspacing="0" cellpadding="0">
              <tr>
                <td style="padding:24px 10px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.4;">
                    This invitation was sent to you by ${workspace.name}.<br>
                    If you weren't expecting this, you can safely ignore this email.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `,
            });
          } catch (mailError) {
            // Keep invite creation successful even if email sending fails.
            console.error("SMTP send failed:", mailError?.message || mailError);
          }

          // send response to frontend
          return res.status(201).json({
            ok: true,
            inviteLink,
            message: "Invite created!",
            workspaceName: workspace.name,
            status: inviteData.status,
            expiresAt: inviteData.expiresAt,
          });
        } catch (error) {
          // catch zod error
          if (error instanceof z.ZodError) {
            return res.status(400).json({
              ok: false,
              message: "Validation failed",
              errors: error,
            });
          }
          // catch and send other error
          console.error(error);
          return res.status(500).json({ ok: false, message: "Server error" });
        }
      },
    );

    // check valid invitation
    app.get("/invites/:token", async (req, res) => {
      try {
        const { token } = req.params;

        const hashedToken = crypto
          .createHash("sha256")
          .update(token)
          .digest("hex");

        // check token existence in db
        const findInvite = await inviteCollection.findOne({
          token: hashedToken,
        });

        // if not found --> Invalid token
        if (!findInvite)
          return res.status(404).json({ message: "Invalid Token", ok: false });

        // check for invite status
        if (findInvite.status !== "pending")
          return res
            .status(409)
            .json({ message: "Invite has been used", ok: false });

        //  check for invite expiry
        if (findInvite.expiresAt < new Date())
          return res
            .status(400)
            .json({ message: "Invite has been expired!", ok: false });

        //return response to frontend
        return res.json({
          ok: true,
          invite: {
            inviteeEmail: findInvite.email,
            workspaceName: findInvite.workspaceName || "",
            role: findInvite.role,
            status: findInvite.status,
            expiresAt: findInvite.expiresAt,
            workspace: findInvite.workspaceId,
          },
          expired: false,
        });
      } catch (error) {
        console.error(error);
        return res.status(500).json({ ok: false, message: "Server error" });
      }
    });

    // accept invitation and update workspace member
    app.post("/invites/:choice", verifyToken, async (req, res) => {
      const { choice } = req.params;
      const { token } = req.body;
      const me = getUserIdentity(req);

      // check if token is sent
      if (!token)
        return res.status(400).json({ message: "Invalid Token", ok: false });

      // choice = accept/reject -> accept adds the invitee to db & reject 'revoke' the invitee status
      // accept validation check
      if (choice !== "accept" && choice !== "reject") {
        return res.status(400).json({
          ok: false,
          message: "Invalid option",
        });
      }

      // again...token hash
      const hashedToken = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      // revoke invitee status
      if (choice === "reject") {
        const findInvitee = await inviteCollection.findOneAndUpdate(
          // find valid invitee by token, status & expires at
          {
            token: hashedToken,
            status: "pending",
            expiresAt: { $gt: new Date() },
          },
          // update status --> revoked, add revoked date
          {
            $set: {
              status: "revoked",
              revokedAt: new Date(),
            },
          },
          // return updated document
          {
            returnDocument: "after",
          },
        );

        // if revoking fails for some reason
        if (!findInvitee.value) {
          return res.status(404).json({
            ok: false,
            message: "Invite not found or already processed",
          });
        }

        // revoking response sent to frontend
        return res
          .status(200)
          .json({ message: "Invitation Rejected/Revoked", ok: true });
      }

      //  Now if the user accept the invitation...
      const userEmail = normalizeEmail(me.email);
      if (!me.id) {
        return res.status(400).json({
          message: "User id is required",
          ok: false,
        });
      }

      // find the invitation
      const findInvite = await inviteCollection.findOne({
        token: hashedToken,
        status: "pending",
      });

      //  if the invitation is not found
      if (!findInvite)
        return res
          .status(404)
          .json({ message: "Invite Not Found!", ok: false });

      // if the invitation is expired...
      if (findInvite.expiresAt < new Date()) {
        return res.status(400).json({
          message: "Invite has been expired!",
          ok: false,
        });
      }

      // if invitee email and user email doesn't match
      if (normalizeEmail(findInvite.email) !== userEmail)
        return res.status(403).json({
          message: `Please use ${findInvite.email} to accept the invitation `,
          ok: false,
        });
      // I don't think this block needs to exist because we already verify it once when the user is invited
      const workspaceFilter = isValidId(findInvite.workspaceId)
        ? { _id: toId(findInvite.workspaceId) }
        : { _id: null };
      const findUser = await workspacesCollection.findOne({
        ...workspaceFilter,
        "members.email": userEmail,
      });

      if (findUser)
        return res
          .status(409)
          .json({ message: "User already exist!", ok: false });

      // invitee's workspace member data
      const member = {
        id: new ObjectId().toString(),
        userId: String(me.id),
        name: me.name || userEmail.split("@")[0] || "Member",
        email: userEmail,
        role: findInvite.role,
      };

      // add invitee to the workspace db
      const addMember = await workspacesCollection.updateOne(
        { ...workspaceFilter, "members.email": { $ne: userEmail } },
        { $push: { members: member } },
      );

      // if failed to add
      if (!addMember.modifiedCount) {
        return res.status(409).json({
          message: "Could not add user to workspace",
          ok: false,
        });
      }
      // update invite collection db
      const query = await inviteCollection.findOneAndUpdate(
        { token: hashedToken, status: "pending" },
        { $set: { status: "accepted" } },
        { returnDocument: "after" },
      );

      // frontend response
      return res.json({
        message: "Invite Accepted",
        ok: true,
        query,
      });
    });

    // delete a sent invite
    app.delete(
      "/workspaces/:workspaceId/invites/:inviteId",
      verifyToken,
      async (req, res) => {
        try {
          const { workspaceId, inviteId } = req.params;
          const me = getUserIdentity(req);

          if (!isValidId(workspaceId) || !isValidId(inviteId)) {
            return res
              .status(400)
              .json({ ok: false, message: "Invalid id provided" });
          }

          const workspace = await workspacesCollection.findOne({
            _id: toId(workspaceId),
          });
          if (!workspace) {
            return res
              .status(404)
              .json({ ok: false, message: "Workspace not found" });
          }
          if (!isWorkspaceAdmin(workspace, me)) {
            return res.status(403).json({
              ok: false,
              message: "Only admin can delete invites",
            });
          }

          const result = await inviteCollection.deleteOne({
            _id: toId(inviteId),
            workspaceId,
          });
          if (!result.deletedCount) {
            return res
              .status(404)
              .json({ ok: false, message: "Invite not found" });
          }

          return res.json({
            ok: true,
            message: "Invite deleted",
          });
        } catch (error) {
          console.error(error);
          return res.status(500).json({ ok: false, message: "Server error" });
        }
      },
    );

    app.patch(
      "/dashboard/workspaces/:workspaceId/members/:memberId",
      verifyToken,
      async (req, res) => {
        const { workspaceId, memberId } = req.params;
        if (!isValidId(workspaceId) || !String(memberId || "").trim())
          return res.status(400).json({ error: "Invalid id provided" });
        const nextRoleResult = inviteSchema.shape.role.safeParse(
          String(req.body?.role || "")
            .trim()
            .toLowerCase(),
        );
        if (!nextRoleResult.success)
          return res.status(400).json({ error: "Invalid member role" });
        const nextRole = nextRoleResult.data;

        const me = getUserIdentity(req);
        const workspace = await workspacesCollection.findOne({
          _id: toId(workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });
        if (!isWorkspaceAdmin(workspace, me))
          return res
            .status(403)
            .json({ error: "Only admin can update members" });

        const member = getWorkspaceMemberById(workspace, memberId);
        if (!member) return res.status(404).json({ error: "Member not found" });

        if (isLastWorkspaceAdmin(workspace, member, nextRole)) {
          return res
            .status(400)
            .json({ error: "This workspace must keep at least one admin." });
        }

        if (String(member.role || "").toLowerCase() === nextRole) {
          return res.json({ member: { ...member, role: nextRole } });
        }

        const memberKey = String(member.id || member.userId || "");
        await workspacesCollection.updateOne(
          { _id: toId(workspaceId) },
          {
            $set: {
              members: (workspace.members || []).map((currentMember) =>
                String(currentMember.id || currentMember.userId || "") ===
                memberKey
                  ? { ...currentMember, role: nextRole }
                  : currentMember,
              ),
            },
          },
        );

        return res.json({ member: { ...member, role: nextRole } });
      },
    );

    app.delete(
      "/dashboard/workspaces/:workspaceId/members/:memberId",
      verifyToken,
      async (req, res) => {
        const { workspaceId, memberId } = req.params;
        if (!isValidId(workspaceId) || !String(memberId || "").trim())
          return res.status(400).json({ error: "Invalid id provided" });
        const me = getUserIdentity(req);

        const workspace = await workspacesCollection.findOne({
          _id: toId(workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });
        if (!isWorkspaceAdmin(workspace, me))
          return res
            .status(403)
            .json({ error: "Only admin can remove members" });

        const member = getWorkspaceMemberById(workspace, memberId);
        if (!member) return res.status(404).json({ error: "Member not found" });

        if (isLastWorkspaceAdmin(workspace, member)) {
          return res
            .status(400)
            .json({ error: "This workspace must keep at least one admin." });
        }

        const memberKey = String(member.id || member.userId || "");
        await workspacesCollection.updateOne(
          { _id: toId(workspaceId) },
          {
            $pull: {
              members: {
                $or: [{ id: memberKey }, { userId: memberKey }],
              },
            },
          },
        );

        return res.json({ ok: true });
      },
    );

    // Invite Feature--------->Rifat_END

    // Github WebHook ----------> Rifat Start

    app.post("/github/webhook", async (req, res) => {
      // Verify signature
      if (!verifyGithubWebhookSignature(req)) {
        return res.status(401).json({ error: "Invalid signature" });
      }

      const githubEventType = req.headers["x-github-event"];
      if (!githubEventType)
        return res.status(400).json({ error: "Missing x-github-event header" });

      const eventHandler = githubEventHandlers[githubEventType];
      if (!eventHandler)
        return res
          .status(200)
          .json({ message: `Event "${githubEventType}" not handled` });

      await eventHandler(req.body);
      return res
        .status(200)
        .json({ message: `Event "${githubEventType}" processed` });
    });

    // GitHub redirects the user back to the app after installation.
    // This must be protected; otherwise anyone could connect an installation to any workspaceId.
    app.get("/github/callback", verifyToken, async (req, res) => {
      const { installation_id, state } = req.query;

      if (!installation_id) {
        return res.status(400).json({ error: "Missing installation_id" });
      }

      // state contains the workspaceId we passed when redirecting to GitHub
      const workspaceId = state;

      if (!workspaceId) {
        return res.status(400).json({ error: "Missing workspace state" });
      }

      if (!isValidId(workspaceId)) {
        return res.status(400).json({ error: "Invalid workspace state" });
      }

      const me = getUserIdentity(req);
      const workspace = await workspacesCollection.findOne({
        _id: toId(workspaceId),
      });
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      if (!isWorkspaceAdmin(workspace, me)) {
        return res.status(403).json({ error: "Only admin can connect GitHub" });
      }

      // Save or update the installation for this workspace
      await githubInstallationsCollection.updateOne(
        { workspaceId: workspaceId },
        {
          $set: {
            workspaceId: workspaceId,
            installationId: String(installation_id),
            connectedAt: now(),
          },
        },
        { upsert: true },
      );

      // Redirect back to the workspace settings page
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard?github=connected`,
      );
    });

    app.get("/dashboard/github/status", verifyToken, async (req, res) => {
      const { workspaceId } = req.query;
      if (!workspaceId)
        return res.status(400).json({ error: "Missing workspaceId" });
      if (!isValidId(workspaceId))
        return res.status(400).json({ error: "Invalid workspaceId" });

      const me = getUserIdentity(req);
      const workspace = await workspacesCollection.findOne({
        _id: toId(workspaceId),
      });
      if (!workspace)
        return res.status(404).json({ error: "Workspace not found" });
      if (!isWorkspaceMember(workspace, me)) {
        return res.status(403).json({ error: "Forbidden workspace access" });
      }

      const installation = await githubInstallationsCollection.findOne({
        workspaceId,
      });
      return res.json({
        connected: Boolean(installation),
        connectedAt: installation?.connectedAt || null,
        installationId: installation?.installationId || null,
      });
    });

    app.delete(
      "/dashboard/github/disconnect",
      verifyToken,
      async (req, res) => {
        const { workspaceId } = req.body;
        if (!workspaceId)
          return res.status(400).json({ error: "Missing workspaceId" });

        // Check user is admin of this workspace
        const workspace = await workspacesCollection.findOne({
          _id: toId(workspaceId),
        });
        if (!workspace)
          return res.status(404).json({ error: "Workspace not found" });

        const member = workspace.members?.find(
          (m) => String(m.userId) === String(req.user?.id || req.user?._id),
        );
        if (!member || member.role !== "admin") {
          return res
            .status(403)
            .json({ error: "Only admins can disconnect GitHub" });
        }

        await githubInstallationsCollection.deleteOne({ workspaceId });

        return res.json({ success: true });
      },
    );

    app.get("/dashboard/tasks/:taskId/activities", async (req, res) => {
      const { taskId } = req.params;
      const activities = await activitiesCollection
        .find({ taskId: taskId, action: { $regex: "^github_" } })
        .sort({ createdAt: -1 })
        .toArray();
      return res.json(activities);
    });

    // Github WebHook ----------> Rifat End

    // POST /api/comments- Lipi Start-----------------------------------------------------------

    app.get("/dashboard/tasks/:id", async (req, res) => {
      const { id } = req.params;

      const result = await tasksCollection.findOne({
        _id: new ObjectId(id),
      });

      res.json({
        result,
      });
    });

    // POST ROUTE: Add a comment to a specific task
    app.post("/dashboard/:id/comments", async (req, res) => {
      try {
        const { id } = req.params;
        const { text, author } = req.body;

        const commentData = {
          taskId: id,
          text: text,
          author: author || "Anonymous",
          createdAt: new Date().toISOString(),
        };

        const result = await commentsCollection.insertOne(commentData);

        res.json({
          ok: true,
          data: {
            ...commentData,
            id: result.insertedId,
          },
        });
      } catch (err) {
        console.error("POST Comment Error:", err);
        res.status(500).json({ error: "Failed to post comment" });
      }
    });

    // GET ROUTE: Fetch all comments for a specific task
    app.get("/dashboard/comments/:taskId", async (req, res) => {
      try {
        const { taskId } = req.params;

        const comments = await commentsCollection
          .find({ taskId: taskId })
          .sort({ createdAt: -1 })
          .toArray();

        // ←←← new added
        const formattedComments = comments.map((comment) => ({
          ...comment,
          id: comment._id.toString(),
          _id: undefined,
        }));

        return res.json(formattedComments);
      } catch (err) {
        console.error("GET Comments Error:", err);
        res.status(500).json({ error: "Server error" });
      }
    });

    // ===============================================
    // NEW: EDIT COMMENT (PUT)
    // ===============================================
    app.put("/dashboard/:taskId/comments/:commentId", async (req, res) => {
      try {
        const { taskId, commentId } = req.params;
        const { text } = req.body;

        if (!text || text.trim() === "") {
          return res.status(400).json({ error: "Comment text is required" });
        }

        const result = await commentsCollection.updateOne(
          {
            _id: new ObjectId(commentId),
            taskId: taskId,
          },
          {
            $set: {
              text: text.trim(),
              updatedAt: new Date().toISOString(),
            },
          },
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Comment not found" });
        }

        res.json({
          ok: true,
          message: "Comment updated successfully",
        });
      } catch (err) {
        console.error("PUT Comment Error:", err);
        res.status(500).json({ error: "Failed to update comment" });
      }
    });

    // ===============================================
    // NEW: DELETE COMMENT (DELETE)
    // ===============================================
    app.delete("/dashboard/:taskId/comments/:commentId", async (req, res) => {
      try {
        const { taskId, commentId } = req.params;

        const result = await commentsCollection.deleteOne({
          _id: new ObjectId(commentId),
          taskId: taskId,
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({ error: "Comment not found" });
        }

        res.json({
          ok: true,
          message: "Comment deleted successfully",
        });
      } catch (err) {
        console.error("DELETE Comment Error:", err);
        res.status(500).json({ error: "Failed to delete comment" });
      }
    });
    // ------------------------------Lipi end--------------------------------------------

    // ------------------------------Lipi end--------------------------------------------

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log(
    //   "Pinged your deployment. You successfully connected to MongoDB!",
    // );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}

app.get("/", (req, res) => {
  res.send("Zyplo server is running!");
});

if (process.env.NODE_ENV !== "test") {
  run().catch(console.dir);

  // Start one HTTP server for both REST and Socket.IO.
  const server = app.listen(port, () => {
    console.log(`Zyplo is listening on port ${port}`);
  });

  attachSocketServer(server);
}

module.exports = {
  attachSocketServer,
  getGenericTaskUpdateChanges,
  getUserRoom,
};

// if (process.env.NODE_ENV !== "production") {
//   app.listen(port, () => {
//     console.log(`Zyplo is listening on port ${port}`);
//   });
// }

// module.exports = app;
// const serverless = require("serverless-http");
// module.exports = serverless(app);
