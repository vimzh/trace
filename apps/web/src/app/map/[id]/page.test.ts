import assert from "node:assert/strict";
import { test } from "node:test";
import { sampleFloorModel } from "@bumps/floor-model";
import { API_URL } from "@/lib/api";
import MapPage from "./page";

test("map SSR uses the runtime internal API origin and retains the local default", async (t) => {
  const previousOrigin = process.env.API_INTERNAL_URL;
  t.after(() => {
    if (previousOrigin === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = previousOrigin;
  });
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string) => {
    requested.push(input);
    return Response.json(input.endsWith("/model")
      ? { model: sampleFloorModel, version: 1 }
      : { id: "test-project", status: "parsed" });
  });

  for (const origin of [undefined, "http://api:3003"]) {
    if (origin === undefined) delete process.env.API_INTERNAL_URL;
    else process.env.API_INTERNAL_URL = origin;
    requested.length = 0;

    const page = await MapPage({
      params: Promise.resolve({ id: "test-project" }),
      searchParams: Promise.resolve({}),
    });

    assert.deepEqual(requested, [
      `${origin ?? API_URL}/projects/test-project`,
      `${origin ?? API_URL}/projects/test-project/model`,
    ]);
    assert.deepEqual(page.props, {
      initialModel: sampleFloorModel,
      initialVersion: 1,
      projectId: "test-project",
    });
  }
});
