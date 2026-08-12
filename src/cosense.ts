import { z } from "zod";

const ORIGIN = "https://scrapbox.io";
const PROJECT = "shiyui";
const DEFAULT_LIMIT = 10;
const MAX_INPUT_LENGTH = 500;
const REQUEST_TIMEOUT_MS = 15_000;

const nonBlankString = z
  .string()
  .max(MAX_INPUT_LENGTH)
  .refine((value) => value.trim().length > 0, {
    message: "Must not be blank",
  });
const pageTitleSchema = nonBlankString.refine(
  (value) => value.trim() !== "." && value.trim() !== "..",
  { message: "Dot-segment titles are not supported" },
);
const limitSchema = z.number().int().min(1).max(20);

const getPageInputSchema = z
  .object({
    title: pageTitleSchema,
  })
  .strict();

const searchFullTextInputSchema = z
  .object({
    query: nonBlankString,
    match: z.enum(["and", "or"]).optional().default("and"),
    sort: z.enum(["pageRank", "updated"]).optional().default("pageRank"),
    limit: limitSchema.optional().default(DEFAULT_LIMIT),
  })
  .strict();

const searchVectorInputSchema = z
  .object({
    query: nonBlankString,
    limit: limitSchema.optional().default(DEFAULT_LIMIT),
  })
  .strict();

const getRelatedPagesInputSchema = z
  .object({
    title: pageTitleSchema,
    hop: z.union([z.literal(1), z.literal(2)]),
    query: nonBlankString.optional(),
    match: z.enum(["and", "or"]).optional().default("and"),
    limit: limitSchema.optional().default(DEFAULT_LIMIT),
    cursor: z.string().min(1).max(MAX_INPUT_LENGTH).optional(),
  })
  .strict();

const missingPageSchema = z.object({
  persistent: z.literal(false),
  title: z.string(),
});

const existingPageSchema = z.object({
  persistent: z.literal(true),
  title: z.string(),
  id: z.string(),
  commitId: z.string(),
  lines: z.array(z.object({ text: z.string() })),
  created: z.number().finite().optional(),
  updated: z.number().finite().optional(),
  pageRank: z.number().finite().optional(),
  linked: z.number().finite().optional(),
  links: z.array(z.string()).optional(),
});

const pageResponseSchema = z.discriminatedUnion("persistent", [
  missingPageSchema,
  existingPageSchema,
]);

const fullTextResponseSchema = z.object({
  count: z.number().int().nonnegative().optional(),
  existsExactTitleMatch: z.boolean().optional(),
  pages: z.array(
    z.object({
      title: z.string(),
      lines: z.array(z.string()),
      words: z.array(z.string()),
      updated: z.number().finite().optional(),
      pageRank: z.number().finite().optional(),
    }),
  ),
});

const vectorResponseSchema = z.object({
  pages: z.array(
    z.object({
      title: z.string(),
      score: z.number().finite(),
      exists: z.boolean(),
      updated: z.number().finite().optional(),
      pageRank: z.number().finite().optional(),
    }),
  ),
});

const relatedPageSchema = z.object({
  title: z.string(),
  descriptions: z.array(z.string()).optional(),
  pageRank: z.number().finite().optional(),
  linked: z.number().finite().optional(),
  updated: z.number().finite().optional(),
});

const oneHopPageSchema = relatedPageSchema.extend({
  titleLc: z.string(),
  linksLc: z.array(z.string()),
});

const paginationSchema = z
  .object({
    total: z.number().int().nonnegative().optional(),
    hasNext: z.boolean(),
    nextId: z.string().nullable().optional(),
  })
  .superRefine((pagination, context) => {
    if (pagination.hasNext && !pagination.nextId) {
      context.addIssue({
        code: "custom",
        path: ["nextId"],
        message: "nextId is required when hasNext is true",
      });
    }
  });

const oneHopResponseSchema = z.object({
  links1hop: z.array(oneHopPageSchema),
  pagination: paginationSchema,
});

const twoHopResponseSchema = z.object({
  links2hop: z.array(relatedPageSchema),
  pagination: paginationSchema,
});

