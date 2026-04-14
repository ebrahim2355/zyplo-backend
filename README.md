# Zyplo Backend

Zyplo Backend is the server-side application for the Zyplo team collaboration platform.
It powers authentication, workspace management, project organization, Kanban boards,
task operations, time tracking, invitation flows, GitHub webhook automation, comments,
notifications, and Stripe-powered billing.

This repository is the backend half of the Zyplo product experience.
The live frontend is available here:

Frontend Live Link: https://zyplo-six.vercel.app

This backend is designed to support a team workflow where users can:

- create and manage workspaces
- invite teammates by email
- create projects inside workspaces
- manage tasks across board columns
- assign work to members
- track time spent on tasks
- connect GitHub installations to workspaces
- react to GitHub events through webhooks
- manage Stripe subscriptions for billing

## Team Project

This is a collaborative team project.
The contributors listed for this repository are:

- Israt Jahan
- Md Mahmud Ullah Hasan
- Arifun Nahar Lipi
- Md Al Helal Mohammod Bayijid
- MD Ebrahim Ali

## Project Summary

The backend is built with Node.js, Express, MongoDB, JWT-based authentication helpers,
Nodemailer for invitation email delivery, Stripe for subscription billing, and Zod for
request validation in selected flows.

The codebase is intentionally compact.
Most of the application logic currently lives in a single `index.js` file, while
supporting project metadata and deployment configuration live in `package.json`,
`vercel.json`, `.env`, and the billing-specific documentation file
`README.billing.md`.

## Repository Files Scanned

The current project-level files in this repository are:

- `index.js`
- `package.json`
- `package-lock.json`
- `vercel.json`
- `README.billing.md`
- `.env`
- `.gitignore`
- `README.md`

## Tech Stack

- Node.js
- Express 5
- MongoDB Node Driver
- JWT
- bcryptjs
- Zod
- Nodemailer
- Stripe
- serverless-http
- Vercel

## Package Dependencies

The `package.json` file currently includes the following runtime dependencies:

- `bcryptjs`
- `cors`
- `dotenv`
- `express`
- `jsonwebtoken`
- `mongodb`
- `nodemailer`
- `serverless-http`
- `stripe`
- `zod`

## Current Scripts

The available npm scripts are:

```bash
npm start
```

`npm test` is present as a placeholder, but there is no real automated test suite
configured in this repository yet.

## Deployment Model

The project is configured for Vercel deployment.
The `vercel.json` file routes all incoming request methods to `index.js`.

That means this repository is prepared to run as a single backend entrypoint in a
serverless-friendly deployment model.

## CORS Configuration

The backend currently allows requests from:

- `http://localhost:3000`
- `https://zyplo-six.vercel.app`

This is important because it confirms the intended frontend environments for local
development and live usage.

## Runtime Entry Point

The main server file is `index.js`.

It handles:

- Express app initialization
- CORS setup
- JSON parsing
- raw body capture for webhook signature verification
- MongoDB connection setup
- collection references
- helper utilities
- all API route registration
- root health-style route

The root route responds with:

```txt
Zyplo server is running!
```

## Database Overview

The application connects to a MongoDB database named:

```txt
zyplo-db
```

Based on the backend code, the following MongoDB collections are used:

- `users`
- `workspaces`
- `projects`
- `boards`
- `tasks`
- `timeLogs`
- `notifications`
- `invites`
- `comments`
- `activities`
- `githubInstallations`
- `billingAccounts`
- `billingWebhookEvents`

## Indexed Data

The backend creates important indexes for performance and data integrity.
Examples include indexes for:

- notifications by user and timestamp
- activities by user and workspace
- unique task references
- time log lookups
- one active timer per user
- unique billing owner mapping
- unique Stripe customer and subscription mapping
- unique billing webhook event IDs

These indexes help enforce consistency for the collaboration and billing flows.

## Environment Variables

The repository uses environment variables through `dotenv`.
Based on the source code and billing documentation, the project may require values like:

