import { describe, expect, it, vi } from "vitest";

import {
  CosenseAuthenticationError,
  CosenseReplaceLinksRetryableError,
  CosenseResponseError,
  CosenseUpstreamError,
  CosenseWriteConflictError,
  CosenseWriteOutcomeUnknownError,
  createCosenseClient,
} from "../src/cosense";

const TEST_PERSONAL_ACCESS_TOKEN = "test-only-cosense-pat-do-not-log-7bf3a921";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface JsonFixture {
  body?: unknown;
  status?: number;
}

function createFixtureFetch(...fixtures: JsonFixture[]): {
  fetcher: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let fixtureIndex = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    expectAuthenticatedJsonGet(call);
    const fixture = fixtures[fixtureIndex];
    fixtureIndex += 1;
    if (!fixture) throw new Error("Unexpected fetch call");
    return new Response(
      fixture.body === undefined ? null : JSON.stringify(fixture.body),
      {
        status: fixture.status ?? 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  return { fetcher, calls };
}

function expectAuthenticatedJsonGet(call: FetchCall): void {
  expect(call.init?.method).toBe("GET");
  expect(call.init?.cache).toBe("no-store");
  expect(call.init?.redirect).toBe("manual");
  expect(call.init?.signal).toBeDefined();
  expect(call.init).not.toHaveProperty("credentials");
  const headers = new Headers(call.init?.headers);
  expect(headers.get("accept")).toBe("application/json");
  expect(headers.has("authorization")).toBe(false);
  expect(headers.has("cookie")).toBe(false);
  expect(headers.get("x-personal-access-token")).toBe(
    TEST_PERSONAL_ACCESS_TOKEN,
  );
  expect(headers.has("x-service-account-access-key")).toBe(false);
}

interface WriteFixture {
  method: "GET" | "POST";
  body?: unknown | ((call: FetchCall) => unknown);
  status?: number;
  error?: unknown;
}

function createWriteFixtureFetch(...fixtures: WriteFixture[]): {
  fetcher: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let fixtureIndex = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    const fixture = fixtures[fixtureIndex];
    fixtureIndex += 1;
    if (!fixture) throw new Error("Unexpected fetch call");
    expect(init?.method).toBe(fixture.method);
    if (fixture.error !== undefined) throw fixture.error;
    const body =
      typeof fixture.body === "function" ? fixture.body(call) : fixture.body;
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: fixture.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetcher, calls };
}

function expectAuthenticatedJsonPost(call: FetchCall): void {
  expect(call.init?.method).toBe("POST");
  expect(call.init?.cache).toBe("no-store");
  expect(call.init?.redirect).toBe("manual");
  expect(call.init?.signal).toBeDefined();
  expect(call.init).not.toHaveProperty("credentials");
  const headers = new Headers(call.init?.headers);
  expect(headers.get("accept")).toBe("application/json");
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.has("authorization")).toBe(false);
  expect(headers.has("cookie")).toBe(false);
  expect(headers.get("x-personal-access-token")).toBe(
    TEST_PERSONAL_ACCESS_TOKEN,
  );
  expect(headers.has("x-service-account-access-key")).toBe(false);
}

function requestBody(call: FetchCall): Record<string, unknown> {
  expect(call.init?.body).toEqual(expect.any(String));
  return JSON.parse(call.init?.body as string) as Record<string, unknown>;
}

function missingPage(title: string): unknown {
  return { persistent: false, title };
}

function existingPage(
  title: string,
  commitId = "commit-before",
  id = "page-id",
): unknown {
  return {
    persistent: true,
    title,
    id,
    commitId,
    lines: [
      { id: "title-line", text: title },
      { id: "body-line", text: "existing" },
    ],
  };
}

function editablePage(
  title: string,
  body: string[],
  commitId = "commit-before",
  id = "page-id",
): unknown {
  return {
    persistent: true,
    title,
    id,
    commitId,
    lines: [
      { id: "title-line", text: title },
      ...body.map((text, index) => ({ id: `body-${index}`, text })),
    ],
  };
}

function appliedPreviewFromRequest(
  call: FetchCall,
  page: ReturnType<typeof editablePage>,
): unknown {
  const editable = page as {
    persistent: true;
    title: string;
    lines: { id: string; text: string }[];
  };
  const lines = editable.lines.map((line) => ({ ...line }));
  const changes = requestBody(call).changes as (
    | { _insert: string; lines: { id: string; text: string } }
    | { _update: string; lines: { text: string } }
    | { _delete: string }
  )[];

  for (const change of changes) {
    if ("_update" in change) {
      const line = lines.find(({ id }) => id === change._update);
      if (!line) throw new Error("Unknown update line in test fixture");
      line.text = change.lines.text;
    } else if ("_delete" in change) {
      const index = lines.findIndex(({ id }) => id === change._delete);
      if (index < 0) throw new Error("Unknown delete line in test fixture");
      lines.splice(index, 1);
    } else {
      const index =
        change._insert === "_end"
          ? lines.length
          : lines.findIndex(({ id }) => id === change._insert);
      if (index < 0) throw new Error("Unknown insert anchor in test fixture");
      lines.splice(index, 0, change.lines);
    }
  }

  return {
    previewId: "preview-id",
    expireAt: "2026-08-14T01:02:03.000Z",
    pagePreview: {
      title: lines[0]?.text ?? "",
      persistent: true,
      lines,
    },
  };
}

function previewFromRequest(
  call: FetchCall,
  options: {
    title: string;
    persistent: boolean;
    existingLines?: { id: string; text: string }[];
  },
): unknown {
  const body = requestBody(call);
  const changes = body.changes as {
    _insert: string;
    lines: { id: string; text: string };
  }[];
  return {
    previewId: "preview-id",
    expireAt: "2026-08-14T01:02:03.000Z",
    pagePreview: {
      title: options.title,
      persistent: options.persistent,
      lines: [
        ...(options.existingLines ?? []),
        ...changes.map(({ lines }) => lines),
      ],
    },
  };
}

describe("getPage", () => {
  it("encodes the complete title and returns only the compact existing-page shape", async () => {
    const { fetcher, calls } = createFixtureFetch({
      body: {
        persistent: true,
        title: "日本語 /%?#",
        id: "page-id",
        commitId: "commit-id",
        lines: [
          { id: "title-line", text: "日本語 /%?#" },
          { id: "body-1", text: "first" },
          { id: "body-2", text: "second" },
        ],
        created: 0,
        updated: 1,
        pageRank: 3.5,
        linked: 4,
        links: ["linked page"],
        user: { email: "must-not-leak@example.com" },
      },
    });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getPage({ title: " 日本語 /%?# " });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://scrapbox.io/api/pages/v2/shiyui/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%2F%25%3F%23",
    );
    expectAuthenticatedJsonGet(calls[0] as FetchCall);
    expect(result).toEqual({
      exists: true,
      title: "日本語 /%?#",
      canonicalUrl:
        "https://scrapbox.io/shiyui/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%2F%25%3F%23",
      pageId: "page-id",
      commitId: "commit-id",
      text: "first\nsecond",
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:01.000Z",
      pageRank: 3.5,
      linked: 4,
      links: ["linked page"],
    });
  });

  it("does not expose fake identifiers from a non-persistent page", async () => {
    const { fetcher } = createFixtureFetch({
      body: {
        persistent: false,
        title: "not created",
        id: "fake-page-id",
        commitId: "fake-commit-id",
        lines: [{ id: "fake-line-id", text: "not created" }],
        updated: 1,
      },
    });

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).getPage({
        title: "not created",
      }),
    ).resolves.toEqual({
      exists: false,
      title: "not created",
      canonicalUrl: "https://scrapbox.io/shiyui/not%20created",
    });
  });

  it("returns a normal missing-page result for a 404", async () => {
    const { fetcher } = createFixtureFetch({ status: 404 });

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).getPage({
        title: "not linked",
      }),
    ).resolves.toEqual({
      exists: false,
      title: "not linked",
      canonicalUrl: "https://scrapbox.io/shiyui/not%20linked",
    });
  });

  it("rejects blank input without making a request", async () => {
    const { fetcher, calls } = createFixtureFetch();

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).getPage({
        title: " \n ",
      }),
    ).rejects.toThrow("Must not be blank");
    expect(calls).toHaveLength(0);
  });

  it("rejects dot-segment titles before URL construction", async () => {
    const { fetcher, calls } = createFixtureFetch();

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).getPage({
        title: "..",
      }),
    ).rejects.toThrow("Dot-segment titles are not supported");
    expect(calls).toHaveLength(0);
  });

  it("reports a schema error when a persistent page lacks required identifiers", async () => {
    const { fetcher } = createFixtureFetch({
      body: {
        persistent: true,
        title: "broken",
        lines: [{ text: "broken" }],
      },
    });

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).getPage({
        title: "broken",
      }),
    ).rejects.toBeInstanceOf(CosenseResponseError);
  });
});

