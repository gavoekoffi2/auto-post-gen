import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ensurePostEngagement } from "../supabase/functions/_shared/post-engagement.ts";
import {
  checkTextFits,
  getTextLimit,
  normalizePlatformId,
  tightLengthBrief,
} from "../supabase/functions/_shared/platformTextLimits.ts";
import { normalizeAudiences } from "../supabase/functions/_shared/audience.ts";
import { isUsableAudience, normalizeAudienceSegments } from "../src/lib/audiences.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const len = (value) => [...value].length;

// ---------------------------------------------------------------------------
// Per-network caption limits. Nothing live enforced these, so a post targeting
// X was several times over 280 characters and could only be rejected or cut
// mid-sentence by the provider.
// ---------------------------------------------------------------------------

test("the tightest selected network sets the limit", () => {
  // One post goes to every selected network, so X binds the whole post.
  assert.equal(getTextLimit(["LinkedIn", "Twitter"]).maxChars, 280);
  assert.equal(getTextLimit(["LinkedIn", "Twitter"]).platform, "twitter");
  assert.equal(getTextLimit(["Instagram"]).maxChars, 2200);
  assert.equal(getTextLimit(["LinkedIn"]).maxChars, 3000);
  // Unknown or empty selections fall back to a safe, non-zero ceiling.
  assert.ok(getTextLimit([]).maxChars > 0);
  assert.ok(getTextLimit(["Mastodon"]).maxChars > 0);
});

test("the platform aliases the UI and DB actually use all resolve", () => {
  for (const alias of ["Twitter", "Twitter (X)", "X", "twitter"]) {
    assert.equal(normalizePlatformId(alias), "twitter", alias);
  }
  assert.equal(normalizePlatformId("Instagram"), "instagram");
  assert.equal(normalizePlatformId("LinkedIn"), "linkedin");
  assert.equal(normalizePlatformId("Facebook"), "facebook");
});

test("a tight limit produces a length brief, a loose one does not", () => {
  assert.match(tightLengthBrief(getTextLimit(["Twitter"])), /280/);
  assert.equal(tightLengthBrief(getTextLimit(["LinkedIn"])), null);
});

test("character counting matches how networks count emoji", () => {
  // "🍽️" is several UTF-16 units; String.length would over-count it and
  // reject a post that actually fits.
  const withEmoji = "🍽️🚀✨";
  assert.ok(checkTextFits(withEmoji, ["Twitter"]).length < withEmoji.length);
});

test("the engagement footer can never push a post over its network limit", () => {
  // ensurePostEngagement appends an engagement line AND a hashtag line after
  // the model has written, so it can blow the budget on its own.
  const limit = getTextLimit(["Twitter"]);
  for (const body of [
    "Un conseil court.",
    "Voici un conseil bien plus long. ".repeat(12),
    "x".repeat(279),
  ]) {
    const out = ensurePostEngagement({
      content: body,
      category: "value",
      sector: "Restauration",
      companyName: "Chez Awa",
      maxChars: limit.maxChars,
    });
    assert.ok(
      len(out) <= limit.maxChars,
      `output was ${len(out)} chars, over the ${limit.maxChars} limit`,
    );
    assert.ok(out.trim().length > 0, "the post must not be emptied to fit");
  }
});

