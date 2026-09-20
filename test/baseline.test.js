import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/server.js";

test("领域样例可以解析", async () => {
  const files = (await readdir(new URL("../fixtures/", import.meta.url))).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const data = JSON.parse(await readFile(new URL(`../fixtures/${file}`, import.meta.url), "utf8"));
    assert.equal(typeof data.scenario, "string");
    assert.ok(Array.isArray(data.records));
  }
});

test("健康接口返回可用状态与资料版本", async (context) => {
  const dir = await mkdtemp(join(tmpdir(), "mct-base-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const server = await createApp({ dataPath: new URL(`file://${join(dir, "state.json")}`) });
  server.listen(0, "127.0.0.1");
  context.after(() => server.close());
  await once(server, "listening");
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "ok");
  assert.equal(typeof body.contextVersion, "string");
});
