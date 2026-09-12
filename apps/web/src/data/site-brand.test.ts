import assert from "node:assert/strict";
import { test } from "node:test";
import { landingContent } from "./landing";
import { pagesContent } from "./pages";
import { pitchMetadata, pitchSlides } from "./pitch";
import { siteContent } from "./site";
import { galleryContent } from "./gallery";
import { mapContent } from "./map";

test("landing, pitch, and metadata consistently use Trace", () => {
  assert.equal(siteContent.title, "Trace");
  assert.equal(landingContent.hero.brand, siteContent.title);
  assert.equal(pitchMetadata.title, "Trace — product pitch");
  assert.match(pitchMetadata.description, /\bTrace\b/);
  assert.doesNotMatch(
    JSON.stringify([siteContent, landingContent, pagesContent, pitchMetadata, pitchSlides]),
    /\bbumps\b/i
  );
});

test("product copy distinguishes implemented checks and archived outputs from certification", () => {
  assert.match(landingContent.hero.compliance.lead, /Implemented geometry checks/);
  assert.equal(
    landingContent.hero.tagline,
    "No custom commissions. Upload a floor plan and print it for about $1 in filament.",
  );
  assert.doesNotMatch(JSON.stringify([landingContent, pagesContent, mapContent]), /ready to print|rule-by-rule against|standards-compliant/i);
  assert.match(mapContent.tactile.readyBadge, /ready to export/);
  assert.equal(galleryContent.entries.length, 11);
  for (const entry of galleryContent.entries) {
    assert.match(entry.description, /pre-port/i);
    assert.doesNotMatch(entry.description, /current|verified openings/i);
  }
});
