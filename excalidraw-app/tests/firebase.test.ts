import { vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";

import { saveFilesToFirebase, uploadBytesToFirebase } from "../data/firebase";

const { POST_URL } = vi.hoisted(() => {
  const POST_URL = "https://storage.test/api/v2/post/";
  vi.stubEnv("APP_BACKEND_V2_GET_URL", "https://storage.test/api/v2/");
  vi.stubEnv("APP_BACKEND_V2_POST_URL", POST_URL);
  return { POST_URL };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadBytesToFirebase", () => {
  it("should PUT the bytes to the storage backend", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await uploadBytesToFirebase(
      "/migrations/scenes/abc",
      new Uint8Array([1, 2]),
      { cacheControl: "public, max-age=60" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${POST_URL}migrations/scenes/abc`);
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({
      "content-type": "application/octet-stream",
      "cache-control": "public, max-age=60",
    });
  });

  it("should reject when the storage backend responds with an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    await expect(
      uploadBytesToFirebase("/migrations/scenes/abc", new Blob([])),
    ).rejects.toThrow();
  });
});

describe("saveFilesToFirebase", () => {
  it("should report files the storage backend fails to save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/bad")
          ? new Response(null, { status: 500 })
          : new Response(null, { status: 200 }),
      ),
    );

    const result = await saveFilesToFirebase({
      prefix: "/files/shareLinks/id",
      files: [
        { id: "good" as FileId, buffer: new Uint8Array([1]) },
        { id: "bad" as FileId, buffer: new Uint8Array([2]) },
      ],
    });

    expect(result).toEqual({
      savedFiles: ["good"],
      erroredFiles: ["bad"],
    });
  });
});