```env
PORT=5000
DB_USER=
DB_PASS=
NEXTAUTH_SECRET=
FRONTEND_URL=http://localhost:3000
APP_URL=http://localhost:3000

EMAIL_USER=
EMAIL_PASS=

GITHUB_WEBHOOK_SECRET=

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER_MONTHLY=
STRIPE_PRICE_STARTER_YEARLY=
STRIPE_PRICE_TEAM_MONTHLY=
STRIPE_PRICE_TEAM_YEARLY=
```

You should keep secrets in `.env` and never commit sensitive production values.

## Local Setup

To run the project locally:

```bash
npm install
npm start
```

The backend will use `PORT` from environment variables when provided.
If no `PORT` is set, it falls back to `5000`.

## Recommended Development Flow

1. Clone the repository.
2. Install dependencies with `npm install`.
3. Create or update `.env` with the required secrets.
4. Start the backend with `npm start`.
5. Run the frontend separately on `http://localhost:3000`.
6. Use the live frontend only when your backend deployment is configured correctly.

## Authentication Overview

Authentication is handled with JWT verification middleware named `verifyToken`.
Protected routes expect an authorization header in this format:

```txt
Authorization: Bearer <token>
```

The token is verified with `NEXTAUTH_SECRET`.

If a token is missing, the API returns an unauthorized response.
If a token is invalid, the API returns an invalid token response.

## Auth Features

The backend currently supports:

- credential registration
- credential login
- OAuth-based user creation or lookup
- protected dashboard routes
- basic temporary account lock after repeated failed logins

## Authentication Routes

Main authentication endpoints include:

- `POST /auth/register`
- `POST /auth/oauth`
- `POST /auth/login`
- `POST /users`

## Login Protection

The login route includes a simple protection mechanism:

- maximum login attempts: `5`
- lock time: `30 seconds`

This helps reduce repeated brute force attempts against credential accounts.

## User Profile Features

The backend includes profile support for authenticated users.

Current profile routes:

- `GET /dashboard/profile`
- `PATCH /dashboard/profile`

The profile patch route supports fields such as:

- `name`
- `phone`
- `roleTitle`
- `company`
- `location`
- `website`
- `avatarUrl`
- `bio`
- `starredWorkspaceIds`

## Dashboard Bootstrap

One of the most important routes is:

`GET /dashboard/bootstrap`

This route aggregates and returns:

- current user profile data
- workspace list
- project list
- task list
- recent activity
- notifications

This makes it a key route for loading the main frontend dashboard experience.

## Workspace Features

Workspaces are the main collaboration container in Zyplo.
Each workspace can hold members, projects, boards, tasks, invites, and related activity.

Current workspace-related capabilities include:

- create workspace
- add members
- delete workspace
- update member roles
- remove members
- list invites for a workspace
- send invites
- delete invites

## Workspace Routes

Relevant workspace endpoints include:

- `POST /dashboard/workspaces`
- `POST /dashboard/workspaces/:workspaceId/members`
- `DELETE /dashboard/workspaces/:workspaceId`
- `PATCH /dashboard/workspaces/:workspaceId/members/:memberId`
- `DELETE /dashboard/workspaces/:workspaceId/members/:memberId`
- `GET /workspaces/:workspaceId/invites`
- `POST /workspaces/:workspaceId/invites`
- `DELETE /workspaces/:workspaceId/invites/:inviteId`

## Workspace Roles

The codebase currently works with at least two member roles:

- `admin`
- `member`

Admin users have permission for higher-impact actions such as:

- creating projects
- deleting projects
- deleting workspaces
- managing invites
- updating member roles
- removing members
- connecting GitHub installations

## Invitation System

The backend includes a full invite flow.
An invitation is created with a random token, hashed before storage, and linked to
the frontend acceptance page.

Important invite behavior:

- invite links are generated using `FRONTEND_URL`
- invite status starts as `pending`
- invites expire after 2 days
- users can accept or reject invites
- email matching is enforced for invite acceptance
- invite emails are sent using Nodemailer

## Invite Routes

Invite-specific endpoints include:

- `GET /invites/:token`
- `POST /invites/:choice`

The `choice` route supports:

- `accept`
- `reject`

## Project Features

Projects belong to a workspace.
When a project is created, the backend also creates a default board automatically.