describe("request errors", () => {
  it.each([undefined, "", " \n "])(
    "rejects a missing or blank personal access token before fetching",
    (personalAccessToken) => {
      const fetcher: typeof fetch = vi.fn();

      expect(() =>
        createCosenseClient(personalAccessToken as string, fetcher),
      ).toThrow("Cosense Personal Access Token is required.");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403])(
    "reports HTTP %i as a safe authentication error",
    async (status) => {
      const upstreamBody = `upstream authentication details: ${TEST_PERSONAL_ACCESS_TOKEN}`;
      const response = new Response(upstreamBody, { status });
      const jsonSpy = vi.spyOn(response, "json");
      const textSpy = vi.spyOn(response, "text");
      const calls: FetchCall[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const call = { url: String(input), init };
        calls.push(call);
        expectAuthenticatedJsonGet(call);
        return response;
      };

      const error = await createCosenseClient(
        TEST_PERSONAL_ACCESS_TOKEN,
        fetcher,
      )
        .searchFullText({ query: "private query" })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );

      expect(error).toBeInstanceOf(CosenseAuthenticationError);
      expect(error).toMatchObject({
        name: "CosenseAuthenticationError",
        status,
        operation: "full-text search",
        message: "Cosense authentication failed.",
      });
      expect(calls).toHaveLength(1);
      expect(String(error)).not.toContain(upstreamBody);
      expect(String(error)).not.toContain(TEST_PERSONAL_ACCESS_TOKEN);
      expect(JSON.stringify(error)).not.toContain(upstreamBody);
      expect(JSON.stringify(error)).not.toContain(TEST_PERSONAL_ACCESS_TOKEN);
      expect(jsonSpy).not.toHaveBeenCalled();
      expect(textSpy).not.toHaveBeenCalled();
      expect(response.bodyUsed).toBe(false);
    },
  );

  it.each([301, 302])("does not follow HTTP %i redirects", async (status) => {
    const location = "https://example.invalid/redirected";
    const response = new Response("redirect details", {
      status,
      headers: { Location: location },
    });
    const jsonSpy = vi.spyOn(response, "json");
    const textSpy = vi.spyOn(response, "text");
    const calls: FetchCall[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const call = { url: String(input), init };
      calls.push(call);
      expectAuthenticatedJsonGet(call);
      return response;
    };

    const error = await createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher)
      .searchFullText({ query: "redirect query" })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(CosenseUpstreamError);
    expect(error).toMatchObject({
      name: "CosenseUpstreamError",
      status,
      operation: "full-text search",
      message: `Cosense full-text search request failed with status ${status}.`,
    });
    expect(calls).toHaveLength(1);
    expect(String(error)).not.toContain(location);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });

  it("does not read or expose a non-2xx response body", async () => {
    const response = new Response("secret upstream details", { status: 429 });
    const jsonSpy = vi.spyOn(response, "json");
    const textSpy = vi.spyOn(response, "text");
    const fetcher: typeof fetch = async (input, init) => {
      expectAuthenticatedJsonGet({ url: String(input), init });
      return response;
    };

    const promise = createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).searchFullText({ query: "private query" });

    await expect(promise).rejects.toMatchObject({
      name: "CosenseUpstreamError",
      status: 429,
      operation: "full-text search",
      message: "Cosense full-text search request failed with status 429.",
    });
    await expect(promise).rejects.not.toThrow("secret upstream details");
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });

  it("wraps malformed JSON as a response error", async () => {
    const fetcher: typeof fetch = async (input, init) => {
      expectAuthenticatedJsonGet({ url: String(input), init });
      return new Response("not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).searchVector({
        query: "query",
      }),
    ).rejects.toMatchObject({
      name: "CosenseResponseError",
      operation: "vector search",
      message: "Cosense returned an invalid vector search response.",
    });
  });

  it("combines caller cancellation with a fixed upstream timeout", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutSignal);
    const caller = new AbortController();
    let resolveSignal: ((signal: AbortSignal) => void) | undefined;
    const capturedSignal = new Promise<AbortSignal>((resolve) => {
      resolveSignal = resolve;
    });
    const fetcher: typeof fetch = async (_input, init) => {
      expectAuthenticatedJsonGet({ url: String(_input), init });
      const requestSignal = init?.signal;
      if (!requestSignal) throw new Error("Missing request signal");
      resolveSignal?.(requestSignal);
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => {
          reject(requestSignal.reason);
        });
      });
    };

    const promise = createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).searchVector({ query: "query" }, caller.signal);

    const requestSignal = await capturedSignal;
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    expect(requestSignal).not.toBe(caller.signal);
    expect(requestSignal.aborted).toBe(false);
    caller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignal.aborted).toBe(true);
    timeoutSpy.mockRestore();
  });

  it("rejects oversized URL components and candidate limits before fetching", async () => {
    const fetcher: typeof fetch = vi.fn();
    const client = createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher);
    const oversized = "日".repeat(501);

    await expect(client.getPage({ title: oversized })).rejects.toThrow();
    await expect(client.searchFullText({ query: oversized })).rejects.toThrow();
    await expect(client.searchVector({ query: oversized })).rejects.toThrow();
    await expect(
      client.getRelatedPages({ title: "page", hop: 2, cursor: oversized }),
    ).rejects.toThrow();
    await expect(
      client.getRelatedPages({ title: "page", hop: 2, cursor: " \n " }),
    ).rejects.toThrow("Must not be blank");
    await expect(
      client.searchFullText({ query: "query", limit: 101 }),
    ).rejects.toThrow();
    await expect(
      client.searchVector({ query: "query", limit: 101 }),
    ).rejects.toThrow();
    await expect(
      client.getRelatedPages({ title: "page", hop: 2, limit: 101 }),
    ).rejects.toThrow();

    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("searchFullText", () => {
  it("uses URLSearchParams, OR matching, local limits, and compact results", async () => {
    const { fetcher, calls } = createFixtureFetch({
      body: {
        count: 25,
        existsExactTitleMatch: true,
        pages: [
          {
            title: "first / page",
            lines: ["first match", "second match"],
            words: ["検索", "word"],
            updated: 1,
            pageRank: 9,
            id: "not-returned",
          },
          {
            title: "second",
            lines: ["another match"],
            words: ["検索"],
          },
          {
            title: "third",
            lines: ["locally omitted"],
            words: ["検索"],
          },
        ],
      },
    });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).searchFullText({
      query: "検索 /%?#",
      match: "or",
      sort: "updated",
      limit: 2,
    });

    expect(calls[0]?.url).toBe(
      "https://scrapbox.io/api/pages/shiyui/search/query?q=%E6%A4%9C%E7%B4%A2+%2F%25%3F%23&op=or&sort=updated",
    );
    expectAuthenticatedJsonGet(calls[0] as FetchCall);
    expect(result).toEqual({
      reportedCount: 25,
      exactTitleMatch: true,
      returned: 2,
      truncated: true,
      results: [
        {
          title: "first / page",
          snippet: "first match\nsecond match",
          matchedWords: ["検索", "word"],
          updatedAt: "1970-01-01T00:00:01.000Z",
          pageRank: 9,
          canonicalUrl: "https://scrapbox.io/shiyui/first%20%2F%20page",
        },
        {
          title: "second",
          snippet: "another match",
          matchedWords: ["検索"],
          canonicalUrl: "https://scrapbox.io/shiyui/second",
        },
      ],
    });
  });

  it("omits op for AND matching and uses the default sort and limit", async () => {
    const pages = Array.from({ length: 21 }, (_, index) => ({
      title: `page-${index}`,
      lines: [],
      words: [],
    }));
    const { fetcher, calls } = createFixtureFetch({ body: { pages } });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).searchFullText({ query: "alpha beta" });

    expect(calls[0]?.url).toBe(
      "https://scrapbox.io/api/pages/shiyui/search/query?q=alpha+beta&sort=pageRank",
    );
    expect(calls[0]?.url).not.toContain("op=");
    expect(result).toMatchObject({ returned: 20, truncated: true });
  });

  it("bounds candidate context without fetching page bodies", async () => {
    const { fetcher, calls } = createFixtureFetch({
      body: {
        pages: [
          {
            title: "long candidate",
            lines: Array.from({ length: 6 }, () => "x".repeat(300)),
            words: Array.from({ length: 21 }, (_, index) => `word-${index}`),
          },
          {
            title: "many lines",
            lines: ["one", "two", "three", "four", "five", "six"],
            words: [],
          },
        ],
      },
    });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).searchFullText({ query: "candidate" });

    expect(calls).toHaveLength(1);
    expect(result.results[0]?.snippet).toHaveLength(1_200);
    expect(result.results[0]?.matchedWords).toHaveLength(20);
    expect(result.results[1]?.snippet).toBe("one\ntwo\nthree\nfour\nfive");
  });
});

