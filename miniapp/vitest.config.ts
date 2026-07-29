import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node, not jsdom. Everything under test here is pure logic — URL rewriting
    // and platform-string mapping — and each test stubs `globalThis.window` with
    // exactly the shape it needs. Pulling in jsdom would add a heavy dependency
    // and a real `window` whose defaults could mask a bug these tests exist to
    // catch, such as code assuming a browser global that Telegram does not set.
    environment: "node",

    // Only our own units. `app/` holds React components that would need a DOM
    // renderer, and node_modules ships plenty of its own tests.
    include: ["lib/**/*.test.ts"],
  },
});
