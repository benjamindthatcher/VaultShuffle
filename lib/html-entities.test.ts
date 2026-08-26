import assert from "node:assert/strict";
import test from "node:test";
import { decodeHtmlEntities } from "./html-entities.ts";

test("Steam's quoted words read as quotes", () => {
  assert.equal(
    decodeHtmlEntities("creatures called &quot;Pals&quot; in this game"),
    'creatures called "Pals" in this game'
  );
});

test("the entities Steam actually uses all decode", () => {
  assert.equal(decodeHtmlEntities("Tom&rsquo;s"), "Tom’s");
  assert.equal(decodeHtmlEntities("A &amp; B"), "A & B");
  assert.equal(decodeHtmlEntities("Half-Life&trade;"), "Half-Life™");
  assert.equal(decodeHtmlEntities("wait&hellip;"), "wait…");
});

test("numeric and hex references decode", () => {
  assert.equal(decodeHtmlEntities("caf&#233;"), "café");
  assert.equal(decodeHtmlEntities("caf&#xE9;"), "café");
});

test("text without entities is returned untouched", () => {
  const plain = "Just a normal description.";
  assert.equal(decodeHtmlEntities(plain), plain);
  assert.equal(decodeHtmlEntities(""), "");
});

test("an unknown entity is left exactly as it was", () => {
  assert.equal(decodeHtmlEntities("&nope; &#0; &#xZZ;"), "&nope; &#0; &#xZZ;");
});

test("decoding does not run twice, so a literal &quot; survives", () => {
  // "&amp;quot;" means the author wanted to show &quot; on screen.
  assert.equal(decodeHtmlEntities("&amp;quot;"), "&quot;");
});

test("a tag cannot be smuggled in by double-encoding", () => {
  // Decodes once to text; React renders it as text, never as markup.
  assert.equal(decodeHtmlEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
});