describe("searchVector", () => {
  it("sends only q and reports local truncation", async () => {
    const { fetcher, calls } = createFixtureFetch({
      body: {
        pages: [
          {
            title: "real page",
            score: 0.9,
            exists: true,
            updated: 2,
            pageRank: 8,
          },
          { title: "empty page", score: 0.8, exists: false },
          { title: "omitted", score: 0.7, exists: true },
        ],
      },
    });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).searchVector({
      query: "意味 /%?#",
      limit: 2,
    });

    expect(calls[0]?.url).toBe(
      "https://scrapbox.io/api/pages/shiyui/search/vector/titles?q=%E6%84%8F%E5%91%B3+%2F%25%3F%23",
    );
    expect(new URL(calls[0]?.url as string).searchParams.has("limit")).toBe(
      false,
    );
    expectAuthenticatedJsonGet(calls[0] as FetchCall);
    expect(result).toEqual({
      returned: 2,
      localTruncated: true,
      results: [
        {
          title: "real page",
          score: 0.9,
          exists: true,
          canonicalUrl: "https://scrapbox.io/shiyui/real%20page",
          updatedAt: "1970-01-01T00:00:02.000Z",
          pageRank: 8,
        },
        {
          title: "empty page",
          score: 0.8,
          exists: false,
          canonicalUrl: "https://scrapbox.io/shiyui/empty%20page",
        },
      ],
    });
  });
});

