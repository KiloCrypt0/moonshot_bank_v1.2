/**
 * Public Portfolio Profiles — SQLite
 *
 * Allows users to create shareable portfolio pages via the UI.
 * Each profile has a unique slug (e.g., /p/keb) and links to one or more wallets.
 *
 * Profiles are opt-in — wallets are private by default.
 */
const historyDb = require("./history-db");
const { cleanLabel, cleanDisplayName, cleanBio, cleanEmoji } = require("./sanitize");
const db = historyDb.db;

// ── Schema ──────────────────────────────────────────────────────────────────
//
// Exported as plain functions for the same reason as history-db's: tests need to
// run them against a scratch database and assert idempotency without busting
// require.cache.

function runMigrations(database = db) {
  database.exec(`
  CREATE TABLE IF NOT EXISTS public_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    owner_address TEXT,
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

  // owner_address for databases created before it existed. SQLite has no
  // ADD COLUMN IF NOT EXISTS, so check the table first.
  const columns = database.prepare("PRAGMA table_info(public_profiles)").all();
  if (!columns.some((c) => c.name === "owner_address")) {
    database.exec("ALTER TABLE public_profiles ADD COLUMN owner_address TEXT");
    console.log("[public-profiles] Migrated: added owner_address to public_profiles");
  }
}

/**
 * One-shot data migrations for profiles. Gated on schema_meta rows (created by
 * history-db's runMigrations, which shares this database), so each runs once per
 * database. Idempotent.
 */
function runBackfills(database = db) {
  // Labels stored before write-time filtering existed. Only rows containing a
  // control character, a bidi override, `<`, `>` or a backtick, or exceeding the
  // length cap, change — cleanLabel deliberately leaves & ' " alone — so an
  // ordinary label with an apostrophe is untouched. Every change is logged with
  // its previous value so a mistake is recoverable from the logs.
  if (!historyDb._backfillHasRun(database, "profile_wallet_labels_filtered")) {
    const rows = database.prepare(
      "SELECT id, label FROM profile_wallets WHERE label IS NOT NULL"
    ).all();
    const update = database.prepare("UPDATE profile_wallets SET label = ? WHERE id = ?");
    let changed = 0;
    for (const row of rows) {
      const cleaned = cleanLabel(row.label);
      if (cleaned !== row.label) {
        console.log(`[public-profiles] Backfill: profile_wallets.label ${row.id} ${JSON.stringify(row.label)} -> ${JSON.stringify(cleaned)}`);
        update.run(cleaned, row.id);
        changed++;
      }
    }
    if (changed) console.log(`[public-profiles] Backfill: filtered ${changed} profile wallet label(s)`);
    historyDb._markBackfillRun(database, "profile_wallet_labels_filtered");
  }

  // Profiles created before ownership existed have no owner. Adopt the
  // lowest-display_order wallet — the one passed first at creation, which is
  // also the one whose create-profile signature was verified first.
  const orphaned = database.prepare(
    "SELECT COUNT(*) AS c FROM public_profiles WHERE owner_address IS NULL"
  ).get().c;
  if (orphaned > 0) {
    const result = database.prepare(`
      UPDATE public_profiles
         SET owner_address = (
               SELECT address FROM profile_wallets
                WHERE profile_id = public_profiles.id
                ORDER BY display_order ASC, id ASC
                LIMIT 1
             )
       WHERE owner_address IS NULL
    `).run();
    console.log(`[public-profiles] Backfill: set owner_address on ${result.changes} profile(s)`);
    // A profile with no wallets at all cannot have an owner. That state was
    // reachable before createProfileWithWallets made creation atomic; such a
    // profile is unmanageable, so say so rather than failing silently later.
    const stillNull = database.prepare(
      "SELECT slug FROM public_profiles WHERE owner_address IS NULL"
    ).all();
    for (const row of stillNull) {
      console.warn(`[public-profiles] Profile "${row.slug}" has no wallets and therefore no owner; it cannot be modified or deleted until a wallet is attached`);
    }
  }
}

runMigrations();
runBackfills();

// ── Helpers ─────────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

function isSlugAvailable(slug) {
  return !db.prepare("SELECT 1 FROM public_profiles WHERE slug = ?").get(slug);
}

// ── CRUD ────────────────────────────────────────────────────────────────────

function createProfile(slug, displayName, options = {}) {
  const cleanSlug = slugify(slug);
  if (!cleanSlug || cleanSlug.length < 2) {
    throw new Error("Slug must be at least 2 characters (letters, numbers, hyphens)");
  }
  if (!isSlugAvailable(cleanSlug)) {
    throw new Error("That URL is already taken — try a different one");
  }

  // Filtered here rather than only in the router, so no future route can write
  // an unfiltered profile field.
  const name = cleanDisplayName(displayName);
  if (!name) throw new Error("displayName is required");

  const result = db.prepare(`
    INSERT INTO public_profiles (slug, display_name, owner_address, bio, avatar_emoji, show_balances, show_defi, show_history)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cleanSlug,
    name,
    options.ownerAddress || null,
    cleanBio(options.bio),
    cleanEmoji(options.avatarEmoji) || "🚀",
    options.showBalances !== false ? 1 : 0,
    options.showDefi !== false ? 1 : 0,
    options.showHistory ? 1 : 0,
  );

  return { id: result.lastInsertRowid, slug: cleanSlug, displayName: name, ownerAddress: options.ownerAddress || null };
}

