/**
 * Public Portfolio Profiles — SQLite
 *
 * Allows users to create shareable portfolio pages.
 * Each profile has a unique slug (e.g., /p/keb) and links to one or more wallets.
 *
 * Profiles are opt-in — wallets are private by default.
 */
const crypto = require("crypto");
const historyDb = require("./history-db");
const db = historyDb.db;

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS public_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    bio TEXT,
    avatar_emoji TEXT DEFAULT '🚀',
    is_public INTEGER NOT NULL DEFAULT 1,
    show_balances INTEGER NOT NULL DEFAULT 1,
    show_defi INTEGER NOT NULL DEFAULT 1,
    show_history INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS profile_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    address TEXT NOT NULL,
    label TEXT,
    display_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (profile_id) REFERENCES public_profiles(id),
    UNIQUE(profile_id, address)
  );

  CREATE INDEX IF NOT EXISTS idx_profiles_slug ON public_profiles(slug);
  CREATE INDEX IF NOT EXISTS idx_profile_wallets_profile ON profile_wallets(profile_id);
`);

// ── Slug Helpers ────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

function isSlugAvailable(slug) {
  const row = db.prepare("SELECT 1 FROM public_profiles WHERE slug = ?").get(slug);
  return !row;
}

// ── Profile CRUD ────────────────────────────────────────────────────────────

function createProfile(slug, displayName, options = {}) {
  const cleanSlug = slugify(slug);

  if (!cleanSlug || cleanSlug.length < 2) {
    throw new Error("Slug must be at least 2 characters (letters, numbers, hyphens)");
  }

  if (!isSlugAvailable(cleanSlug)) {
    throw new Error(`Slug "${cleanSlug}" is already taken`);
  }

  const result = db.prepare(`
    INSERT INTO public_profiles (slug, display_name, bio, avatar_emoji, show_balances, show_defi, show_history)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    cleanSlug,
    displayName,
    options.bio || null,
    options.avatarEmoji || "🚀",
    options.showBalances !== false ? 1 : 0,
    options.showDefi !== false ? 1 : 0,
    options.showHistory ? 1 : 0,
  );

  return {
    id: result.lastInsertRowid,
    slug: cleanSlug,
    displayName,
    ...options,
  };
}

function getProfile(slug) {
  const profile = db.prepare(`
    SELECT * FROM public_profiles WHERE slug = ? AND is_public = 1
  `).get(slug);

  if (!profile) return null;

  const wallets = db.prepare(`
    SELECT address, label, display_order
    FROM profile_wallets
    WHERE profile_id = ?
    ORDER BY display_order ASC
  `).all(profile.id);

  return {
    id: profile.id,
    slug: profile.slug,
    displayName: profile.display_name,
    bio: profile.bio,
    avatarEmoji: profile.avatar_emoji,
    showBalances: !!profile.show_balances,
    showDefi: !!profile.show_defi,
    showHistory: !!profile.show_history,
    wallets,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
  };
}

function updateProfile(slug, updates) {
  const sets = [];
  const values = [];

  if (updates.displayName !== undefined) {
    sets.push("display_name = ?");
    values.push(updates.displayName);
  }
  if (updates.bio !== undefined) {
    sets.push("bio = ?");
    values.push(updates.bio);
  }
  if (updates.avatarEmoji !== undefined) {
    sets.push("avatar_emoji = ?");
    values.push(updates.avatarEmoji);
  }
  if (updates.showBalances !== undefined) {
    sets.push("show_balances = ?");
    values.push(updates.showBalances ? 1 : 0);
  }
  if (updates.showDefi !== undefined) {
    sets.push("show_defi = ?");
    values.push(updates.showDefi ? 1 : 0);
  }
  if (updates.showHistory !== undefined) {
    sets.push("show_history = ?");
    values.push(updates.showHistory ? 1 : 0);
  }
  if (updates.isPublic !== undefined) {
    sets.push("is_public = ?");
    values.push(updates.isPublic ? 1 : 0);
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  values.push(slug);

  db.prepare(`UPDATE public_profiles SET ${sets.join(", ")} WHERE slug = ?`).run(...values);
}

function deleteProfile(slug) {
  const profile = db.prepare("SELECT id FROM public_profiles WHERE slug = ?").get(slug);
  if (!profile) return;

  db.prepare("DELETE FROM profile_wallets WHERE profile_id = ?").run(profile.id);
  db.prepare("DELETE FROM public_profiles WHERE id = ?").run(profile.id);
}

// ── Wallet Management ───────────────────────────────────────────────────────

function addWalletToProfile(slug, address, label = null) {
  const profile = db.prepare("SELECT id FROM public_profiles WHERE slug = ?").get(slug);
  if (!profile) throw new Error("Profile not found");

  const maxOrder = db.prepare(
    "SELECT MAX(display_order) as m FROM profile_wallets WHERE profile_id = ?"
  ).get(profile.id);

  db.prepare(`
    INSERT OR IGNORE INTO profile_wallets (profile_id, address, label, display_order)
    VALUES (?, ?, ?, ?)
  `).run(profile.id, address, label, (maxOrder?.m || 0) + 1);
}

function removeWalletFromProfile(slug, address) {
  const profile = db.prepare("SELECT id FROM public_profiles WHERE slug = ?").get(slug);
  if (!profile) return;

  db.prepare("DELETE FROM profile_wallets WHERE profile_id = ? AND address = ?")
    .run(profile.id, address);
}

// ── Listing ─────────────────────────────────────────────────────────────────

function listPublicProfiles(limit = 50) {
  const profiles = db.prepare(`
    SELECT p.slug, p.display_name, p.avatar_emoji, p.bio, p.created_at,
           COUNT(pw.id) as wallet_count
    FROM public_profiles p
    LEFT JOIN profile_wallets pw ON p.id = pw.profile_id
    WHERE p.is_public = 1
    GROUP BY p.id
    ORDER BY p.created_at DESC
    LIMIT ?
  `).all(limit);

  return profiles.map(p => ({
    slug: p.slug,
    displayName: p.display_name,
    avatarEmoji: p.avatar_emoji,
    bio: p.bio,
    walletCount: p.wallet_count,
    createdAt: p.created_at,
  }));
}

module.exports = {
  createProfile,
  getProfile,
  updateProfile,
  deleteProfile,
  addWalletToProfile,
  removeWalletFromProfile,
  listPublicProfiles,
  isSlugAvailable,
};