describe("getRelatedPages", () => {
  it("cancels both 1-hop requests when the caller aborts", async () => {
    const caller = new AbortController();
    const requestSignals: AbortSignal[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      expectAuthenticatedJsonGet({ url: String(input), init });
      const requestSignal = init?.signal;
      if (!requestSignal) throw new Error("Missing request signal");
      requestSignals.push(requestSignal);
      return new Promise<Response>((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => {
          reject(requestSignal.reason);
        });
      });
    };

    const promise = createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getRelatedPages({ title: "Base Page", hop: 1 }, caller.signal);

    expect(requestSignals).toHaveLength(2);
    caller.abort();

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("calculates all 1-hop relation variants from normalized link fields", async () => {
    const { fetcher, calls } = createFixtureFetch(
      {
        body: {
          title: "Base Page",
          links: ["Outgoing Page", "Both Page"],
          ignored: "field",
        },
      },
      {
        body: {
          links1hop: [
            {
              title: "Outgoing Page",
              titleLc: "outgoing_page",
              linksLc: [],
              descriptions: ["out"],
            },
            {
              title: "Incoming Page",
              titleLc: "incoming_page",
              linksLc: ["base_page"],
              descriptions: ["in"],
            },
            {
              title: "Both Page",
              titleLc: "both_page",
              linksLc: ["base_page"],
              descriptions: ["both"],
            },
          ],
          pagination: {
            total: 9,
            hasNext: true,
            nextId: "next /%?#",
            perPage: 3,
          },
        },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getRelatedPages({ title: "Base Page", hop: 1, limit: 3 });

    expect(calls.map(({ url }) => url)).toEqual([
      "https://scrapbox.io/api/pages/v2/shiyui/Base%20Page",
      "https://scrapbox.io/api/pages/v2/shiyui/Base%20Page/links1hop?perPage=3",
    ]);
    for (const call of calls) expectAuthenticatedJsonGet(call);
    expect(result).toEqual({
      total: 9,
      hasNext: true,
      nextCursor: "next /%?#",
      returned: 3,
      results: [
        {
          title: "Outgoing Page",
          descriptions: ["out"],
          relation: "outgoing",
          canonicalUrl: "https://scrapbox.io/shiyui/Outgoing%20Page",
        },
        {
          title: "Incoming Page",
          descriptions: ["in"],
          relation: "incoming",
          canonicalUrl: "https://scrapbox.io/shiyui/Incoming%20Page",
        },
        {
          title: "Both Page",
          descriptions: ["both"],
          relation: "bidirectional",
          canonicalUrl: "https://scrapbox.io/shiyui/Both%20Page",
        },
      ],
    });
  });

  it("uses input-title normalization, the default limit, and empty links when the base page is 404", async () => {
    const { fetcher, calls } = createFixtureFetch(
      { status: 404, body: { secret: "not read" } },
      {
        body: {
          links1hop: [
            {
              title: "Backlink",
              titleLc: "backlink",
              linksLc: ["base_page"],
            },
          ],
          pagination: { hasNext: false },
        },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getRelatedPages({ title: "Base Page", hop: 1 });

    expect(calls[1]?.url).toBe(
      "https://scrapbox.io/api/pages/v2/shiyui/Base%20Page/links1hop?perPage=20",
    );
    expect(result.results[0]?.relation).toBe("incoming");
  });

  it("propagates non-404 base-page failures", async () => {
    const { fetcher } = createFixtureFetch(
      { status: 503 },
      { body: { links1hop: [], pagination: { hasNext: false } } },
    );

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).getRelatedPages({
        title: "Base Page",
        hop: 1,
      }),
    ).rejects.toBeInstanceOf(CosenseUpstreamError);
  });

  it("omits relation when the base page has no link fields", async () => {
    const { fetcher } = createFixtureFetch(
      { body: { title: "Base Page" } },
      {
        body: {
          links1hop: [
            {
              title: "Candidate",
              titleLc: "candidate",
              linksLc: ["base_page"],
            },
          ],
          pagination: { hasNext: false },
        },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getRelatedPages({ title: "Base Page", hop: 1 });

    expect(result.results[0]).not.toHaveProperty("relation");
  });

  it("builds the complete 2-hop search URL and never adds relation", async () => {
    const { fetcher, calls } = createFixtureFetch({
      body: {
        links2hop: [
          {
            title: "Candidate / one",
            descriptions: ["x".repeat(300), "2", "3", "4", "5", "omitted"],
            pageRank: 2,
            linked: 3,
            updated: 4,
            titleLc: "not-validated-for-2-hop",
          },
        ],
        pagination: { total: 1, hasNext: false, nextId: null },
      },
    });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getRelatedPages({
      title: "日本語 /%?#",
      hop: 2,
      query: "検索 /%?#",
      match: "or",
      limit: 7,
      cursor: "cursor /%?#",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://scrapbox.io/api/pages/v2/shiyui/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%2F%25%3F%23/links2hop?perPage=7&search=%E6%A4%9C%E7%B4%A2+%2F%25%3F%23&op=or&nextId=cursor+%2F%25%3F%23",
    );
    expectAuthenticatedJsonGet(calls[0] as FetchCall);
    expect(result).toEqual({
      total: 1,
      hasNext: false,
      returned: 1,
      results: [
        {
          title: "Candidate / one",
          descriptions: ["x".repeat(240), "2", "3", "4", "5"],
          pageRank: 2,
          linked: 3,
          updatedAt: "1970-01-01T00:00:04.000Z",
          canonicalUrl: "https://scrapbox.io/shiyui/Candidate%20%2F%20one",
        },
      ],
    });
    expect(result.results[0]).not.toHaveProperty("relation");
    expect(result).not.toHaveProperty("nextCursor");
  });

  it("enforces the local limit when related endpoints return too many pages", async () => {
    const relatedPages = ["first", "second", "third"].map((title) => ({
      title,
    }));
    const { fetcher } = createFixtureFetch({
      body: {
        links2hop: relatedPages,
        pagination: { total: 3, hasNext: true, nextId: "next" },
      },
    });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getRelatedPages({ title: "page", hop: 2, limit: 2 });

    expect(result).toMatchObject({
      total: 3,
      hasNext: true,
      nextCursor: "next",
      returned: 2,
    });
    expect(result.results.map(({ title }) => title)).toEqual([
      "first",
      "second",
    ]);
  });

  it("enforces the local limit for 1-hop results too", async () => {
    const { fetcher } = createFixtureFetch(
      { body: { title: "Base", links: [] } },
      {
        body: {
          links1hop: ["first", "second", "third"].map((title) => ({
            title,
            titleLc: title,
            linksLc: [],
          })),
          pagination: { total: 3, hasNext: false },
        },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getRelatedPages({ title: "Base", hop: 1, limit: 2 });

    expect(result.returned).toBe(2);
    expect(result.results.map(({ title }) => title)).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps the longest accepted related URL below the Worker limit", async () => {
    const { fetcher, calls } = createFixtureFetch({
      body: {
        links2hop: [],
        pagination: { hasNext: false },
      },
    });
    const value = "日".repeat(500);

    await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getRelatedPages({
      title: value,
      hop: 2,
      query: value,
      limit: 100,
      cursor: value,
    });

    expect(calls[0]?.url).toContain("perPage=100");
    expect(new TextEncoder().encode(calls[0]?.url).byteLength).toBeLessThan(
      16 * 1_024,
    );
  });

  it("rejects pagination that advertises a next page without a cursor", async () => {
    const { fetcher } = createFixtureFetch({
      body: {
        links2hop: [],
        pagination: { hasNext: true, nextId: "" },
      },
    });

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).getRelatedPages({
        title: "page",
        hop: 2,
      }),
    ).rejects.toBeInstanceOf(CosenseResponseError);
  });
});

describe("listPages", () => {
  it("uses a default limit of 20 and accepts the explicit maximum of 1000", async () => {
    const emptyList = (limit: number) => ({
      projectName: "shiyui",
      count: 0,
      limit,
      skip: 0,
      pages: [],
    });
    const { fetcher, calls } = createFixtureFetch(
      { body: emptyList(20) },
      { body: emptyList(1_000) },
    );
    const client = createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher);

    await client.listPages({});
    await client.listPages({ limit: 1_000 });

    expect(calls.map(({ url }) => url)).toEqual([
      "https://scrapbox.io/api/pages/shiyui/?sort=updated&limit=20&skip=0",
      "https://scrapbox.io/api/pages/shiyui/?sort=updated&limit=1000&skip=0",
    ]);
  });

  it("returns compact metadata with explicit offset pagination in one request", async () => {
    const { fetcher, calls } = createFixtureFetch({
      body: {
        projectName: "shiyui",
        count: 8,
        limit: 2,
        skip: 3,
        pages: [
          {
            id: "page-id-1",
            title: "first / page",
            descriptions: ["description", "x".repeat(300)],
            pin: 1,
            views: 2,
            linked: 3,
            linesCount: 4,
            charsCount: 5,
            created: 1,
            updated: 2,
            accessed: 3,
            user: { id: "must-not-leak", email: "must-not-leak@example.com" },
          },
          {
            id: "page-id-2",
            title: "second",
          },
        ],
      },
    });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).listPages({ sort: "title", limit: 2, skip: 3 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://scrapbox.io/api/pages/shiyui/?sort=title&limit=2&skip=3",
    );
    expectAuthenticatedJsonGet(calls[0] as FetchCall);
    expect(result).toEqual({
      reportedCount: 8,
      skip: 3,
      returned: 2,
      hasNext: true,
      nextSkip: 5,
      results: [
        {
          pageId: "page-id-1",
          title: "first / page",
          canonicalUrl: "https://scrapbox.io/shiyui/first%20%2F%20page",
          descriptions: ["description", "x".repeat(240)],
          pin: 1,
          views: 2,
          linked: 3,
          linesCount: 4,
          charsCount: 5,
          createdAt: "1970-01-01T00:00:01.000Z",
          updatedAt: "1970-01-01T00:00:02.000Z",
          accessedAt: "1970-01-01T00:00:03.000Z",
        },
        {
          pageId: "page-id-2",
          title: "second",
          canonicalUrl: "https://scrapbox.io/shiyui/second",
          descriptions: [],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("rejects list inputs above 1000 and negative offsets before fetching", async () => {
    const { fetcher, calls } = createFixtureFetch();
    const client = createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher);

    await expect(client.listPages({ limit: 1_001 })).rejects.toThrow();
    await expect(client.listPages({ skip: -1 })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("getPageChanges", () => {
  it("uses the commit cursor, resolves actor names, and omits private identifiers", async () => {
    const { fetcher, calls } = createFixtureFetch(
      {
        body: {
          commits: [
            {
              id: "commit-1",
              userId: "user-1",
              created: 1,
              changes: [
                { title: "renamed / page" },
                {
                  _insert: "line-1",
                  lines: { id: "line-1", text: "inserted" },
                },
                {
                  _update: "line-2",
                  lines: { id: "line-2", origText: "old", text: "middle" },
                },
              ],
            },
            {
              id: "commit-2",
              userId: "user-2",
              created: 2,
              changes: [
                {
                  _update: "line-2",
                  lines: { id: "line-2", origText: "middle", text: "new" },
                },
                {
                  _delete: "line-3",
                  lines: { id: "line-3", origText: "deleted" },
                },
                { links: ["ignored metadata"] },
              ],
            },
            {
              id: "commit-3",
              userId: "service-1",
              created: 3,
              changes: [
                {
                  _insert: "line-4",
                  lines: { id: "line-4", text: "automated" },
                },
              ],
            },
          ],
        },
      },
      {
        body: {
          users: [
            {
              id: "user-1",
              displayName: "Alice",
              email: "must-not-leak@example.com",
            },
          ],
          memberSnapshots: [{ data: { id: "user-2", name: "Bob" } }],
          serviceAccounts: [{ id: "service-1", usage: "Change bot" }],
        },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getPageChanges({
      pageId: " page /%?# ",
      commitId: " head /%?# ",
    });

    expect(calls).toHaveLength(2);
    expect(calls.map(({ url }) => url)).toEqual([
      "https://scrapbox.io/api/commits/shiyui/page%20%2F%25%3F%23?head=head+%2F%25%3F%23",
      "https://scrapbox.io/api/projects/shiyui/users",
    ]);
    for (const call of calls) expectAuthenticatedJsonGet(call);
    expect(result).toEqual({
      pageId: "page /%?#",
      afterCommitId: "head /%?#",
      commitCount: 3,
      totalChanges: 5,
      returned: 5,
      truncated: false,
      latestCommitId: "commit-3",
      latestTitleChange: {
        title: "renamed / page",
        canonicalUrl: "https://scrapbox.io/shiyui/renamed%20%2F%20page",
      },
      changes: [
        {
          kind: "title",
          authors: ["Alice"],
          createdAt: "1970-01-01T00:00:01.000Z",
          after: "renamed / page",
        },
        {
          kind: "insert",
          authors: ["Alice"],
          createdAt: "1970-01-01T00:00:01.000Z",
          after: "inserted",
        },
        {
          kind: "update",
          authors: ["Alice", "Bob"],
          createdAt: "1970-01-01T00:00:02.000Z",
          before: "old",
          after: "new",
        },
        {
          kind: "delete",
          authors: ["Bob"],
          createdAt: "1970-01-01T00:00:02.000Z",
          before: "deleted",
        },
        {
          kind: "insert",
          authors: ["Change bot (service account)"],
          createdAt: "1970-01-01T00:00:03.000Z",
          after: "automated",
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("must-not-leak@example.com");
    expect(serialized).not.toContain("user-1");
    expect(serialized).not.toContain("line-1");
  });

  it("bounds returned events and change text without additional requests", async () => {
    const changes = Array.from({ length: 101 }, (_, index) => ({
      _insert: `line-${index}`,
      lines: { id: `line-${index}`, text: `${index}:${"x".repeat(2_100)}` },
    }));
    const { fetcher, calls } = createFixtureFetch(
      { body: { commits: [{ id: "latest", changes }] } },
      { body: {} },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).getPageChanges({ pageId: "page-id" });

    expect(calls).toHaveLength(2);
    expect(calls.map(({ url }) => url)).toEqual([
      "https://scrapbox.io/api/commits/shiyui/page-id",
      "https://scrapbox.io/api/projects/shiyui/users",
    ]);
    expect(result).toMatchObject({
      commitCount: 1,
      totalChanges: 101,
      returned: 100,
      truncated: true,
      latestCommitId: "latest",
    });
    expect(result).not.toHaveProperty("afterCommitId");
    expect(result.changes[0]?.after?.startsWith("1:")).toBe(true);
    expect(result.changes[0]?.after).toHaveLength(2_000);
  });

  it("rejects invalid page and commit IDs before fetching", async () => {
    const { fetcher, calls } = createFixtureFetch();
    const client = createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher);

    await expect(client.getPageChanges({ pageId: ".." })).rejects.toThrow();
    await expect(
      client.getPageChanges({ pageId: "page-id", commitId: " \n " }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("createPage", () => {
  it("uses GET, preview, GET, submit and creates the exact requested lines", async () => {
    const title = "山形 /%?#";
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: missingPage(title) },
      {
        method: "POST",
        body: (call: FetchCall) => {
          const body = requestBody(call);
          expect(body).not.toHaveProperty("pageId");
          const changes = body.changes as {
            _insert: string;
            lines: { id: string; text: string };
          }[];
          expect(changes.map(({ _insert }) => _insert)).toEqual([
            "_end",
            "_end",
            "_end",
          ]);
          expect(changes.map(({ lines }) => lines.text)).toEqual([
            title,
            " 蔵王 ",
            "銀山温泉",
          ]);
          expect(
            changes.every(({ lines }) => /^[0-9a-f]{24}$/.test(lines.id)),
          ).toBe(true);
          expect(new Set(changes.map(({ lines }) => lines.id))).toHaveProperty(
            "size",
            3,
          );
          return previewFromRequest(call, { title, persistent: false });
        },
      },
      { method: "GET", body: missingPage(title) },
      {
        method: "POST",
        body: (call: FetchCall) => {
          expect(requestBody(call)).toEqual({ previewId: "preview-id" });
          return {
            commitId: "commit-after",
            page: { title },
          };
        },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).createPage({ title: `  ${title}  `, text: " 蔵王 \r\n銀山温泉" });

    expect(calls).toHaveLength(4);
    expect(calls.map(({ url }) => url)).toEqual([
      "https://scrapbox.io/api/pages/v2/shiyui/%E5%B1%B1%E5%BD%A2%20%2F%25%3F%23",
      "https://scrapbox.io/api/pages/v2/shiyui/page-edit-for-ai/preview",
      "https://scrapbox.io/api/pages/v2/shiyui/%E5%B1%B1%E5%BD%A2%20%2F%25%3F%23",
      "https://scrapbox.io/api/pages/v2/shiyui/page-edit-for-ai/submit",
    ]);
    expect(calls.map(({ init }) => init?.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
    expectAuthenticatedJsonGet(calls[0] as FetchCall);
    expectAuthenticatedJsonPost(calls[1] as FetchCall);
    expectAuthenticatedJsonGet(calls[2] as FetchCall);
    expectAuthenticatedJsonPost(calls[3] as FetchCall);
    expect(result).toEqual({
      action: "create",
      title,
      canonicalUrl:
        "https://scrapbox.io/shiyui/%E5%B1%B1%E5%BD%A2%20%2F%25%3F%23",
      commitId: "commit-after",
      addedLines: 3,
    });
  });

  it("creates a title-only page from blank text", async () => {
    const title = "title only";
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: missingPage(title) },
      {
        method: "POST",
        body: (call: FetchCall) => {
          const changes = requestBody(call).changes as {
            _insert: string;
            lines: { id: string; text: string };
          }[];
          expect(changes).toHaveLength(1);
          expect(changes[0]?.lines.text).toBe(title);
          return previewFromRequest(call, { title, persistent: false });
        },
      },
      { method: "GET", body: missingPage(title) },
      {
        method: "POST",
        body: { commitId: "commit-after", page: { title } },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).createPage({ title, text: "" });

    expect(calls).toHaveLength(4);
    expect(result).toMatchObject({
      action: "create",
      title,
      addedLines: 1,
    });
  });

  it("stops before preview when a persistent page already exists", async () => {
    const { fetcher, calls } = createWriteFixtureFetch({
      method: "GET",
      body: existingPage("山形"),
    });

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).createPage({
        title: "山形",
        text: "行きたい",
      }),
    ).rejects.toMatchObject({
      name: "CosenseWriteConflictError",
      reason: "page-already-exists",
      operation: "page create",
    });
    expect(calls).toHaveLength(1);
  });

  it("stops before submit when the title appears after preview", async () => {
    const title = "山形";
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: missingPage(title) },
      {
        method: "POST",
        body: (call: FetchCall) =>
          previewFromRequest(call, { title, persistent: false }),
      },
      { method: "GET", body: existingPage(title) },
    );

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).createPage({
        title,
        text: "行きたい",
      }),
    ).rejects.toBeInstanceOf(CosenseWriteConflictError);
    expect(calls).toHaveLength(3);
  });

  it("rejects a preview whose complete page does not match the request", async () => {
    const title = "山形";
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: missingPage(title) },
      {
        method: "POST",
        body: {
          previewId: "preview-id",
          expireAt: "soon",
          pagePreview: {
            title,
            persistent: false,
            lines: [{ id: "line-id", text: title }],
          },
        },
      },
    );

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).createPage({
        title,
        text: "missing from preview",
      }),
    ).rejects.toMatchObject({
      name: "CosenseResponseError",
      operation: "page edit preview",
    });
    expect(calls).toHaveLength(2);
  });
});

describe("appendToPage", () => {
  it("requires a fresh commit, verifies the preview tail, and rechecks before submit", async () => {
    const title = "山形";
    const current = existingPage(title);
    const existingLines = [
      { id: "title-line", text: title },
      { id: "body-line", text: "existing" },
    ];
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: current },
      {
        method: "POST",
        body: (call: FetchCall) => {
          const body = requestBody(call);
          expect(body.pageId).toBe("page-id");
          const changes = body.changes as {
            _insert: string;
            lines: { id: string; text: string };
          }[];
          expect(changes.map(({ lines }) => lines.text)).toEqual([
            " first ",
            "second",
            "",
          ]);
          return previewFromRequest(call, {
            title,
            persistent: true,
            existingLines,
          });
        },
      },
      { method: "GET", body: current },
      {
        method: "POST",
        body: {
          commitId: "commit-after",
          page: { title },
        },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).appendToPage({
      title,
      text: " first \r\nsecond\n",
      expectedCommitId: "  commit-before  ",
    });

    expect(calls).toHaveLength(4);
    expect(calls.map(({ init }) => init?.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
    for (const call of [calls[0], calls[2]]) {
      expectAuthenticatedJsonGet(call as FetchCall);
    }
    for (const call of [calls[1], calls[3]]) {
      expectAuthenticatedJsonPost(call as FetchCall);
    }
    expect(result).toEqual({
      action: "append",
      title,
      canonicalUrl: "https://scrapbox.io/shiyui/%E5%B1%B1%E5%BD%A2",
      commitId: "commit-after",
      previousCommitId: "commit-before",
      addedLines: 3,
    });
  });

  it("rejects blank append text without making a request", async () => {
    const fetcher: typeof fetch = vi.fn();

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).appendToPage({
        title: "Page",
        text: " \n ",
        expectedCommitId: "commit-before",
      }),
    ).rejects.toThrow("Must not be blank");

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows large append text without a local line or character cap", async () => {
    const title = "Page";
    const text = Array.from(
      { length: 101 },
      (_, index) => `${index}:${"a".repeat(100)}`,
    ).join("\n");
    const current = existingPage(title);
    const existingLines = [
      { id: "title-line", text: title },
      { id: "body-line", text: "existing" },
    ];
    const { fetcher } = createWriteFixtureFetch(
      { method: "GET", body: current },
      {
        method: "POST",
        body: (call: FetchCall) =>
          previewFromRequest(call, {
            title,
            persistent: true,
            existingLines,
          }),
      },
      { method: "GET", body: current },
      {
        method: "POST",
        body: { commitId: "commit-after", page: { title } },
      },
    );

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).appendToPage({
        title,
        text,
        expectedCommitId: "commit-before",
      }),
    ).resolves.toMatchObject({
      action: "append",
      addedLines: 101,
    });
  });

  it.each([
    [missingPage("山形"), "page-missing"],
    [existingPage("renamed"), "page-renamed"],
    [existingPage("山形", "newer-commit"), "stale-commit"],
  ])("rejects an invalid initial target as %s", async (page, reason) => {
    const { fetcher, calls } = createWriteFixtureFetch({
      method: "GET",
      body: page,
    });

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).appendToPage({
        title: "山形",
        text: "追記",
        expectedCommitId: "commit-before",
      }),
    ).rejects.toMatchObject({
      name: "CosenseWriteConflictError",
      reason,
    });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [
      existingPage("山形", "commit-before", "replacement-page-id"),
      "page-replaced",
    ],
    [existingPage("山形", "newer-commit"), "stale-commit"],
  ])(
    "does not submit when the target changes after preview as %s",
    async (recheckedPage, reason) => {
      const title = "山形";
      const { fetcher, calls } = createWriteFixtureFetch(
        { method: "GET", body: existingPage(title) },
        {
          method: "POST",
          body: (call: FetchCall) =>
            previewFromRequest(call, {
              title,
              persistent: true,
              existingLines: [
                { id: "title-line", text: title },
                { id: "body-line", text: "existing" },
              ],
            }),
        },
        { method: "GET", body: recheckedPage },
      );

      await expect(
        createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).appendToPage({
          title,
          text: "追記",
          expectedCommitId: "commit-before",
        }),
      ).rejects.toMatchObject({
        name: "CosenseWriteConflictError",
        reason,
      });
      expect(calls).toHaveLength(3);
    },
  );

  it("rejects an append preview whose tail does not match the requested text", async () => {
    const title = "山形";
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: existingPage(title) },
      {
        method: "POST",
        body: {
          previewId: "preview-id",
          expireAt: "soon",
          pagePreview: {
            title,
            persistent: true,
            lines: [
              { id: "title-line", text: title },
              { id: "body-line", text: "different tail" },
            ],
          },
        },
      },
    );

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).appendToPage({
        title,
        text: "requested tail",
        expectedCommitId: "commit-before",
      }),
    ).rejects.toMatchObject({
      name: "CosenseResponseError",
      operation: "page edit preview",
    });
    expect(calls).toHaveLength(2);
  });
});

describe("updatePage", () => {
  it("renames and minimally replaces and inserts body lines", async () => {
    const current = editablePage("Old title", [
      "keep",
      "old one",
      "old two",
      "suffix",
    ]);
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: current },
      {
        method: "POST",
        body: (call: FetchCall) => {
          const body = requestBody(call);
          expect(body.pageId).toBe("page-id");
          const changes = body.changes as Record<string, unknown>[];
          expect(changes).toHaveLength(4);
          expect(changes[0]).toEqual({
            _update: "title-line",
            lines: { text: "New title" },
          });
          expect(changes[1]).toEqual({
            _update: "body-1",
            lines: { text: "new one" },
          });
          expect(changes[2]).toEqual({
            _update: "body-2",
            lines: { text: "new two" },
          });
          expect(changes[3]).toMatchObject({
            _insert: "body-3",
            lines: { text: "inserted" },
          });
          expect((changes[3]?.lines as { id: string }).id).toMatch(
            /^[0-9a-f]{24}$/,
          );
          return appliedPreviewFromRequest(call, current);
        },
      },
      { method: "GET", body: current },
      {
        method: "POST",
        body: { commitId: "commit-after", page: { title: "New title" } },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).updatePage({
      title: "Old title",
      expectedCommitId: "commit-before",
      newTitle: "  New title  ",
      body: "keep\nnew one\nnew two\ninserted\nsuffix",
    });

    expect(calls).toHaveLength(4);
    expect(calls.map(({ init }) => init?.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
    expect(result).toEqual({
      action: "update",
      previousTitle: "Old title",
      title: "New title",
      canonicalUrl: "https://scrapbox.io/shiyui/New%20title",
      previousCommitId: "commit-before",
      commitId: "commit-after",
      changed: true,
      titleChanged: true,
      bodyChanged: true,
    });
  });

  it("treats an empty body as deletion of every body line", async () => {
    const current = editablePage("Page", ["first", "second"]);
    const { fetcher } = createWriteFixtureFetch(
      { method: "GET", body: current },
      {
        method: "POST",
        body: (call: FetchCall) => {
          expect(requestBody(call).changes).toEqual([
            { _delete: "body-0" },
            { _delete: "body-1" },
          ]);
          return appliedPreviewFromRequest(call, current);
        },
      },
      { method: "GET", body: current },
      {
        method: "POST",
        body: { commitId: "commit-after", page: { title: "Page" } },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).updatePage({
      title: "Page",
      expectedCommitId: "commit-before",
      body: "",
    });

    expect(result).toMatchObject({
      action: "update",
      changed: true,
      titleChanged: false,
      bodyChanged: true,
    });
  });

  it("returns an unchanged result after only the preflight GET", async () => {
    const current = editablePage("Page", [" exact ", "body"]);
    const { fetcher, calls } = createWriteFixtureFetch({
      method: "GET",
      body: current,
    });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).updatePage({
      title: "Page",
      expectedCommitId: "commit-before",
      newTitle: " Page ",
      body: " exact \nbody",
    });

    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      action: "update",
      previousTitle: "Page",
      title: "Page",
      canonicalUrl: "https://scrapbox.io/shiyui/Page",
      previousCommitId: "commit-before",
      commitId: "commit-before",
      changed: false,
      titleChanged: false,
      bodyChanged: false,
    });
  });

  it("rejects a stale expected commit before preview", async () => {
    const { fetcher, calls } = createWriteFixtureFetch({
      method: "GET",
      body: editablePage("Page", ["body"], "newer-commit"),
    });

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).updatePage({
        title: "Page",
        expectedCommitId: "commit-before",
        body: "new body",
      }),
    ).rejects.toMatchObject({
      name: "CosenseWriteConflictError",
      reason: "stale-commit",
    });
    expect(calls).toHaveLength(1);
  });

  it("rejects an inexact preview without rechecking or submitting", async () => {
    const current = editablePage("Page", ["old"]);
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: current },
      {
        method: "POST",
        body: {
          previewId: "preview-id",
          expireAt: "soon",
          pagePreview: {
            title: "Page",
            persistent: true,
            lines: [
              { id: "title-line", text: "Page" },
              { id: "body-0", text: "old" },
            ],
          },
        },
      },
    );

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).updatePage({
        title: "Page",
        expectedCommitId: "commit-before",
        body: "new",
      }),
    ).rejects.toMatchObject({
      name: "CosenseResponseError",
      operation: "page edit preview",
    });
    expect(calls).toHaveLength(2);
  });

  it("maps an auto-suffixed rename preview to duplicate-title", async () => {
    const current = editablePage("Page", ["body"]);
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: current },
      {
        method: "POST",
        body: (call: FetchCall) => {
          const preview = appliedPreviewFromRequest(call, current) as {
            pagePreview: { title: string };
          };
          preview.pagePreview.title = "Taken (2)";
          return preview;
        },
      },
    );

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).updatePage({
        title: "Page",
        expectedCommitId: "commit-before",
        newTitle: "Taken",
      }),
    ).rejects.toMatchObject({
      name: "CosenseWriteConflictError",
      reason: "duplicate-title",
    });
    expect(calls).toHaveLength(2);
  });

  it("does not submit when the commit changes after preview", async () => {
    const current = editablePage("Page", ["old"]);
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: current },
      {
        method: "POST",
        body: (call: FetchCall) => appliedPreviewFromRequest(call, current),
      },
      {
        method: "GET",
        body: editablePage("Page", ["old"], "newer-commit"),
      },
    );

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).updatePage({
        title: "Page",
        expectedCommitId: "commit-before",
        body: "new",
      }),
    ).rejects.toMatchObject({
      name: "CosenseWriteConflictError",
      reason: "stale-commit",
    });
    expect(calls).toHaveLength(3);
  });

  it("uses the unknown-outcome error for a submit network failure", async () => {
    const current = editablePage("Page", ["old"]);
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: current },
      {
        method: "POST",
        body: (call: FetchCall) => appliedPreviewFromRequest(call, current),
      },
      { method: "GET", body: current },
      { method: "POST", error: new TypeError("network failed") },
    );

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).updatePage({
        title: "Page",
        expectedCommitId: "commit-before",
        body: "new",
      }),
    ).rejects.toBeInstanceOf(CosenseWriteOutcomeUnknownError);
    expect(calls).toHaveLength(4);
  });

  it("rejects missing update content and NUL without fetching", async () => {
    const fetcher: typeof fetch = vi.fn();
    const client = createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher);

    await expect(
      client.updatePage({ title: "Page", expectedCommitId: "commit-before" }),
    ).rejects.toThrow("At least one of body or newTitle is required");
    await expect(
      client.updatePage({
        title: "Page",
        expectedCommitId: "commit-before",
        body: "a\0b",
      }),
    ).rejects.toThrow("Must not contain NUL");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("submits an exact preview for an update requiring over 100 changes", async () => {
    const current = editablePage(
      "Page",
      Array.from({ length: 101 }, (_, index) => `old-${index}`),
    );
    const desiredBody = Array.from(
      { length: 101 },
      (_, index) => `new-${index}:${"x".repeat(100)}`,
    );
    const body = desiredBody.join("\n");
    expect(body.length).toBeGreaterThan(10_000);

    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: current },
      {
        method: "POST",
        body: (call: FetchCall) => {
          expect(requestBody(call).changes).toHaveLength(101);
          const preview = appliedPreviewFromRequest(call, current) as {
            pagePreview: {
              title: string;
              persistent: boolean;
              lines: { id: string; text: string }[];
            };
          };
          expect(preview.pagePreview).toEqual({
            title: "Page",
            persistent: true,
            lines: [
              { id: "title-line", text: "Page" },
              ...desiredBody.map((text, index) => ({
                id: `body-${index}`,
                text,
              })),
            ],
          });
          return preview;
        },
      },
      { method: "GET", body: current },
      {
        method: "POST",
        body: { commitId: "commit-after", page: { title: "Page" } },
      },
    );

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).updatePage({
      title: "Page",
      expectedCommitId: "commit-before",
      body,
    });

    expect(calls).toHaveLength(4);
    expect(calls.map(({ init }) => init?.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
    expect(result).toMatchObject({
      action: "update",
      changed: true,
      bodyChanged: true,
    });
  });
});

