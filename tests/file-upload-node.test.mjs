import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  FileUploadSchema,
  validate,
  validateFileUpload,
} from "../packages/contracts/dist/index.js";
import { fileHttp } from "../packages/contracts/dist/server.js";

const limits = {
  maxFilesPerMessage: 6,
  maxFileBytes: 8_000_000,
  maxMessageFileBytes: 24_000_000,
};
const operationId = "00000000-0000-0000-0000-000000000001";
const file = (data, size, order = 0) => ({
  id: `file_${order}`,
  order,
  name: `file-${order}.bin`,
  mediaType: "",
  size,
  data,
});
const upload = (files) => ({
  sessionId: "fixture-session",
  operationId,
  files,
});
const digest = (value) => createHash("sha256").update(value).digest("hex");

test("Node maximum file and three-file aggregate are accepted over shared HTTP", async () => {
  const original = Buffer.alloc(8_000_000, 0xa7);
  const data = original.toString("base64");
  const single = upload([file(data, original.length)]);
  assert.equal(validateFileUpload(single, limits), single);
  assert.equal(validate(FileUploadSchema, single), single);
  const triple = upload(
    Array.from({ length: 3 }, (_, order) => file(data, original.length, order)),
  );
  assert.equal(validateFileUpload(triple, limits), triple);
  const body = JSON.stringify(triple);
  let uploads = 0;
  const backend = {
    async upload(input, owner) {
      uploads++;
      assert.deepEqual(owner, {
        ownerId: "owner",
        sessionId: "fixture-session",
      });
      return {
        sessionId: input.sessionId,
        operationId: input.operationId,
        files: input.files.map((item) => {
          const bytes = Buffer.from(item.data, "base64");
          assert.equal(bytes.length, 8_000_000);
          assert.equal(digest(bytes), digest(original));
          return {
            id: item.id,
            order: item.order,
            ref: {
              attachmentId: `stored_${item.order}`,
              name: item.name,
              mediaType: item.mediaType,
              size: item.size,
              availability: "available",
            },
          };
        }),
      };
    },
    async file() {
      return null;
    },
  };
  const req = new Request("http://fixture/api/chat/files", {
    method: "POST",
    headers: { origin: "http://fixture", "content-type": "application/json" },
    body,
  });
  const result = await fileHttp(req, backend, async () => ({
    ownerId: "owner",
    sessionId: "fixture-session",
    limits,
  }));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).files.length, 3);
  assert.equal(uploads, 1);
  assert.throws(
    () =>
      validateFileUpload(upload([...triple.files, file("AA==", 1, 3)]), limits),
    /Files too large/,
  );
});

test("Base64 syntax, canonical tail, size and small inputs retain rejection boundaries", () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from([0]),
    Buffer.from([0, 255]),
    Buffer.from([0, 255, 7]),
    Buffer.from([0, 255, 7, 128]),
  ]) {
    const input = upload([file(bytes.toString("base64"), bytes.length)]);
    assert.equal(validateFileUpload(input, limits), input);
  }
  for (const data of [
    "A",
    "AAA",
    "A===",
    "=AAA",
    "AA=A",
    "AA==AAAA",
    "AAAA\n",
    "AA-_",
    "AA$=",
    "éAAA",
  ]) {
    const input = upload([file(data, 0)]);
    assert.throws(
      () => validate(FileUploadSchema, input),
      /Invalid chat payload/,
      data,
    );
    assert.throws(
      () => validateFileUpload(input, limits),
      /Invalid chat payload/,
      data,
    );
  }
  for (const data of ["AB==", "AAB="]) {
    assert.throws(
      () =>
        validateFileUpload(
          upload([file(data, data.endsWith("==") ? 1 : 2)]),
          limits,
        ),
      /Invalid base64/,
      data,
    );
  }
  assert.throws(
    () => validateFileUpload(upload([file("AA==", 0)]), limits),
    /Invalid file limits\/order/,
  );
  const huge = Buffer.alloc(8_000_000, 3).toString("base64");
  const invalidMiddle = `${huge.slice(0, 4_000_000)}!${huge.slice(4_000_001)}`;
  assert.throws(
    () => validateFileUpload(upload([file(invalidMiddle, 8_000_000)]), limits),
    /Invalid chat payload/,
  );
  assert.throws(
    () =>
      validateFileUpload(
        upload([file(`${huge.slice(0, -4)}AB==`, 8_000_000)]),
        limits,
      ),
    /Invalid base64/,
  );
  const tooLarge = Buffer.alloc(8_000_001).toString("base64");
  assert.throws(() =>
    validateFileUpload(upload([file(tooLarge, 8_000_001)]), limits),
  );
});