const relationBasePageSchema = z.object({
  title: z.string().optional(),
  titleLc: z.string().optional(),
  links: z.array(z.string()).optional(),
  linksLc: z.array(z.string()).optional(),
});

export type MatchMode = "and" | "or";
export type SearchSort = "pageRank" | "updated";
export type RelatedPageRelation = "outgoing" | "incoming" | "bidirectional";

export interface GetPageInput {
  title: string;
}

export interface MissingPageResult {
  exists: false;
  title: string;
  canonicalUrl: string;
}

export interface ExistingPageResult {
  exists: true;
  title: string;
  canonicalUrl: string;
  pageId: string;
  commitId: string;
  text: string;
  createdAt?: string;
  updatedAt?: string;
  pageRank?: number;
  linked?: number;
  links?: string[];
}

export type GetPageResult = MissingPageResult | ExistingPageResult;

export interface SearchFullTextInput {
  query: string;
  match?: MatchMode;
  sort?: SearchSort;
  limit?: number;
}

export interface FullTextSearchResultItem {
  title: string;
  snippet: string;
  matchedWords: string[];
  updatedAt?: string;
  pageRank?: number;
  canonicalUrl: string;
}

export interface SearchFullTextResult {
  reportedCount?: number;
  exactTitleMatch?: boolean;
  returned: number;
  truncated: boolean;
  results: FullTextSearchResultItem[];
}

export interface SearchVectorInput {
  query: string;
  limit?: number;
}

export interface VectorSearchResultItem {
  title: string;
  score: number;
  exists: boolean;
  canonicalUrl: string;
  updatedAt?: string;
  pageRank?: number;
}

export interface SearchVectorResult {
  returned: number;
  localTruncated: boolean;
  results: VectorSearchResultItem[];
}

export interface GetRelatedPagesInput {
  title: string;
  hop: 1 | 2;
  query?: string;
  match?: MatchMode;
  limit?: number;
  cursor?: string;
}

export interface RelatedPageResultItem {
  title: string;
  descriptions: string[];
  relation?: RelatedPageRelation;
  pageRank?: number;
  linked?: number;
  updatedAt?: string;
  canonicalUrl: string;
}

export interface GetRelatedPagesResult {
  total?: number;
  hasNext: boolean;
  nextCursor?: string;
  returned: number;
  results: RelatedPageResultItem[];
}

export class CosenseUpstreamError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(status: number, operation: string) {
    super(`Cosense ${operation} request failed with status ${status}.`);
    this.name = "CosenseUpstreamError";
    this.status = status;
    this.operation = operation;
  }
}

export class CosenseResponseError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super(`Cosense returned an invalid ${operation} response.`, { cause });
    this.name = "CosenseResponseError";
    this.operation = operation;
  }
}

export interface CosenseClient {
  getPage(input: GetPageInput, signal?: AbortSignal): Promise<GetPageResult>;
  searchFullText(
    input: SearchFullTextInput,
    signal?: AbortSignal,
  ): Promise<SearchFullTextResult>;
  searchVector(
    input: SearchVectorInput,
    signal?: AbortSignal,
  ): Promise<SearchVectorResult>;
  getRelatedPages(
    input: GetRelatedPagesInput,
    signal?: AbortSignal,
  ): Promise<GetRelatedPagesResult>;
}

type Fetcher = typeof fetch;

function apiUrl(path: string, searchParams?: URLSearchParams): string {
  const url = new URL(path, ORIGIN);
  if (searchParams) url.search = searchParams.toString();
  return url.toString();
}

function pagePath(title: string): string {
  return `/api/pages/v2/${PROJECT}/${encodeURIComponent(title)}`;
}

function canonicalUrl(title: string): string {
  return `${ORIGIN}/${PROJECT}/${encodeURIComponent(title)}`;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replaceAll(" ", "_");
}

function toIsoTime(timestamp: number): string {
  return new Date(timestamp * 1_000).toISOString();
}

function optionalTime(timestamp: number | undefined): object {
  return timestamp === undefined ? {} : { updatedAt: toIsoTime(timestamp) };
}

