import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as THREE from "three";
import {
  compositeSize,
  convertToTactile,
  sampleFloorModel,
  tactileDesignSchema,
} from "@bumps/floor-model";
import { gridPatternMetrics } from "./canvas-viewport";
import { buildReviewColors } from "./stl-preview";
import { TactileViewer } from "./tactile-viewer";

describe("map rendering", () => {
  test("places visible braille circles inside the validated top-left footprint", () => {
    const design = tactileDesignSchema.parse({
      schemaVersion: 1, mmPerPx: 1, plate: {}, legend: [],
      elements: [{ id: "key", kind: "braille", key: "c", at: { x: 10, y: 20 } }],
    });
    const markup = renderToStaticMarkup(createElement(TactileViewer, { design }));
    assert.deepEqual(markup.match(/<circle[^>]+>/g), [
      '<circle cx="10.75" cy="20.75" r="0.75">',
      '<circle cx="13.05" cy="20.75" r="0.75">',
    ]);
  });

  test("keeps each STL face a single review color", () => {
    const { design } = convertToTactile(sampleFloorModel);
    const braille = design.elements.find((element) => element.kind === "braille");
    assert.ok(braille?.kind === "braille");

    const x = braille.at.x + 0.5;
    const y = compositeSize(design).heightMm - (braille.at.y + 0.5);
    const baseTop = design.plate.baseMm + 0.02;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          x,
          y,
          baseTop,
          x,
          y,
          baseTop + 0.3,
          x,
          y,
          baseTop + 0.7,
          x - 12,
          y,
          baseTop + 0.3,
          x + 12,
          y,
          baseTop + 0.3,
          x,
          y + 12,
          baseTop + 0.3,
        ],
        3
      )
    );

    const colors = buildReviewColors(geometry, design);
    const first = [colors.getX(0), colors.getY(0), colors.getZ(0)];
    assert.deepEqual(
      [colors.getX(1), colors.getY(1), colors.getZ(1)],
      first
    );
    assert.deepEqual(
      [colors.getX(2), colors.getY(2), colors.getZ(2)],
      first
    );
    assert.notDeepEqual(
      [colors.getX(3), colors.getY(3), colors.getZ(3)],
      first
    );
  });

  test("keeps the viewport grid attached while panning and zooming", () => {
    assert.deepEqual(
      gridPatternMetrics(
        { scale: 2, tx: 10, ty: -5 },
        { originX: 3, originY: 7, step: 20 }
      ),
      { fine: 40, major: 200, x: 16, y: 9 }
    );
  });
});
