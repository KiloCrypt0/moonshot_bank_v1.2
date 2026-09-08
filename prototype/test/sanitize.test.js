require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("../lib/sanitize");

const PAYLOADS = [
  "<img src=x onerror=alert(1)>",
  '"><script>alert(1)</script>',
  "<svg/onload=alert(1)>",
  "`${alert(1)}`",
  "<iframe src=javascript:alert(1)>",
];

test("known XSS payloads lose the characters that make them work", () => {
  for (const payload of PAYLOADS) {
    const cleaned = s.cleanLabel(payload) || "";
    assert.ok(!cleaned.includes("<"), `< survived in ${JSON.stringify(cleaned)}`);
    assert.ok(!cleaned.includes(">"), `> survived in ${JSON.stringify(cleaned)}`);
    assert.ok(!cleaned.includes("`"), `backtick survived in ${JSON.stringify(cleaned)}`);
  }
});

test("ordinary labels are preserved exactly", () => {
  // The filter deliberately leaves & ' " to render-time escaping. Stripping
  // them here would irreversibly mangle real labels — including when the
  // backfill rewrites existing rows.
  const benign = "Mum's wallet — 50% & rising";
  assert.equal(s.cleanLabel(benign), benign);
  assert.equal(s.cleanLabel('He said "hi"'), 'He said "hi"');
  assert.equal(s.cleanLabel("Cold storage #2"), "Cold storage #2");
  assert.equal(s.cleanLabel("éàü 你好 \u{1F680}"), "éàü 你好 \u{1F680}");
});

test("control characters, bidi overrides and separators are stripped", () => {
  assert.equal(s.cleanLabel("a\u0000b\u0007c"), "abc");
  assert.equal(s.cleanLabel("safe\u202eevil"), "safeevil");
  assert.equal(s.cleanLabel("a\u2028b\u2029c"), "abc");
  assert.equal(s.cleanLabel("a\u2066b\u2069c"), "abc");
  assert.equal(s.cleanLabel("a\u200eb\u200fc"), "abc");
});

test("whitespace is collapsed and trimmed", () => {
  assert.equal(s.cleanLabel("  spaced   out \n\t "), "spaced out");
});

test("labels are capped by code point, not UTF-16 unit", () => {
  assert.equal(s.cleanLabel("x".repeat(500)).length, s.LABEL_MAX);
  // 30 rockets is 60 UTF-16 units but 30 code points, so nothing is truncated
  // and no surrogate pair is split.
  const rockets = "\u{1F680}".repeat(30);
  assert.equal(s.cleanLabel(rockets), rockets);
  const capped = s.cleanLabel("\u{1F680}".repeat(60));
  assert.equal(Array.from(capped).length, s.LABEL_MAX);
  assert.ok(!capped.includes("�"), "a surrogate pair was split");
});

test("non-strings and empty input give null, never a string", () => {
  for (const v of [null, undefined, 42, {}, [], true, "", "   ", "\u0000"]) {
    assert.equal(s.cleanLabel(v), null, `expected null for ${JSON.stringify(v)}`);
  }
});

test("display names and bios have their own caps", () => {
  assert.equal(s.cleanDisplayName("y".repeat(200)).length, s.DISPLAY_NAME_MAX);
  assert.equal(s.cleanBio("z".repeat(2000)).length, s.BIO_MAX);
  assert.equal(s.cleanBio("<b>bold</b> claim"), "bbold/b claim");
});

test("emoji are capped by grapheme cluster, not code point", () => {
  // A family emoji is ONE grapheme but seven code points and eleven UTF-16
  // units. Capping by either of the latter produces mojibake.
  const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
  assert.equal(s.cleanEmoji(family), family);
  assert.equal(s.cleanEmoji("\u{1F680}"), "\u{1F680}");
  assert.equal(s.cleanEmoji("<script>"), "script");
  assert.equal(s.cleanEmoji(""), null);
  // Nine rockets capped to eight, none of them broken.
  const many = s.cleanEmoji("\u{1F680}".repeat(9));
  assert.equal(Array.from(many).length, 8);
  assert.ok(!many.includes("�"));
});
