import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ensurePostEngagement } from "../server/src/shared/postEngagement.ts";
import {
  checkTextFits,
  getTextLimit,
  normalizePlatformId,
  tightLengthBrief,
} from "../src/lib/platformTextLimits.ts";
import { normalizeAudiences } from "../server/src/shared/audience.ts";
import {
  checkTextFits as serverCheckTextFits,
  getTextLimit as serverGetTextLimit,
} from "../server/src/shared/platformTextLimits.ts";
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

test("the generator and the publisher both respect the limit", () => {
  const generator = read("server/src/services/text.ts");
  assert.match(generator, /getTextLimit\(/, "the generator must compute the binding limit");
  assert.match(generator, /maxChars: textLimit\.maxChars/, "the generator must cap the final text");

  // Publishing an over-limit caption must fail with a reason the user can act
  // on, not with whatever opaque error the provider returns.
  const publish = read("server/src/routes/posts.ts");
  assert.match(publish, /checkTextFits\(post\.content, platforms\)/);
  assert.match(publish, /de trop pour/);
});

test("the dashboard shows the limit before the post is published", () => {
  const dashboard = read("src/pages/Dashboard.tsx");
  assert.match(dashboard, /checkTextFits/);
  assert.match(dashboard, /caractères/);
});

test("the dashboard and the API server compute the same caption limit", () => {
  // These are two copies of one module. Comparing them byte for byte broke on
  // a comment; comparing their answers catches the drift that actually
  // matters — the dashboard promising a length the server then refuses.
  const cases = [
    [], ["LinkedIn"], ["Twitter"], ["Twitter (X)"], ["X"], ["Instagram"],
    ["Facebook"], ["LinkedIn", "Twitter"], ["Instagram", "LinkedIn"], ["Mastodon"],
  ];
  for (const platforms of cases) {
    assert.deepEqual(
      serverGetTextLimit(platforms),
      getTextLimit(platforms),
      `limit drift for ${JSON.stringify(platforms)}`,
    );
  }
  const text = "x".repeat(500);
  for (const platforms of cases) {
    assert.deepEqual(serverCheckTextFits(text, platforms), checkTextFits(text, platforms));
  }
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
  const route = read("server/src/routes/profile.ts");
  assert.match(route, /consumeQuota\(ctx\.profileId, "detect-audiences"/);
  assert.match(route, /releaseQuota\(ctx\.profileId, "detect-audiences"\)/);
});

// ---------------------------------------------------------------------------
// Zernio is the tenant boundary.
// ---------------------------------------------------------------------------

test("a user is never published through a shared provider profile", () => {
  // The old fallback to the operator's default profile meant a user could
  // publish to another user's connected social accounts. The connection now
  // carries its own key, and no key means refused, not "use the default".
  const publish = read("server/src/services/publish.ts");
  assert.match(publish, /WHERE profile_id = \$1 AND provider = 'zernio' AND is_active/);
  assert.match(publish, /!connection\.provider_profile_key/);
  assert.doesNotMatch(publish, /isDefault/);
});

test("provider accounts are only ever listed for one profile key", () => {
  // Omitting profileId makes the provider return every account across every
  // profile — other tenants' connected social accounts.
  const publish = read("server/src/services/publish.ts");
  assert.match(publish, /accountsUrl\.searchParams\.set\("profileId", profileKey\)/);
  assert.doesNotMatch(publish, /if \(profileId\) url\.searchParams\.set\("profileId"/);
});

// ---------------------------------------------------------------------------
// Account deletion must actually delete.
// ---------------------------------------------------------------------------

test("account deletion removes every row and every stored file", () => {
  const route = read("server/src/routes/misc.ts");
  // The password is re-verified: deletion is irreversible, so an open session
  // on a shared machine must not be enough on its own.
  assert.match(route, /verifyPassword\(password/);
  assert.match(route, /DELETE FROM profiles WHERE id = \$1/);
  assert.match(route, /deleteProfileMedia\(ctx\.profileId\)/);

  // The rows go with the profile through the schema rather than one delete
  // per table, which is what used to leave tables behind when one was added.
  const schema = read("server/migrations/0001_core_schema.sql");
  for (const table of ["posts", "media_assets", "social_comments", "social_connections",
                       "generation_jobs", "sessions"]) {
    const block = schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(
      block.slice(0, 1200),
      /profile_id\s+uuid NOT NULL REFERENCES profiles\(id\) ON DELETE CASCADE/,
      `${table} rows would survive the account being deleted`,
    );
  }
});

test("the comments inbox is read per tenant, never across profiles", () => {
  const route = read("server/src/routes/misc.ts");
  // Every read and every write is keyed on the session's profile id, so one
  // account's inbox can never show — or file — another account's comments.
  const inbox = route.slice(route.indexOf('app.get("/comments"'), route.indexOf('app.post("/comments/sync"'));
  assert.match(inbox, /requireTenant\(request, reply\)/);
  assert.match(inbox, /WHERE profile_id = \$1/);
});

test("the contact form cannot inject a line break into an email header", () => {
  const route = read("server/src/routes/misc.ts");
  // The subject and the sender name both reach a mail header, where a raw
  // CR/LF lets the sender append headers of their own.
  assert.match(route, /asHeaderSafe\(body\.subject, "subject"/);
  assert.match(route, /asHeaderSafe\(body\.name, "name"/);

  const validate = read("server/src/lib/validate.ts");
  const fn = validate.slice(validate.indexOf("export function asHeaderSafe"));
  assert.match(fn.slice(0, 600), /[\\r\\n]/, "asHeaderSafe must strip CR and LF");
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
