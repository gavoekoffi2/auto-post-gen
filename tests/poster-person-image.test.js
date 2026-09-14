import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Behavioral tests for the pure poster-prompt helpers (Node strips the TS types
// on import), plus source assertions that lock the wiring end to end.
import {
  assembleSubject,
  brandFontDirection,
  imageStyleDirection,
  normalizePosterPerson,
  peopleTypeDirection,
  posterPersonBlock,
  posterPersonMisconfigured,
  POSTER_PERSON_MISSING_MESSAGE,
} from "../supabase/functions/_shared/posterPrompt.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const PHOTO = "https://project.supabase.co/storage/v1/object/public/user-assets/u1/poster-person-1.jpg";

test("the personal photo is only used when the user explicitly opted in", () => {
  assert.equal(normalizePosterPerson(null), null);
  assert.equal(normalizePosterPerson({ enabled: false, imageUrl: PHOTO }), null);
  assert.equal(normalizePosterPerson({ imageUrl: PHOTO }), null);
  assert.equal(normalizePosterPerson({ enabled: true, imageUrl: PHOTO })?.imageUrl, PHOTO);
});

test("only a public https URL can be handed to the poster engine", () => {
  // Graphiste GPT downloads this URL server-side.
  assert.equal(normalizePosterPerson({ enabled: true, imageUrl: "http://insecure/p.jpg" }), null);
  assert.equal(normalizePosterPerson({ enabled: true, imageUrl: "data:image/png;base64,AAAA" }), null);
  assert.equal(normalizePosterPerson({ enabled: true, imageUrl: "/local/p.jpg" }), null);
  assert.equal(normalizePosterPerson({ enabled: true, imageUrl: "" }), null);
  assert.equal(normalizePosterPerson({ enabled: true, imageUrl: `https://x/${"a".repeat(2100)}` }), null);
});

test("placement defaults to right and rejects unknown values", () => {
  assert.equal(normalizePosterPerson({ enabled: true, imageUrl: PHOTO }).placement, "right");
  assert.equal(normalizePosterPerson({ enabled: true, imageUrl: PHOTO, placement: "left" }).placement, "left");
  assert.equal(normalizePosterPerson({ enabled: true, imageUrl: PHOTO, placement: "CENTER" }).placement, "center");
  assert.equal(normalizePosterPerson({ enabled: true, imageUrl: PHOTO, placement: "diagonal" }).placement, "right");
});

test("the caption is trimmed to the stored 60-character limit", () => {
  const person = normalizePosterPerson({
    enabled: true,
    imageUrl: PHOTO,
    label: `  ${"x".repeat(80)}  `,
  });
  assert.equal(person.label.length, 60);
});

test("an opted-in profile with no usable photo is reported, never silently ignored", () => {
  assert.equal(posterPersonMisconfigured({ enabled: true, imageUrl: null }), true);
  assert.equal(posterPersonMisconfigured({ enabled: true, imageUrl: "http://x/p.jpg" }), true);
  assert.equal(posterPersonMisconfigured({ enabled: true, imageUrl: PHOTO }), false);
  assert.equal(posterPersonMisconfigured({ enabled: false, imageUrl: null }), false);
  assert.match(POSTER_PERSON_MISSING_MESSAGE, /photo/i);
});

test("the creative brief keeps the real face and puts the poster text beside it", () => {
  const block = posterPersonBlock(
    normalizePosterPerson({ enabled: true, imageUrl: PHOTO, label: "Awa — Fondatrice", placement: "right" }),
  );
  assert.match(block, /reference_image_url/);
  assert.match(block, /détourage/i);
  assert.match(block, /tiers droit/);
  // The post text must remain readable next to the person, never over the face.
  assert.match(block, /Réserve l'espace à gauche/);
  assert.match(block, /aucun texte ne doit recouvrir le visage/i);
  // Identity fidelity: no generated look-alike, no retouched skin tone.
  assert.match(block, /conserve exactement son visage/i);
  assert.match(block, /n'éclaircis pas la peau/i);
  assert.match(block, /"Awa — Fondatrice"/);

  const left = posterPersonBlock(normalizePosterPerson({ enabled: true, imageUrl: PHOTO, placement: "left" }));
  assert.match(left, /tiers gauche/);
  assert.match(left, /Réserve l'espace à droite/);
});

test("without a photo the brief forbids inventing a real-looking portrait", () => {
  const block = posterPersonBlock(null);
  assert.match(block, /Aucune photo réelle/);
  assert.doesNotMatch(block, /reference_image_url/);
});

test("saved visual preferences finally reach the poster engine", () => {
  // These profile columns were read from the DB but never sent anywhere, so
  // every poster ignored the user's choices.
  assert.match(imageStyleDirection("illustration"), /illustration/i);
  assert.match(imageStyleDirection("minimalist"), /minimaliste/i);
  assert.match(imageStyleDirection("corporate"), /corporate/i);
  assert.match(imageStyleDirection("flat_design"), /flat design/i);
  assert.match(imageStyleDirection(""), /photograph/i);
  assert.match(peopleTypeDirection("caucasian"), /caucasiennes/);
  assert.match(peopleTypeDirection("african"), /africaines/);
  assert.match(peopleTypeDirection(null), /africaines/);
  assert.match(brandFontDirection("Bebas Neue"), /Bebas Neue/);
  assert.equal(brandFontDirection(""), "");
});

test("both poster engines send the photo as reference_image_url and carry the brief", () => {
  const manual = read("supabase/functions/generate-image/index.ts");
  const shared = read("supabase/functions/_shared/graphiste.ts");

  for (const source of [manual, shared]) {
    assert.match(source, /reference_image_url = /);
    assert.match(source, /posterPersonBlock\(/);
    assert.match(source, /imageStyleDirection\(/);
    assert.match(source, /peopleTypeDirection\(/);
    assert.match(source, /brandFontDirection\(/);
    assert.match(source, /normalizePosterPerson/);
  }

  // The interactive path refuses to bill a poster without the promised person.
  assert.match(manual, /posterPersonMisconfigured/);
  assert.match(manual, /code:\s*"missing_person_image"/);
  assert.match(manual, /use_poster_person_image, poster_person_image_url, poster_person_label, poster_person_placement/);

  // The weekly cron passes the same profile settings.
  const weekly = read("supabase/functions/auto-generate-weekly/index.ts");
  assert.match(weekly, /use_poster_person_image === true/);
  assert.match(weekly, /poster_person_image_url/);
  assert.match(weekly, /imageStyle: profile\.image_style/);
});

test("profiles store the opt-in photo with database-level guarantees", () => {
  const migration = read("supabase/migrations/20260914000000_poster_person_image.sql");
  assert.match(migration, /use_poster_person_image boolean NOT NULL DEFAULT false/);
  assert.match(migration, /poster_person_image_url text/);
  assert.match(migration, /poster_person_placement text NOT NULL DEFAULT 'right'/);
  assert.match(migration, /char_length\(poster_person_label\) <= 60/);
  assert.match(migration, /poster_person_placement IN \('left', 'right', 'center'\)/);
  // A non-https URL can never be stored: the poster API must be able to fetch it.
  assert.match(migration, /poster_person_image_url ~ '\^https:\/\/'/);

  const types = read("src/integrations/supabase/types.ts");
  assert.match(types, /use_poster_person_image: boolean/);
  assert.match(types, /poster_person_image_url: string \| null/);
});

test("users can enable, preview and manage the photo from the app", () => {
  const component = read("src/components/PosterPersonImage.tsx");
  const profile = read("src/pages/Profile.tsx");
  const onboarding = read("src/pages/Onboarding.tsx");

  assert.match(component, /Ma photo sur chaque affiche/);
  // Upload guards mirror the storage bucket limits (5 MB, jpeg/png/webp).
  assert.match(component, /5 \* 1024 \* 1024/);
  assert.match(component, /"image\/jpeg", "image\/png", "image\/webp"/);
  assert.match(component, /from\("user-assets"\)/);
  assert.match(component, /getPublicUrl/);
  // The switch cannot be turned on without a photo.
  assert.match(component, /checked && !value\.imageUrl/);

  for (const source of [profile, onboarding]) {
    assert.match(source, /PosterPersonImage/);
    assert.match(source, /poster_person_placement/);
    // Never persist "enabled" without a stored photo.
    assert.match(source, /&& !!(formData\.posterPersonImageUrl|profile\.poster_person_image_url)/);
  }
});

test("the art direction is never truncated away — only the post excerpt shrinks", () => {
  // Joining everything and slicing the result used to cut the END of the brief
  // (interdictions, people direction, English direction) as soon as the user had
  // a long description plus a long permanent message.
  const brief = assembleSubject(
    [
      "PREMIERE DIRECTIVE",
      { prefix: "Message source: ", text: "m".repeat(5000) },
      "DERNIERE DIRECTIVE",
    ],
    900,
  );
  assert.ok(brief.startsWith("PREMIERE DIRECTIVE"));
  assert.ok(brief.endsWith("DERNIERE DIRECTIVE"), "the closing art direction must survive");
  assert.ok(brief.length <= 900);

  // Empty/blank lines are dropped instead of leaving holes in the brief.
  assert.equal(assembleSubject(["a", "", null, undefined, "b"]), "a\nb");
});

test("a poster brief with a personal photo still fits the subject budget", () => {
  const person = normalizePosterPerson({
    enabled: true,
    imageUrl: PHOTO,
    label: "z".repeat(60),
    placement: "center",
  });
  // ~850 chars worst case: it has to coexist with the rest of the direction.
  assert.ok(posterPersonBlock(person).length < 950, "the photo brief must stay compact");
});
