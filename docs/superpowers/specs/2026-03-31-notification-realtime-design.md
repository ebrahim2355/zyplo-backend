# Notification Realtime Design

## Goal

Add Socket.IO-based realtime delivery for personal notifications in the Render-hosted backend without changing the existing REST bootstrap flow. This first slice should be small enough to study independently before extending realtime to project task views.

## Current Project Context

- The backend is a single Express server in [`index.js`](/home/rifat/projects/zyplo-backend/index.js).
- Authentication already uses JWTs through the `verifyToken` middleware.
- Notifications are stored in MongoDB through the `notifications` collection and created by the `createNotification` helper.
- The dashboard initially loads notifications through `GET /dashboard/bootstrap`.
- The repo was previously configured for Vercel serverless, but the active deployment target is now Render, so a long-lived websocket server is viable.

## Scope

This design covers only user-specific realtime notifications.

Included:

- Start a Socket.IO server alongside Express.
- Authenticate socket connections with the existing JWT secret.
- Join each socket to a user-scoped room.
- Emit `notification:new` when a notification is created.
- Emit `notification:read-all` when a user marks all notifications as read.
- Keep REST as the source of truth for initial page load and reconnect recovery.

Not included:

- Project-scoped task rooms.
- Realtime kanban, list, or calendar synchronization.
- Presence, typing, or cursor indicators.
- Delivery guarantees beyond normal reconnect + REST refresh.

## Chosen Approach

Use a hybrid REST + Socket.IO design.

- REST remains responsible for initial data load via `GET /dashboard/bootstrap`.
- Socket.IO delivers live notification deltas after the client connects.
- The backend emits normalized notification payloads directly from server-side write paths rather than having the frontend poll.

This approach fits the current codebase because the existing API already returns normalized dashboard data, and it avoids redesigning the app around websockets.

## Architecture

### Server bootstrap

Replace the direct `app.listen(...)` startup with an `http.createServer(app)` wrapper and attach a Socket.IO server to that HTTP server. Keep the current Express middleware and routes unchanged unless they need to emit realtime events.

### Socket authentication

Clients connect with the same JWT already used for HTTP requests. The token will be sent in the socket handshake auth payload. A Socket.IO middleware will:

1. Read the token from `socket.handshake.auth.token` or an equivalent fallback.
2. Verify it with `process.env.NEXTAUTH_SECRET`.
3. Extract the user identity.
4. Reject the connection if the token is missing or invalid.

This keeps socket auth aligned with the backend's existing authentication model.

### Room model

Each authenticated socket joins a personal room:

- `user:<userId>`

If the same user has multiple tabs open, all tabs join the same room. This lets the server update the notification list and unread state across tabs with one emit.

## Event Contract

### `notification:new`

Emitted to `user:<userId>` immediately after a notification is stored.

Payload shape:

```json
{
  "id": "mongo-id",
  "userId": "user-id",
  "text": "Someone assigned you: Fix login flow",
  "type": "task_assigned",
  "data": {
    "taskId": "task-id",
    "workspaceId": "workspace-id",
    "projectId": "project-id"
  },
  "read": false,
  "createdAt": "2026-03-31T04:40:00.000Z"
}
```

### `notification:read-all`

Emitted to `user:<userId>` after the backend marks unread notifications as read.

Payload shape:

```json
{
  "userId": "user-id",
  "read": true,
  "readAt": "2026-03-31T04:45:00.000Z"
}
```

The frontend can use this as a simple instruction to clear unread state for the current user across open tabs.

## Backend Changes

### 1. Add Socket.IO dependency

Install `socket.io` in the backend and keep the app on a long-lived Render service.

### 2. Add socket helpers

Introduce a small helper layer near the top of `index.js` to keep websocket logic isolated:

- token verification for sockets
- user-room naming
- notification payload normalization
- safe emit helpers that do nothing when the socket server is unavailable

This keeps the file manageable without requiring a full refactor yet.

### 3. Update notification creation flow

Extend the existing `createNotification` helper so it:

1. inserts or upserts the notification
2. fetches the stored notification document
3. emits `notification:new` to the target user's room

The helper should return the normalized notification payload so future routes can reuse it if needed.

### 4. Update read-all route

After `POST /dashboard/notifications/read-all` updates MongoDB, emit `notification:read-all` to the calling user's room.

### 5. Preserve existing REST behavior

Do not remove or replace `GET /dashboard/bootstrap`. It remains the source of truth when:

- the page loads for the first time
- a socket connection drops and reconnects
- the frontend wants to reconcile missed updates

## Error Handling

- Invalid or missing socket token: reject the socket connection.
- Socket disconnects: no special server recovery is needed; the client can reconnect and optionally refresh notifications through REST.
- Notification emit failure: log the error, but do not fail the underlying HTTP request after the database write succeeds.
- Duplicate notification prevention: preserve the current `createNotification` upsert behavior unless a later product decision changes notification deduplication.

## Security Notes

- Only authenticated users may connect to the socket server.
- Users only join their own personal room.
- The server never trusts a client-provided `userId`; it derives identity from the verified token.
- Notification content continues to be generated by existing server-side business logic.

## Testing Strategy

### Automated

Add focused backend tests for:

- socket auth rejects invalid tokens
- `createNotification` emits `notification:new` for the target user
- `POST /dashboard/notifications/read-all` emits `notification:read-all`

Because the project currently has no test harness, the implementation plan should first add a minimal test setup before production code changes.

### Manual

1. Run the backend locally on a long-lived Node process.
2. Open two browser tabs as the same user.
3. Trigger an action from another user or session that creates a notification.
4. Confirm both tabs receive the new notification instantly.
5. Mark notifications as read in one tab.
6. Confirm the unread state clears in the other tab without refresh.

## Future Extension Path

After this slice is stable, the same socket server can be extended with:

- `project:<projectId>` rooms
- task CRUD and move events for kanban, list, and calendar
- optional reconnect resync hooks for project data

That work should be designed separately so the notification slice stays easy to understand.