describe("replaceLinks", () => {
  it("uses one fixed-origin PAT POST and trims both titles", async () => {
    const { fetcher, calls } = createWriteFixtureFetch({
      method: "POST",
      body: (call: FetchCall) => {
        expect(requestBody(call)).toEqual({
          from: "old title",
          to: "new title",
        });
        return { message: "replacement started" };
      },
    });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).replaceLinks({ fromTitle: " old title ", toTitle: " new title " });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://scrapbox.io/api/pages/shiyui/replace/links",
    );
    expectAuthenticatedJsonPost(calls[0] as FetchCall);
    expect(result).toEqual({
      action: "replace-links",
      fromTitle: "old title",
      toTitle: "new title",
      message: "replacement started",
    });
  });

  it("truncates an upstream message after a successful replacement", async () => {
    const { fetcher } = createWriteFixtureFetch({
      method: "POST",
      body: { message: "x".repeat(2_100) },
    });

    const result = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).replaceLinks({ fromTitle: "old", toTitle: "new" });

    expect(result.message).toBe("x".repeat(2_000));
  });

  it("rejects invalid or normalized-equal titles before fetching", async () => {
    const fetcher: typeof fetch = vi.fn();
    const client = createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher);

    await expect(
      client.replaceLinks({ fromTitle: "Same Page", toTitle: "same_page" }),
    ).rejects.toThrow("must refer to different titles");
    await expect(
      client.replaceLinks({ fromTitle: "old\ntitle", toTitle: "new" }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves authentication failures as safe non-retryable errors", async () => {
    const { fetcher } = createWriteFixtureFetch({
      method: "POST",
      status: 401,
      body: { secret: TEST_PERSONAL_ACCESS_TOKEN },
    });

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).replaceLinks({
        fromTitle: "old",
        toTitle: "new",
      }),
    ).rejects.toMatchObject({
      name: "CosenseAuthenticationError",
      status: 401,
      operation: "replace links",
    });
  });

  it.each([301, 302])("does not follow HTTP %i redirects", async (status) => {
    const location = "https://example.invalid/replaced";
    const response = new Response("redirect details", {
      status,
      headers: { Location: location },
    });
    const jsonSpy = vi.spyOn(response, "json");
    const textSpy = vi.spyOn(response, "text");
    const calls: FetchCall[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const call = { url: String(input), init };
      calls.push(call);
      expectAuthenticatedJsonPost(call);
      return response;
    };

    const error = await createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher)
      .replaceLinks({ fromTitle: "old", toTitle: "new" })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toMatchObject({
      name: "CosenseUpstreamError",
      status,
      operation: "replace links",
    });
    expect(String(error)).not.toContain(location);
    expect(calls).toHaveLength(1);
    expect(jsonSpy).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
    expect(response.bodyUsed).toBe(false);
  });

  it.each([
    ["network failure", { error: new TypeError("network failed") }],
    ["server failure", { status: 503, body: { secret: "not exposed" } }],
  ])("marks %s as retryable without retrying", async (_name, fixture) => {
    const { fetcher, calls } = createWriteFixtureFetch({
      method: "POST",
      ...fixture,
    });

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).replaceLinks({
        fromTitle: "old",
        toTitle: "new",
      }),
    ).rejects.toBeInstanceOf(CosenseReplaceLinksRetryableError);
    expect(calls).toHaveLength(1);
  });

  it.each([400, 429])(
    "preserves HTTP %i as a non-retryable upstream error",
    async (status) => {
      const { fetcher, calls } = createWriteFixtureFetch({
        method: "POST",
        status,
        body: { error: "request rejected" },
      });

      await expect(
        createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).replaceLinks({
          fromTitle: "old",
          toTitle: "new",
        }),
      ).rejects.toMatchObject({
        name: "CosenseUpstreamError",
        status,
        operation: "replace links",
      });
      expect(calls).toHaveLength(1);
    },
  );
});

