import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();

globalThis.window = {
  crypto: globalThis.crypto,
  location: new URL("https://example.test/SeminarSmack/create.html"),
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key)
  },
  setTimeout,
  clearTimeout
};

globalThis.document = {
  body: { dataset: {} },
  addEventListener: () => {},
  createElement: () => ({
    setAttribute: () => {},
    style: {},
    select: () => {},
    remove: () => {}
  })
};

Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {}
});

const app = await import("../public/js/app.js");

test("validateSession normalizes a minimal valid poll session", () => {
  const result = app.validateSession({
    title: "  Week check  ",
    activities: [
      {
        id: "Poll One!",
        type: "POLL",
        question: "Ready?",
        options: ["Yes", "No", ""]
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.session.title, "Week check");
  assert.equal(result.session.activities[0].id, "poll-one");
  assert.deepEqual(result.session.activities[0].options, ["Yes", "No"]);
});

test("validateSession rejects missing activities", () => {
  const result = app.validateSession({ title: "Empty", activities: [] });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /At least one activity/);
});

test("randomToken returns a URL-safe token of the requested length", () => {
  const token = app.randomToken(40);

  assert.equal(token.length, 40);
  assert.match(token, /^[A-Za-z0-9]+$/);
});

test("signed events verify with the same token and fail with a different token", async () => {
  const payload = { activityId: "quiz-1", revision: 2 };
  const signed = await app.signEvent("reveal_answer", payload, "host-secret");

  assert.equal(await app.verifySignedEvent("reveal_answer", signed, "host-secret"), true);
  assert.equal(await app.verifySignedEvent("reveal_answer", signed, "other-secret"), false);
});

test("host token storage keys use sanitized room codes", () => {
  assert.equal(
    app.buildHostTokenStoreKey("SPARK 1234!"),
    "seminarsmack:host-token:spark1234"
  );
});