// Indirection so a test can force the wallet insert to fail and assert the
// whole creation rolls back. The transaction closure below captures the
// module-local binding, so monkey-patching module.exports would do nothing.
let _addWalletImpl = null;
function _setAddWalletImpl(fn) {
  if (process.env.NODE_ENV !== "test") return;
  _addWalletImpl = fn;
}

/**
 * Create a profile and attach its wallets in ONE transaction.
 *
 * Previously the route created the profile and then looped over
 * addWalletToProfile. A failure mid-loop left a profile with no wallets — and
 * now that ownership is derived from the first wallet, that means a profile
 * with no owner: unmodifiable and undeletable.
 */
function createProfileWithWallets(slug, displayName, options = {}, wallets = []) {
  if (!Array.isArray(wallets) || wallets.length === 0) {
    throw new Error("At least one wallet is required to create a profile");
  }
  const ownerAddress = wallets[0].address;
  const run = db.transaction(() => {
    const profile = createProfile(slug, displayName, { ...options, ownerAddress });
    const add = _addWalletImpl || addWalletToProfile;
    for (const w of wallets) add(profile.slug, w.address, w.label || null);
    return profile;
  });
  return run();
}

function getProfile(slug) {
  const profile = db.prepare("SELECT * FROM public_profiles WHERE slug = ? AND is_public = 1").get(slug);
  if (!profile) return null;

  const wallets = db.prepare(
    "SELECT address, label, display_order FROM profile_wallets WHERE profile_id = ? ORDER BY display_order ASC"
  ).all(profile.id);

  return {
    id: profile.id,
    slug: profile.slug,
    displayName: profile.display_name,
    ownerAddress: profile.owner_address || null,
    bio: profile.bio,
    avatarEmoji: profile.avatar_emoji,
    showBalances: !!profile.show_balances,
    showDefi: !!profile.show_defi,
    showHistory: !!profile.show_history,
    wallets,
    createdAt: profile.created_at,
  };
}

function updateProfile(slug, updates) {
  const sets = [];
  const values = [];
  // isPublic is deliberately NOT settable here. getProfile filters
  // `is_public = 1`, so PATCH {isPublic:false} made a profile permanently
  // unreachable — including to its owner and to the delete path. Nothing in the
  // SPA ever sent it. Re-adding it needs a paired unhide path first.
  const fieldMap = {
    displayName: "display_name", bio: "bio", avatarEmoji: "avatar_emoji",
    showBalances: "show_balances", showDefi: "show_defi", showHistory: "show_history",
  };
  // Same filters as createProfile. A PATCH must not be a way around them.
  const filters = {
    displayName: cleanDisplayName,
    bio: cleanBio,
    avatarEmoji: cleanEmoji,
  };
  for (const [key, col] of Object.entries(fieldMap)) {
    if (updates[key] !== undefined) {
      const raw = updates[key];
      const value = typeof raw === "boolean"
        ? (raw ? 1 : 0)
        : filters[key] ? filters[key](raw) : raw;
      // A displayName that filters down to nothing would violate NOT NULL.
      if (key === "displayName" && !value) continue;
      sets.push(`${col} = ?`);
      values.push(value);
    }
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

function addWalletToProfile(slug, address, label = null) {
  const profile = db.prepare("SELECT id FROM public_profiles WHERE slug = ?").get(slug);
  if (!profile) throw new Error("Profile not found");
  if (!/^G[A-Z2-7]{55}$/.test(String(address || ""))) {
    throw new Error("Invalid Stellar address");
  }
  const maxOrder = db.prepare("SELECT MAX(display_order) as m FROM profile_wallets WHERE profile_id = ?").get(profile.id);
  db.prepare("INSERT OR IGNORE INTO profile_wallets (profile_id, address, label, display_order) VALUES (?, ?, ?, ?)")
    .run(profile.id, address, cleanLabel(label), (maxOrder?.m || 0) + 1);
}

function removeWalletFromProfile(slug, address) {
  const profile = db.prepare("SELECT id FROM public_profiles WHERE slug = ?").get(slug);
  if (!profile) return;
  db.prepare("DELETE FROM profile_wallets WHERE profile_id = ? AND address = ?").run(profile.id, address);
}

// Returns full profile records for every profile that includes `address`
// in its wallets. Used by the SPA to detect whether the connected wallet
// already owns a profile so it can switch from Create → Manage.
function listProfilesByWallet(address) {
  if (!address || typeof address !== "string") return [];
  const rows = db.prepare(`
    SELECT p.slug FROM public_profiles p
    JOIN profile_wallets pw ON pw.profile_id = p.id
    WHERE pw.address = ? AND p.is_public = 1
    ORDER BY p.created_at DESC
  `).all(address);
  return rows.map(r => getProfile(r.slug)).filter(Boolean);
}

function listPublicProfiles(limit = 50) {
  return db.prepare(`
    SELECT p.slug, p.display_name, p.avatar_emoji, p.bio, p.created_at, COUNT(pw.id) as wallet_count
    FROM public_profiles p LEFT JOIN profile_wallets pw ON p.id = pw.profile_id
    WHERE p.is_public = 1 GROUP BY p.id ORDER BY p.created_at DESC LIMIT ?
  `).all(limit).map(p => ({
    slug: p.slug, displayName: p.display_name, avatarEmoji: p.avatar_emoji,
    bio: p.bio, walletCount: p.wallet_count, createdAt: p.created_at,
  }));
}

module.exports = {
  runMigrations, runBackfills, _setAddWalletImpl, slugify,
  createProfile, createProfileWithWallets, getProfile, updateProfile, deleteProfile,
  addWalletToProfile, removeWalletFromProfile, listPublicProfiles,
  listProfilesByWallet, isSlugAvailable,
};