async function requestJson<T>(
  fetcher: Fetcher,
  url: string,
  operation: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal =
    signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal]);
  const response = await fetcher(url, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: requestSignal,
  });

  if (!response.ok) {
    throw new CosenseUpstreamError(response.status, operation);
  }

  try {
    return schema.parse(await response.json());
  } catch (error) {
    if (requestSignal.aborted) throw requestSignal.reason;
    throw new CosenseResponseError(operation, error);
  }
}

function makeRelatedUrl(input: {
  title: string;
  hop: 1 | 2;
  query?: string | undefined;
  match: MatchMode;
  limit: number;
  cursor?: string | undefined;
}): string {
  const params = new URLSearchParams();
  params.set("perPage", String(input.limit));
  if (input.query !== undefined) params.set("search", input.query);
  if (input.match === "or") params.set("op", "or");
  if (input.cursor !== undefined) params.set("nextId", input.cursor);
  return apiUrl(`${pagePath(input.title)}/links${input.hop}hop`, params);
}

function computeRelation(
  baseTitleLc: string,
  baseLinksLc: Set<string>,
  page: z.infer<typeof oneHopPageSchema>,
): RelatedPageRelation | undefined {
  const outgoing = baseLinksLc.has(page.titleLc);
  const incoming = page.linksLc.includes(baseTitleLc);
  if (outgoing && incoming) return "bidirectional";
  if (outgoing) return "outgoing";
  if (incoming) return "incoming";
  return undefined;
}

function mapRelatedPage(
  page: z.infer<typeof relatedPageSchema>,
  relation?: RelatedPageRelation,
): RelatedPageResultItem {
  return {
    title: page.title,
    descriptions: (page.descriptions ?? [])
      .slice(0, 5)
      .map((description) => description.slice(0, 240)),
    ...(relation === undefined ? {} : { relation }),
    ...(page.pageRank === undefined ? {} : { pageRank: page.pageRank }),
    ...(page.linked === undefined ? {} : { linked: page.linked }),
    ...optionalTime(page.updated),
    canonicalUrl: canonicalUrl(page.title),
  };
}

function buildRelatedResult(
  pages: RelatedPageResultItem[],
  pagination: z.infer<typeof paginationSchema>,
): GetRelatedPagesResult {
  return {
    ...(pagination.total === undefined ? {} : { total: pagination.total }),
    hasNext: pagination.hasNext,
    ...(pagination.hasNext ? { nextCursor: pagination.nextId as string } : {}),
    returned: pages.length,
    results: pages,
  };
}