Default board columns are:

- To Do
- In Progress
- In Review
- Done

## Project Routes

Project endpoints include:

- `POST /dashboard/projects`
- `DELETE /dashboard/projects/:projectId`

The project creation flow also generates a short uppercase project key, which is then
used in task references such as `AUTH-1`.

## Board Features

Boards are linked to projects and contain embedded columns.
Tasks are stored separately and mapped into columns using `columnId`.

Board route:

- `GET /dashboard/boards/:projectId`

The response returns board metadata along with sorted columns and the tasks grouped
inside them.

## Task Features

Task management is one of the largest parts of the backend.
Tasks support:

- title and description
- priority
- status
- due date
- assignee
- reporter information
- task numbering
- task reference strings
- attachments
- estimated time
- tracked time spent
- remaining time
- board ordering

## Task Routes

Main task endpoints include:

- `POST /dashboard/tasks`
- `DELETE /dashboard/tasks/:taskId`
- `PATCH /dashboard/tasks/:taskId/move`
- `PATCH /dashboard/tasks/:taskId`
- `GET /dashboard/tasks/:id`
- `GET /dashboard/tasks/:taskId/activities`

## Task Reference Pattern

Tasks receive references in the format:

```txt
<PROJECT_KEY>-<NUMBER>
```

Example:

```txt
AUTH-1
```

These references are important because the GitHub integration can detect them from
pull request titles and commit messages.

## Drag and Drop Task Movement

The move endpoint is designed to support Kanban-style drag and drop behavior.
It handles:

- source column validation
- destination column validation
- optional board movement
- order recalculation
- status updates from column names
- notification generation for status changes

This is one of the more advanced workflow parts of the backend.

## Notifications and Activity

The backend records activity and generates notifications for meaningful changes.
Examples include:

- task creation
- task deletion
- assignment changes
- task updates
- status changes

There is also a route to mark all notifications as read:

- `POST /dashboard/notifications/read-all`

## Time Tracking Features

The project includes built-in time tracking.
Users can start timers, stop timers, log manual time, and fetch reports.

Time tracking capabilities include:

- one active timer per user
- automatic duration calculation
- manual time entry
- per-task time logs
- active timer lookup
- task time summary
- timesheet reporting
- project time reporting
- workspace time reporting

## Time Tracking Routes

The current time-related endpoints include:

- `POST /dashboard/tasks/:taskId/time/start`
- `POST /dashboard/time/:logId/stop`
- `GET /dashboard/tasks/:taskId/time`
- `GET /dashboard/time/active`
- `POST /dashboard/tasks/:taskId/time/manual`
- `GET /dashboard/reports/timesheet`
- `GET /dashboard/reports/project/:projectId`
- `GET /dashboard/reports/workspace/:workspaceId`
- `GET /dashboard/reports/task/:taskId`
- `GET /dashboard/tasks/:taskId/time-summary`

## Reporting

The reporting layer focuses on tracked time data.
It provides useful backend support for dashboards, summaries, and productivity views.

The timesheet report supports:

- filtering by user
- filtering by start date
- filtering by end date
- admin access for shared workspace users

## GitHub Integration

The backend contains GitHub integration support for workspace connections and webhook
event processing.

The implementation includes:

- webhook signature verification
- installation-to-workspace mapping
- protected installation callback flow
- workspace GitHub connection status lookup
- disconnect support
- task reference extraction from PR titles and commit messages

## GitHub Routes

GitHub-related endpoints include:

- `POST /github/webhook`
- `GET /github/callback`
- `GET /dashboard/github/status`
- `DELETE /dashboard/github/disconnect`

## GitHub Automation Idea in This Codebase

The code contains logic that can read task references from GitHub activity.
That means this backend is structured to support workflows where code activity and
project tracking stay connected.

For example, a pull request title like `AUTH-12 Fix token refresh issue` can be
associated with a Zyplo task reference.

## Comments Feature

The project also includes task comment support.

Comment endpoints include:

- `POST /dashboard/:id/comments`
- `GET /dashboard/comments/:taskId`

The comment object currently stores:

- task ID
- text
- author
- created timestamp

## Billing Support

This backend also includes Stripe billing support for user-scoped subscriptions.
The separate `README.billing.md` file already documents billing in more detail,
and that billing system is implemented directly inside `index.js`.

## Billing Highlights

Based on the code and billing documentation:

- billing is user-owned, not workspace-owned for new flows
- Stripe webhooks are the source of truth
- self-serve plans include `starter` and `team`
- the `studio` plan is intentionally blocked from self-serve checkout
- checkout and portal sessions are created server-side
- billing data is normalized before being returned to the frontend

## Billing Routes

Billing-related endpoints include:

- `GET /api/billing/subscription`
- `POST /api/billing/checkout-session`
- `POST /api/billing/portal-session`
- `POST /api/billing/webhook`

## Stripe Webhooks

The backend is prepared to process Stripe events such as:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

The code also stores webhook event records to avoid duplicate processing.

## Email Delivery

Nodemailer is used in the invitation flow.
The backend sends invitation emails after invite creation and keeps the invite
stored even if email sending fails.

That is a useful reliability decision because collaboration data does not depend
fully on SMTP success.

## Security Notes

A few important security and correctness details are visible in the code:

- JWT is verified for most dashboard and billing operations
- GitHub webhooks use signature verification
- Stripe webhooks use raw request body verification
- invite tokens are hashed before persistence
- role checks protect admin-only operations
- active timers are protected with a unique partial index

## Current Architectural Characteristics

This backend is feature-rich, but it is still organized as a monolithic single-file
application.

That has some practical advantages:

- easy to deploy quickly
- simple to inspect in one place
- fast for team iteration in an early-stage project

It also creates some challenges:

- route logic is very large
- onboarding takes longer
- feature ownership is less isolated
- testing is harder to organize
- maintenance cost increases as new modules are added

## Suggested Future Improvements

A strong next step for this repository would be to split the monolithic backend into:

- route modules
- controller files
- service layers
- database helper modules
- middleware modules
- validation modules
- email utilities
- billing utilities
- GitHub integration utilities

That would make the codebase easier for a growing team to maintain.

## Suggested Documentation Additions Later

If the team keeps building Zyplo, future README improvements could include:

- architecture diagrams
- API request and response examples
- Postman collection link
- database schema overview
- deployment URL for backend
- frontend repository link
- screenshots
- contributor role breakdown
- changelog

## Current Limitations Noticed During Scan

While scanning the project files, a few practical notes stood out:

- the repository currently has no real automated tests
- the main application logic is concentrated in one file
- some routes are protected while some public routes are still lightweight
- the README had been empty before this update

These are all normal for a fast-moving student or team project, and the current
backend still covers a broad set of collaboration features.

## Who This Project Is For

Zyplo is a good fit for:

- student project teams
- small startup teams
- collaborative task management experiments
- internal productivity dashboards
- teams wanting GitHub-linked task workflows
- projects that need built-in time tracking and billing support

## Frontend Relationship

This repository is intended to work alongside the Zyplo frontend.

Frontend live application:

https://zyplo-six.vercel.app

The backend already references that production frontend URL in CORS settings,
which confirms the two applications are designed to work together.

## Quick Start Checklist

- install dependencies
- configure `.env`
- make sure MongoDB credentials are valid
- configure JWT secret
- configure frontend URL
- configure email credentials if using invites
- configure Stripe keys if using billing
- configure GitHub webhook secret if using GitHub integration
- start the server
- test routes from the frontend or an API client

## Maintainer Notes

If your team continues expanding this repository, it would help to keep this README
updated whenever:

- a new major module is added
- environment variables change
- routes are renamed
- billing behavior changes
- frontend URLs change
- deployment strategy changes

Good documentation makes team handoff much easier.

## Closing Note

Zyplo Backend already contains the core building blocks of a full collaboration
platform: auth, workspaces, projects, tasks, boards, invites, time logs, GitHub
automation, comments, notifications, and subscriptions.

For a team project, that is a strong foundation.
With continued refactoring, testing, and module separation, this backend can become
even easier to scale and maintain.