describe("write errors and limits", () => {
  it.each([401, 403])(
    "returns a safe write authentication error for HTTP %i without reading the body",
    async (status) => {
      const response = new Response(
        `upstream details: ${TEST_PERSONAL_ACCESS_TOKEN}`,
        { status },
      );
      const jsonSpy = vi.spyOn(response, "json");
      const textSpy = vi.spyOn(response, "text");
      const calls: FetchCall[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const call = { url: String(input), init };
        calls.push(call);
        if (calls.length === 1) {
          expectAuthenticatedJsonGet(call);
          return Response.json(missingPage("山形"));
        }
        expectAuthenticatedJsonPost(call);
        return response;
      };

      const error = await createCosenseClient(
        TEST_PERSONAL_ACCESS_TOKEN,
        fetcher,
      )
        .createPage({ title: "山形", text: "本文" })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );

      expect(error).toMatchObject({
        name: "CosenseAuthenticationError",
        status,
        operation: "page edit preview",
        message: "Cosense authentication failed.",
      });
      expect(String(error)).not.toContain(TEST_PERSONAL_ACCESS_TOKEN);
      expect(calls).toHaveLength(2);
      expect(jsonSpy).not.toHaveBeenCalled();
      expect(textSpy).not.toHaveBeenCalled();
      expect(response.bodyUsed).toBe(false);
    },
  );

  it("maps known preview and submit 409 responses to safe typed conflicts", async () => {
    const upstreamSecret = `latest contains ${TEST_PERSONAL_ACCESS_TOKEN}`;
    const previewFailure = createWriteFixtureFetch(
      { method: "GET", body: missingPage("山形") },
      {
        method: "POST",
        status: 409,
        body: { error: "NotFastForward", latest: upstreamSecret },
      },
    );
    const previewError = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      previewFailure.fetcher,
    )
      .createPage({ title: "山形", text: "本文" })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(previewError).toMatchObject({
      name: "CosenseWriteConflictError",
      reason: "not-fast-forward",
      status: 409,
    });

    const submitFailure = createWriteFixtureFetch(
      { method: "GET", body: missingPage("山形") },
      {
        method: "POST",
        body: (call: FetchCall) =>
          previewFromRequest(call, { title: "山形", persistent: false }),
      },
      { method: "GET", body: missingPage("山形") },
      { method: "POST", status: 409, body: { error: "DuplicateTitle" } },
    );
    const submitError = await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      submitFailure.fetcher,
    )
      .createPage({ title: "山形", text: "本文" })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(submitError).toMatchObject({
      name: "CosenseWriteConflictError",
      reason: "duplicate-title",
      status: 409,
    });
    expect(JSON.stringify([previewError, submitError])).not.toContain(
      upstreamSecret,
    );
  });

  it("keeps a consumed or expired submit preview as an ordinary 404", async () => {
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: missingPage("山形") },
      {
        method: "POST",
        body: (call: FetchCall) =>
          previewFromRequest(call, { title: "山形", persistent: false }),
      },
      { method: "GET", body: missingPage("山形") },
      { method: "POST", status: 404, body: { error: "Expired" } },
    );

    await expect(
      createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher).createPage({
        title: "山形",
        text: "本文",
      }),
    ).rejects.toMatchObject({
      name: "CosenseUpstreamError",
      status: 404,
      operation: "page edit submit",
    });
    expect(calls).toHaveLength(4);
  });

  it.each([
    ["network failure", { error: new TypeError("network failed") }],
    ["abort", { error: new DOMException("Aborted", "AbortError") }],
    ["malformed 2xx", { body: { commitId: "missing-page" } }],
    ["server failure", { status: 503, body: { secret: "do not expose" } }],
  ])("treats submit %s as an unknown outcome", async (_name, submitFixture) => {
    const { fetcher, calls } = createWriteFixtureFetch(
      { method: "GET", body: missingPage("山形") },
      {
        method: "POST",
        body: (call: FetchCall) =>
          previewFromRequest(call, { title: "山形", persistent: false }),
      },
      { method: "GET", body: missingPage("山形") },
      { method: "POST", ...submitFixture },
    );

    const error = await createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher)
      .createPage({ title: "山形", text: "本文" })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(CosenseWriteOutcomeUnknownError);
    expect(error).toMatchObject({ operation: "page edit submit" });
    expect(String(error)).not.toContain("network failed");
    expect(String(error)).not.toContain("do not expose");
    expect(calls).toHaveLength(4);
  });

  it.each([301, 302])(
    "does not follow a page-edit preview HTTP %i redirect",
    async (status) => {
      const location = "https://example.invalid/write";
      const redirected = new Response("redirect details", {
        status,
        headers: { Location: location },
      });
      const jsonSpy = vi.spyOn(redirected, "json");
      const textSpy = vi.spyOn(redirected, "text");
      const calls: FetchCall[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const call = { url: String(input), init };
        calls.push(call);
        if (calls.length === 1) {
          expectAuthenticatedJsonGet(call);
          return Response.json(missingPage("山形"));
        }
        expectAuthenticatedJsonPost(call);
        return redirected;
      };

      const error = await createCosenseClient(
        TEST_PERSONAL_ACCESS_TOKEN,
        fetcher,
      )
        .createPage({ title: "山形", text: "本文" })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );

      expect(error).toMatchObject({
        name: "CosenseUpstreamError",
        status,
        operation: "page edit preview",
      });
      expect(String(error)).not.toContain(location);
      expect(calls).toHaveLength(2);
      expect(jsonSpy).not.toHaveBeenCalled();
      expect(textSpy).not.toHaveBeenCalled();
      expect(redirected.bodyUsed).toBe(false);
    },
  );

  it("rejects invalid write input without making a request", async () => {
    const fetcher: typeof fetch = vi.fn();
    const client = createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher);
    const invalidCreateInputs = [
      { title: "山形", text: "a\0b" },
      { title: "日".repeat(501), text: "本文" },
      { title: " ", text: "本文" },
      { title: ".", text: "本文" },
      { title: "..", text: "本文" },
      { title: "山\n形", text: "本文" },
      { title: "山\r形", text: "本文" },
      { title: "山\0形", text: "本文" },
    ];

    for (const input of invalidCreateInputs) {
      await expect(client.createPage(input)).rejects.toThrow();
    }
    await expect(
      client.appendToPage({
        title: "山形",
        text: "本文",
        expectedCommitId: "c".repeat(501),
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
