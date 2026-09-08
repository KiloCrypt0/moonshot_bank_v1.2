/**
 * Write-time input filtering for user-supplied text.
 *
 * Wallet labels are the highest-value target in this app: they were writable by
 * anyone onto anyone's address (PATCH /api/v1/wallets/:address), served back to
 * every caller who queried that address, and rendered raw into innerHTML by six
 * separate call sites. Filtering here is one of two independent defences — the
 * SPA also escapes at render time — because either alone is insufficient:
 *
 *   - Render-time escaping alone leaves payloads already sitting in the
 *     database, and misses any renderer that forgets.
 *   - Write-time filtering alone misses the `?import=` share-link path, where a
 *     label reaches innerHTML without the server ever seeing it.
 *
 * WHAT IS STRIPPED, AND WHAT DELIBERATELY IS NOT
 *
 * Stripped: control characters, line/paragraph separators, bidi overrides, and
 * `<`, `>` and backtick. Removing the angle brackets makes tag injection
 * impossible regardless of which render path forgets to escape, and the bidi
 * strip kills display-spoofing.
 *
 * NOT stripped: `&`, `'` and `"`. Those are dangerous only in context, and
 * render-time escaping is where context lives. Stripping them here would
 * silently and irreversibly mangle ordinary labels — "Mum's wallet - 50% &
 * rising" would be stored as "Muns wallet - 50% rising", including when the
 * one-off backfill rewrites existing rows.
 */

// C0/C1 control characters, U+2028/2029 (line and paragraph separator), the
// bidirectional formatting characters used for display spoofing, and the three
// characters that make HTML/template injection possible.
const UNSAFE_CHARS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069<>`]/g;

const LABEL_MAX = 40;
const DISPLAY_NAME_MAX = 60;
const BIO_MAX = 280;
const EMOJI_MAX_GRAPHEMES = 8;

/** Strip dangerous characters and collapse whitespace. Does not cap length. */
function stripUnsafe(value) {
  return String(value)
    .replace(UNSAFE_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Cap by code point, never by UTF-16 unit — `.slice()` splits surrogate pairs
 * and leaves a lone half, which renders as a replacement character.
 */
function capCodePoints(value, max) {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

/** A wallet label, or null when there isn't a usable one. */
function cleanLabel(value) {
  if (typeof value !== "string") return null;
  const cleaned = capCodePoints(stripUnsafe(value), LABEL_MAX);
  return cleaned.length > 0 ? cleaned : null;
}

/** Free text with an explicit cap (display names, bios). */
function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const cleaned = capCodePoints(stripUnsafe(value), max);
  return cleaned.length > 0 ? cleaned : null;
}

function cleanDisplayName(value) { return cleanText(value, DISPLAY_NAME_MAX); }
function cleanBio(value) { return cleanText(value, BIO_MAX); }

/**
 * An avatar emoji. Capped by GRAPHEME CLUSTER where Intl.Segmenter is
 * available: a family emoji is one grapheme but seven code points and eleven
 * UTF-16 units, so a naive cap chops it into mojibake.
 */
function cleanEmoji(value) {
  if (typeof value !== "string") return null;
  const stripped = stripUnsafe(value);
  if (stripped.length === 0) return null;
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const graphemes = Array.from(segmenter.segment(stripped), (s) => s.segment);
    return graphemes.slice(0, EMOJI_MAX_GRAPHEMES).join("");
  }
  // Fallback: cap generously by code point so we never split a surrogate pair.
  return capCodePoints(stripped, EMOJI_MAX_GRAPHEMES * 4);
}

module.exports = {
  stripUnsafe,
  cleanLabel,
  cleanText,
  cleanDisplayName,
  cleanBio,
  cleanEmoji,
  LABEL_MAX,
  DISPLAY_NAME_MAX,
  BIO_MAX,
};
