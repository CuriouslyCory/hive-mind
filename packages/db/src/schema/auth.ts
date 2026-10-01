import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, timestamptz, updatedAt } from "../columns.ts";

// Tables for better-auth and its organization, device authorization and
// api-key plugins, as configured in
// apps/web/src/server/auth.ts. Generated with `auth generate`, then edited by
// hand to follow the database conventions (ADR-0005): the column helpers,
// timestamptz, snake_case names from Drizzle's casing, and uuid foreign keys.
// apps/web/test/auth-schema.test.ts fails if a field better-auth writes is
// missing here.
//
// Naming: the `session` table holds login sessions, not Sessions (see
// CONTEXT.md). Refer to its rows as `loginSession` in code.

export const user = pgTable("user", {
  id: id(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: boolean().default(false).notNull(),
  image: text(),
  // The GitHub login when the user was created; a label, never an identity.
  githubLogin: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  "session",
  {
    id: id(),
    expiresAt: timestamptz().notNull(),
    token: text().notNull().unique(),
    ipAddress: text(),
    userAgent: text(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOrganizationId: uuid().references(() => organization.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: id(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Encrypted with BETTER_AUTH_SECRET (`account.encryptOAuthTokens`).
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamptz(),
    refreshTokenExpiresAt: timestamptz(),
    scope: text(),
    password: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("account_user_id_idx").on(table.userId),
    // One row per linked provider account, so concurrent link callbacks cannot
    // both insert one.
    uniqueIndex("account_provider_id_account_id_idx").on(table.providerId, table.accountId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: id(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const organization = pgTable("organization", {
  id: id(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  logo: text(),
  metadata: text(),
  createdAt: createdAt(),
});

export const member = pgTable(
  "member",
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text().default("member").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("member_organization_id_idx").on(table.organizationId),
    index("member_user_id_idx").on(table.userId),
  ],
);

export const invitation = pgTable(
  "invitation",
  {
    id: id(),
    organizationId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text().notNull(),
    role: text(),
    status: text().default("pending").notNull(),
    expiresAt: timestamptz().notNull(),
    inviterId: uuid()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (table) => [
    index("invitation_organization_id_idx").on(table.organizationId),
    index("invitation_email_idx").on(table.email),
  ],
);

// Device authorization (RFC 8628) for the CLI's `login`. A row is one device
// code: pending until a signed-in user approves or denies it in the browser,
// then redeemed once for a login session.
export const deviceCode = pgTable(
  "device_code",
  {
    id: id(),
    // Named here: drizzle-kit's default names keep the camelCase keys.
    deviceCode: text().notNull().unique("device_code_device_code_unique"),
    userCode: text().notNull().unique("device_code_user_code_unique"),
    // The user who opened the code in the browser and may approve or deny it.
    // Never taken from the device request (see rejectDeviceUserPreBinding in
    // apps/web/src/server/auth.ts).
    userId: uuid().references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamptz().notNull(),
    status: text().notNull(),
    lastPolledAt: timestamptz(),
    pollingInterval: integer(),
    clientId: text(),
    scope: text(),
  },
  (table) => [index("device_code_user_id_idx").on(table.userId)],
);

// API keys from @better-auth/api-key. Each is owned by an organization
// (`references: "organization"`), and usable only through its Project binding
// in project_api_key. `key` holds the SHA-256 hash, never the key itself.
export const apikey = pgTable(
  "apikey",
  {
    id: id(),
    configId: text().default("default").notNull(),
    name: text(),
    start: text(),
    // The owning organization. better-auth calls it a reference because a
    // key can belong to a user instead; this app configures organizations
    // only, so it is a foreign key.
    referenceId: uuid()
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    prefix: text(),
    key: text().notNull().unique(),
    refillInterval: integer(),
    refillAmount: integer(),
    lastRefillAt: timestamptz(),
    // Not null, so a key is enabled or disabled, never unknown.
    enabled: boolean().default(true).notNull(),
    rateLimitEnabled: boolean().default(true),
    rateLimitTimeWindow: integer().default(86400000),
    rateLimitMax: integer().default(10),
    requestCount: integer().default(0),
    remaining: integer(),
    lastRequest: timestamptz(),
    expiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    permissions: text(),
    metadata: text(),
  },
  (table) => [
    index("apikey_config_id_idx").on(table.configId),
    index("apikey_reference_id_idx").on(table.referenceId),
    // The target of project_api_key's foreign key, which requires a key and
    // its Project to belong to the same organization.
    unique("apikey_id_reference_id_unique").on(table.id, table.referenceId),
  ],
);

// Relations let better-auth's Drizzle adapter join tables, and enable
// `db.query` relational queries. Keep the adapter's names: it looks up a
// one-to-many join from `user` as `${model}s`, so `sessions` (login sessions)
// and `accounts` cannot be renamed.

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
  invitations: many(invitation),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
}));

export const memberRelations = relations(member, ({ one }) => ({
  organization: one(organization, {
    fields: [member.organizationId],
    references: [organization.id],
  }),
  user: one(user, { fields: [member.userId], references: [user.id] }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organizationId],
    references: [organization.id],
  }),
  user: one(user, { fields: [invitation.inviterId], references: [user.id] }),
}));
