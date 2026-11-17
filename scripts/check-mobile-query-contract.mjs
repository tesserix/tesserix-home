import assert from "node:assert/strict";
import {createRequire} from "node:module";

const mobile = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const router = createRequire(mobile.resolve("expo-router/package.json"));
const query = router("query-string");

const parsed = query.parseUrl("helivanta://staff?name=Samyak%20Rout&label=%E0%AC%93%E0%AC%A1%E0%AC%BC%E0%AC%BF%E0%AC%B6%E0%AC%BE&tag=a&tag=b");
assert.equal(parsed.url, "helivanta://staff");
assert.equal(parsed.query.name, "Samyak Rout");
assert.equal(parsed.query.label, "ଓଡ଼ିଶା");
assert.deepEqual(parsed.query.tag, ["a", "b"]);
assert.equal(query.parse(query.stringify({name:"Staff & pharmacy", count:"2"})).name, "Staff & pharmacy");
assert.doesNotThrow(() => query.parse("bad=%E0%A4%A&percent=%&repeat=" + "%FF".repeat(2048)));
console.log("Expo Router query parsing and patched decoder interop verified.");
