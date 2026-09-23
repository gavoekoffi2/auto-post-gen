import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authErrorMessage } from "../src/lib/authError.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("a dropped connection is explained, not shown as 'Failed to fetch'", () => {
  // The most common error a real user meets in this market, and it arrived
  // as three English words in an entirely French product.
  for (const raw of [
    "Failed to fetch",
    "NetworkError when attempting to fetch resource.",
    "TypeError: Load failed",
    "net::ERR_INTERNET_DISCONNECTED",
  ]) {
    const msg = authErrorMessage(new Error(raw), "FALLBACK");
    assert.match(msg, /Connexion au serveur impossible/, `not mapped: ${raw}`);
    assert.doesNotMatch(msg, /fetch|network/i);
  }
});

test("the auth errors a user actually hits are in French", () => {
  const cases = [
    ["Invalid login credentials", /Email ou mot de passe incorrect/],
    ["Email not confirmed", /email n'est pas encore confirmé/],
    ["User already registered", /Un compte existe déjà/],
    ["Password should be at least 8 characters", /mot de passe est trop court/],
    ["Email rate limit exceeded", /Trop d'emails demandés/],
    ["For security purposes, you can only request this after 60 seconds", /Trop de tentatives/],
    ["Token has expired or is invalid", /Ce lien a expiré/],
  ];
  for (const [raw, expected] of cases) {
    assert.match(authErrorMessage(new Error(raw), "FALLBACK"), expected, `not mapped: ${raw}`);
  }
});

test("an unknown provider message never reaches the user raw", () => {
  const msg = authErrorMessage(new Error("Some brand new English wording"), "Erreur de connexion.");
  assert.equal(msg, "Erreur de connexion.");
  // Accepts the shapes supabase-js actually throws.
  assert.equal(authErrorMessage({ message: "Invalid login credentials" }, "F"), "Email ou mot de passe incorrect.");
  assert.equal(authErrorMessage("Failed to fetch", "F").startsWith("Connexion au serveur"), true);
  assert.equal(authErrorMessage(null, "F"), "F");
  assert.equal(authErrorMessage(new Error(""), "F"), "F");
});

test("every screen that authenticates uses the mapper", () => {
  for (const page of [
    "src/pages/Auth.tsx",
    "src/pages/ForgotPassword.tsx",
    "src/pages/ResetPassword.tsx",
    "src/components/AccountSettings.tsx",
  ]) {
    const source = read(page);
    assert.match(source, /authErrorMessage\(/, `${page} must map its auth errors`);
    assert.doesNotMatch(
      source.replace(/\/\/.*$/gm, ""),
      /error instanceof Error \? error\.message : "Erreur lors de la connexion"/,
      `${page} still shows the provider message raw`,
    );
  }
});

test("the boot failure screen explains itself instead of showing nothing", () => {
  const main = read("src/main.tsx");
  // The ErrorBoundary cannot help here: the Supabase client validates its
  // env at module scope, so a build without it fails before React mounts.
  assert.match(main, /await import\("\.\/App\.tsx"\)/);
  assert.match(main, /L'application n'a pas pu démarrer/);
  // The error text is inserted as text, never as markup.
  assert.match(main, /pre\.textContent = detail/);
});
