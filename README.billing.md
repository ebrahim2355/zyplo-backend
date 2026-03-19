# Zyplo Stripe Billing API

This backend now supports workspace-scoped Stripe subscriptions for the
`starter` and `team` plans.

## Billing model

- Billing is stored per workspace in MongoDB.
- Only workspace admins can create Checkout or Billing Portal sessions.
- Any workspace member can read the current subscription status.
- `studio` is intentionally blocked from self-serve checkout.
- Stripe webhooks are the source of truth for subscription state.

MongoDB collections used:

- `billingAccounts`
- `billingWebhookEvents`

## Required environment variables

Add these to the backend environment:

```env
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
STRIPE_PRICE_STARTER_MONTHLY=
STRIPE_PRICE_STARTER_YEARLY=
STRIPE_PRICE_TEAM_MONTHLY=
STRIPE_PRICE_TEAM_YEARLY=
APP_URL=http://localhost:3000
```

`APP_URL` is preferred for billing redirect URLs. If it is not set, the server
falls back to `FRONTEND_URL`, then `http://localhost:3000`.

## Routes

### `POST /api/billing/checkout-session`

Starts a Stripe Checkout subscription flow for `starter` or `team`.

Request body:

```json
{
  "planId": "starter",
  "billingCycle": "monthly",
  "workspaceId": "65f1f5c9fd4d7d13d81f0abc"
}
```

Response:

```json
{
  "url": "https://checkout.stripe.com/..."
}
```

Failure example when a workspace already has a non-terminal subscription:

```json
{
  "error": "This workspace already has a Stripe subscription. Use the billing portal to manage it instead.",
  "code": "SUBSCRIPTION_EXISTS",
  "details": {
    "planId": "team",
    "billingCycle": "yearly",
    "status": "active",
    "access": "allowed",
    "hasAccess": true,
    "cancelAtPeriodEnd": false,
    "currentPeriodStart": "2026-03-01T00:00:00.000Z",
    "currentPeriodEnd": "2027-03-01T00:00:00.000Z",
    "portalAvailable": true,
    "stripeManaged": true,
    "lastInvoiceId": "in_123",
    "updatedAt": "2026-03-01T00:00:00.000Z"
  }
}
```

Notes:

- `studio` returns `PLAN_NOT_SELF_SERVE`.
- `planId`, `billingCycle`, and Stripe price selection are validated server-side.
- If the user has access to multiple workspaces, send `workspaceId`.

### `POST /api/billing/portal-session`

Creates a Stripe Billing Portal session for the workspace customer.

Request body:

```json
{
  "workspaceId": "65f1f5c9fd4d7d13d81f0abc"
}
```

Response:

```json
{
  "url": "https://billing.stripe.com/..."
}
```

### `GET /api/billing/subscription`

Returns the normalized billing status for the current workspace.

Example request:

```txt
GET /api/billing/subscription?workspaceId=65f1f5c9fd4d7d13d81f0abc
```

Example response:

```json
{
  "owner": {
    "type": "workspace",
    "id": "65f1f5c9fd4d7d13d81f0abc",
    "workspaceId": "65f1f5c9fd4d7d13d81f0abc",
    "workspaceName": "Acme"
  },
  "subscription": {
    "planId": "starter",
    "billingCycle": "monthly",
    "status": "active",
    "access": "allowed",
    "hasAccess": true,
    "cancelAtPeriodEnd": false,
    "currentPeriodStart": "2026-03-01T00:00:00.000Z",
    "currentPeriodEnd": "2026-04-01T00:00:00.000Z",
    "portalAvailable": true,
    "stripeManaged": true,
    "lastInvoiceId": "in_123",
    "updatedAt": "2026-03-01T00:00:00.000Z"
  }
}
```

Status handling:

- `active` and `trialing` are treated as allowed access.
- Any other status is returned as restricted access.

### `POST /api/billing/webhook`

Stripe webhook endpoint. Configure Stripe to send at least:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

The webhook is idempotent and uses `billingWebhookEvents` to track processing.

## Frontend integration notes

- Send the backend JWT in `Authorization: Bearer <token>`.
- Pass `workspaceId` whenever the signed-in user can access multiple workspaces.
- After redirecting back from Stripe Checkout, do not trust the query string as
  proof of payment. Fetch `GET /api/billing/subscription` and render from that.
- Use the returned `url` from checkout or portal endpoints and redirect the
  browser there.
- The backend currently sends Stripe success/cancel and portal return URLs back
  to `/pricing` on the frontend. If you want a dedicated billing page later,
  update the URL builders in `index.js`.