export function createCosenseClient(
  fetcher: Fetcher = globalThis.fetch,
): CosenseClient {
  return {
    async getPage(input, signal) {
      const { title } = getPageInputSchema.parse(input);
      let page: z.infer<typeof pageResponseSchema>;
      try {
        page = await requestJson(
          fetcher,
          apiUrl(pagePath(title)),
          "page",
          pageResponseSchema,
          signal,
        );
      } catch (error) {
        if (error instanceof CosenseUpstreamError && error.status === 404) {
          return {
            exists: false,
            title,
            canonicalUrl: canonicalUrl(title),
          };
        }
        throw error;
      }

      if (!page.persistent) {
        return {
          exists: false,
          title: page.title,
          canonicalUrl: canonicalUrl(page.title),
        };
      }

      return {
        exists: true,
        title: page.title,
        canonicalUrl: canonicalUrl(page.title),
        pageId: page.id,
        commitId: page.commitId,
        text: page.lines
          .slice(1)
          .map(({ text }) => text)
          .join("\n"),
        ...(page.created === undefined
          ? {}
          : { createdAt: toIsoTime(page.created) }),
        ...(page.updated === undefined
          ? {}
          : { updatedAt: toIsoTime(page.updated) }),
        ...(page.pageRank === undefined ? {} : { pageRank: page.pageRank }),
        ...(page.linked === undefined ? {} : { linked: page.linked }),
        ...(page.links === undefined ? {} : { links: page.links }),
      };
    },

    async searchFullText(input, signal) {
      const parsed = searchFullTextInputSchema.parse(input);
      const params = new URLSearchParams();
      params.set("q", parsed.query);
      if (parsed.match === "or") params.set("op", "or");
      params.set("sort", parsed.sort);

      const response = await requestJson(
        fetcher,
        apiUrl(`/api/pages/${PROJECT}/search/query`, params),
        "full-text search",
        fullTextResponseSchema,
        signal,
      );
      const selected = response.pages.slice(0, parsed.limit);
      const results = selected.map((page): FullTextSearchResultItem => ({
        title: page.title,
        snippet: page.lines.slice(0, 5).join("\n").slice(0, 1_200),
        matchedWords: page.words.slice(0, 20),
        ...optionalTime(page.updated),
        ...(page.pageRank === undefined ? {} : { pageRank: page.pageRank }),
        canonicalUrl: canonicalUrl(page.title),
      }));

      return {
        ...(response.count === undefined
          ? {}
          : { reportedCount: response.count }),
        ...(response.existsExactTitleMatch === undefined
          ? {}
          : { exactTitleMatch: response.existsExactTitleMatch }),
        returned: results.length,
        truncated: response.pages.length > parsed.limit,
        results,
      };
    },

    async searchVector(input, signal) {
      const parsed = searchVectorInputSchema.parse(input);
      const params = new URLSearchParams();
      params.set("q", parsed.query);
      const response = await requestJson(
        fetcher,
        apiUrl(`/api/pages/${PROJECT}/search/vector/titles`, params),
        "vector search",
        vectorResponseSchema,
        signal,
      );
      const selected = response.pages.slice(0, parsed.limit);
      const results = selected.map((page): VectorSearchResultItem => ({
        title: page.title,
        score: page.score,
        exists: page.exists,
        canonicalUrl: canonicalUrl(page.title),
        ...(page.exists ? optionalTime(page.updated) : {}),
        ...(page.exists && page.pageRank !== undefined
          ? { pageRank: page.pageRank }
          : {}),
      }));

      return {
        returned: results.length,
        localTruncated: response.pages.length > parsed.limit,
        results,
      };
    },

    async getRelatedPages(input, signal) {
      const parsed = getRelatedPagesInputSchema.parse(input);
      const relatedUrl = makeRelatedUrl(parsed);

      if (parsed.hop === 2) {
        const response = await requestJson(
          fetcher,
          relatedUrl,
          "2-hop related pages",
          twoHopResponseSchema,
          signal,
        );
        return buildRelatedResult(
          response.links2hop
            .slice(0, parsed.limit)
            .map((page) => mapRelatedPage(page)),
          response.pagination,
        );
      }

      const [baseResult, relatedResult] = await Promise.allSettled([
        requestJson(
          fetcher,
          apiUrl(pagePath(parsed.title)),
          "relation base page",
          relationBasePageSchema,
          signal,
        ),
        requestJson(
          fetcher,
          relatedUrl,
          "1-hop related pages",
          oneHopResponseSchema,
          signal,
        ),
      ]);

      if (relatedResult.status === "rejected") throw relatedResult.reason;

      let baseTitleLc: string;
      let baseLinksLc: Set<string> | undefined;
      if (baseResult.status === "fulfilled") {
        baseTitleLc = normalizeTitle(
          baseResult.value.titleLc ?? baseResult.value.title ?? parsed.title,
        );
        const linksLc =
          baseResult.value.linksLc ??
          baseResult.value.links?.map(normalizeTitle);
        baseLinksLc = linksLc === undefined ? undefined : new Set(linksLc);
      } else if (
        baseResult.reason instanceof CosenseUpstreamError &&
        baseResult.reason.status === 404
      ) {
        baseTitleLc = normalizeTitle(parsed.title);
        baseLinksLc = new Set();
      } else {
        throw baseResult.reason;
      }

      const results = relatedResult.value.links1hop
        .slice(0, parsed.limit)
        .map((page) =>
          mapRelatedPage(
            page,
            baseLinksLc === undefined
              ? undefined
              : computeRelation(baseTitleLc, baseLinksLc, page),
          ),
        );
      return buildRelatedResult(results, relatedResult.value.pagination);
    },
  };
}
