import { describe, expect, it, vi } from "vitest";

import {
  CosenseAuthenticationError,
  CosenseResponseError,
  CosenseUpstreamError,
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
  expect(call.init?.redirect).toBe("error");
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
    ).getPage({ title: "日本語 /%?#" });

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

  it("rejects oversized direct-client input before fetching", async () => {
    const fetcher: typeof fetch = vi.fn();
    const client = createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher);
    const oversized = "日".repeat(501);

    await expect(client.getPage({ title: oversized })).rejects.toThrow();
    await expect(client.searchFullText({ query: oversized })).rejects.toThrow();
    await expect(client.searchVector({ query: oversized })).rejects.toThrow();
    await expect(
      client.getRelatedPages({ title: "page", hop: 2, cursor: oversized }),
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

  it("omits op for AND matching and uses the default sort", async () => {
    const { fetcher, calls } = createFixtureFetch({ body: { pages: [] } });

    await createCosenseClient(
      TEST_PERSONAL_ACCESS_TOKEN,
      fetcher,
    ).searchFullText({ query: "alpha beta" });

    expect(calls[0]?.url).toBe(
      "https://scrapbox.io/api/pages/shiyui/search/query?q=alpha+beta&sort=pageRank",
    );
    expect(calls[0]?.url).not.toContain("op=");
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

  it("uses input-title normalization and empty links when the base page is 404", async () => {
    const { fetcher } = createFixtureFetch(
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
    ).getRelatedPages({ title: value, hop: 2, query: value, cursor: value });

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

  it("rejects unbounded list inputs before fetching", async () => {
    const { fetcher, calls } = createFixtureFetch();
    const client = createCosenseClient(TEST_PERSONAL_ACCESS_TOKEN, fetcher);

    await expect(client.listPages({ limit: 21 })).rejects.toThrow();
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
      pageId: "page /%?#",
      commitId: "head /%?#",
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
    const changes = Array.from({ length: 51 }, (_, index) => ({
      _insert: `line-${index}`,
      lines: { id: `line-${index}`, text: `${index}:${"x".repeat(600)}` },
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
      totalChanges: 51,
      returned: 50,
      truncated: true,
      latestCommitId: "latest",
    });
    expect(result).not.toHaveProperty("afterCommitId");
    expect(result.changes[0]?.after?.startsWith("1:")).toBe(true);
    expect(result.changes[0]?.after).toHaveLength(500);
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