test("without a limit the engagement footer is still added in full", () => {
  const out = ensurePostEngagement({
    content: "Un conseil utile.",
    category: "value",
    sector: "Restauration",
    companyName: "Chez Awa",
  });
  assert.match(out, /commentaire/);
  assert.ok((out.match(/#/g) || []).length >= 3);
});

test("both generators and the publisher respect the limit", () => {
  for (const path of [
    "supabase/functions/generate-content/index.ts",
    "supabase/functions/auto-generate-weekly/index.ts",
  ]) {
    const source = read(path);
    assert.match(source, /getTextLimit\(/, `${path} must compute the binding limit`);
    assert.match(source, /maxChars: textLimit\.maxChars/, `${path} must cap the final text`);
  }
  // Publishing an over-limit caption must fail with a reason the user can act
  // on, not with whatever opaque error the provider returns.
  const publish = read("supabase/functions/publish-post/index.ts");
  assert.match(publish, /checkTextFits\(post\.content, platforms\)/);
  assert.match(publish, /de trop pour/);
});

test("the dashboard shows the limit before the post is published", () => {
  const dashboard = read("src/pages/Dashboard.tsx");
  assert.match(dashboard, /checkTextFits/);
  assert.match(dashboard, /caractères/);
});

test("the frontend and edge copies of the limits module stay identical", () => {
  assert.equal(
    read("src/lib/platformTextLimits.ts"),
    read("supabase/functions/_shared/platformTextLimits.ts"),
  );
});

// ---------------------------------------------------------------------------
// Hashtag handling: the footer must not corrupt the sentence it is added to.
// ---------------------------------------------------------------------------

test("a hashtag used inside a sentence is left in the sentence", () => {
  // Stripping every hashtag left "Suivez le hashtag  pour en savoir plus".
  const out = ensurePostEngagement({
    content: "Suivez le hashtag #Marketing pour en savoir plus. Qu'en pensez-vous ?",
    category: "value",
    sector: "Restauration",
  });
  assert.match(out, /Suivez le hashtag #Marketing pour en savoir plus\./);
  // …and it is not then repeated in the tag line.
  assert.equal((out.match(/#Marketing\b/g) || []).length, 1);
});

test("a number written with a hash is prose, not a hashtag", () => {
  // "#1" was pulled out as a tag, leaving "Voici le  des conseils".
  const out = ensurePostEngagement({
    content: "Voici le #1 des conseils : agir vite. Qu'en pensez-vous ?",
    category: "value",
    sector: "Restauration",
  });
  assert.match(out, /Voici le #1 des conseils/);
  assert.doesNotMatch(out.split("\n").pop(), /#1\b/);
});

test("the model's own trailing tag line is kept and topped up when short", () => {
  const kept = ensurePostEngagement({
    content: "Un bon conseil.\n\nQu'en pensez-vous ?\n\n#Resto #Abidjan #Cuisine #Astuce",
    category: "value",
    sector: "Restauration",
  });
  assert.match(kept, /#Resto #Abidjan #Cuisine #Astuce$/);

  const toppedUp = ensurePostEngagement({
    content: "Un conseil.\n\nQu'en pensez-vous ?\n\n#Resto #Abidjan",
    category: "value",
    sector: "Restauration",
  });
  assert.ok((toppedUp.split("\n").pop().match(/#/g) || []).length >= 3);
});

// ---------------------------------------------------------------------------
// Audience targeting: the dashboard and the server must agree on what counts.
// ---------------------------------------------------------------------------

test("the dashboard and the server keep the same audiences", () => {
  // They used to disagree: the dashboard kept a target with no description,
  // the server dropped it, so a user's selected target silently vanished and
  // every post was written for "everyone" with nothing saying why.
  const saved = [
    { id: "a", name: "Restaurateurs", description: "", pain_points: ["marges faibles"] },
    { id: "b", name: "Traiteurs", description: "Traiteurs événementiels à Abidjan" },
    { id: "c", name: "", description: "sans nom" },
  ];
  const frontend = normalizeAudienceSegments(saved).filter(isUsableAudience).map((a) => a.name);
  const backend = normalizeAudiences(saved).map((a) => a.name);
  assert.deepEqual(frontend, backend);
});

test("a target with a name but nothing else is dropped by both sides", () => {
  const nameOnly = [{ id: "d", name: "Vide", description: "" }];
  assert.equal(normalizeAudienceSegments(nameOnly).length, 0);
  assert.equal(normalizeAudiences(nameOnly).length, 0);
});

test("isUsableAudience guards targets the editor builds by hand", () => {
  // The editor constructs and mutates segments directly rather than through
  // the normalizer, so this is the guard that decides what can be selected.
  const base = {
    id: "d",
    name: "Vide",
    description: "",
    pain_points: [],
    goals: [],
    content_topics: [],
    buying_triggers: [],
  };
  assert.equal(isUsableAudience(base), false);
  assert.equal(isUsableAudience({ ...base, description: "Des traiteurs à Abidjan" }), true);
  assert.equal(isUsableAudience({ ...base, pain_points: ["marges faibles"] }), true);
  assert.equal(isUsableAudience({ ...base, name: "   ", description: "quelque chose" }), false);
});

test("the editor refuses to select a target the server would discard", () => {
  const editor = read("src/components/AudienceEditor.tsx");
  assert.match(editor, /disabled=\{!usable\}/);
  assert.match(editor, /isUsableAudience/);
  // A manually added target starts empty rather than pre-filled with
  // placeholder prose that would be sent to the model as a real brief.
  assert.doesNotMatch(editor, /name: "Nouvelle cible"/);
});

// ---------------------------------------------------------------------------
// Onboarding must never dead-end on an external outage.
// ---------------------------------------------------------------------------

test("a failed audience analysis does not trap the user on step 3", () => {
  // analyzeAudiences() returning false used to `return` out of handleNext, and
  // the "add a target manually" control lives on step 4 — so an AI outage made
  // it impossible to finish signing up at all.
  const onboarding = read("src/pages/Onboarding.tsx");
  const handleNext = onboarding.match(/const handleNext = async[\s\S]*?\n  \};/)[0];
  assert.doesNotMatch(
    handleNext,
    /const analyzed = await analyzeAudiences\(\);\s*\n\s*if \(!analyzed\) return;/,
  );
  assert.match(handleNext, /await analyzeAudiences\(\);\s*\n\s*\}\s*\n\s*setStep\(4\)/);
});

test("a partial audience analysis is kept instead of thrown away", () => {
  for (const path of ["src/pages/Onboarding.tsx", "src/pages/Profile.tsx"]) {
    const source = read(path);
    assert.equal(
      source.includes("if (audiences.length < 2)"),
      false,
      `${path} still discards a one-segment result`,
    );
    assert.match(source, /if \(audiences\.length === 0\)/);
  }
});

test("audience analysis failure does not burn the user's hourly quota", () => {
  const fn = read("supabase/functions/detect-audiences/index.ts");
  assert.match(fn, /releaseQuota = async \(\) => \{/);
  assert.match(fn, /await releaseQuota\(\)/);
});

// ---------------------------------------------------------------------------
// Zernio is the tenant boundary.
// ---------------------------------------------------------------------------

test("a user is never placed in a shared Zernio profile", () => {
  // The fallback to the operator's default profile meant a user could publish
  // to another user's connected social accounts.
  const connect = read("supabase/functions/zernio-connect/index.ts");
  assert.equal(
    connect.includes("profiles.find((p) => p.isDefault)"),
    false,
    "zernio-connect must not fall back to a shared profile",
  );
  assert.match(connect, /ZERNIO_PROFILE_LIMIT/);
});

test("listing Zernio accounts without a profile id is refused", () => {
  // Omitting profileId makes the API return every account across every
  // profile — other tenants' connected social accounts.
  const zernio = read("supabase/functions/_shared/zernio.ts");
  assert.match(zernio, /if \(!profileId\) \{[\s\S]*?throw new Error/);
  assert.equal(
    zernio.includes('if (profileId) url.searchParams.set("profileId", profileId);'),
    false,
    "profileId must be mandatory, not conditional",
  );
});

// ---------------------------------------------------------------------------
// Account deletion must actually delete.
// ---------------------------------------------------------------------------

test("account deletion pages through storage instead of stopping at 1000", () => {
  const fn = read("supabase/functions/delete-account/index.ts");
  assert.match(fn, /MAX_PASSES/);
  assert.equal(
    fn.includes("list(userId, { limit: 1000 })"),
    false,
    "a single unpaginated list leaves objects behind",
  );
});

test("the comments inbox is read per tenant, never across profiles", () => {
  // Same boundary as zernioListAccounts: without profileId the inbox returns
  // every profile's commented posts, which sync-comments would then file into
  // THIS user's comment inbox.
  const engagement = read("supabase/functions/_shared/engagement.ts");
  assert.match(engagement, /zernioListCommentedPosts[\s\S]{0,400}?if \(!profileId\)[\s\S]{0,200}?throw new Error/);
  assert.equal(
    engagement.includes('if (profileId) url.searchParams.set("profileId", profileId);'),
    false,
  );
  const sync = read("supabase/functions/sync-comments/index.ts");
  assert.match(sync, /zernio_profile_key_missing/);
});

test("the contact form cannot inject a line break into an email header", () => {
  const fn = read("supabase/functions/send-contact/index.ts");
  const subject = fn.match(/const subject = [^\n]*/)[0];
  assert.match(subject, /\[\\r\\n\]\+/);
});

test("generation is told which networks the post targets", () => {
  // The binding caption limit comes from the post's own targets, which can
  // differ from the profile's default selection.
  const dashboard = read("src/pages/Dashboard.tsx");
  assert.match(dashboard, /platforms: generationPlatforms/);
  assert.match(
    dashboard,
    /platforms: post\.platforms \|\| \(post\.platform \? \[post\.platform\] : \[\]\)/,
  );
});
