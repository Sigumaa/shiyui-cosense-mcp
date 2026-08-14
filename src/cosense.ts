import { z } from "zod";

const ORIGIN = "https://scrapbox.io";
const PROJECT = "shiyui";
const DEFAULT_LIMIT = 10;
const MAX_INPUT_LENGTH = 500;
const MAX_CHANGE_EVENTS = 50;
const MAX_CHANGE_TEXT_LENGTH = 500;
const MAX_AUTHOR_LENGTH = 200;
const MAX_WRITE_TEXT_LENGTH = 10_000;
const MAX_WRITE_LINES = 100;
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

const listPagesInputSchema = z
  .object({
    sort: z
      .enum(["updated", "created", "accessed", "linked", "views", "title"])
      .optional()
      .default("updated"),
    limit: limitSchema.optional().default(DEFAULT_LIMIT),
    skip: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .default(0),
  })
  .strict();

const getPageChangesInputSchema = z
  .object({
    pageId: pageTitleSchema,
    commitId: nonBlankString.optional(),
  })
  .strict();

const writeTextSchema = z
  .string()
  .max(MAX_WRITE_TEXT_LENGTH)
  .refine((value) => value.trim().length > 0, {
    message: "Must not be blank",
  })
  .refine((value) => !value.includes("\0"), {
    message: "Must not contain NUL",
  })
  .refine((value) => value.split(/\r?\n/).length <= MAX_WRITE_LINES, {
    message: `Must not contain more than ${MAX_WRITE_LINES} lines`,
  });
const writeTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_INPUT_LENGTH)
  .refine((value) => value !== "." && value !== "..", {
    message: "Dot-segment titles are not supported",
  })
  .refine((value) => !/[\r\n\0]/.test(value), {
    message: "Must not contain CR, LF, or NUL",
  });
const writeCommitIdSchema = z.string().trim().min(1).max(MAX_INPUT_LENGTH);

const createPageInputSchema = z
  .object({
    title: writeTitleSchema,
    text: writeTextSchema,
  })
  .strict();

const appendToPageInputSchema = z
  .object({
    title: writeTitleSchema,
    text: writeTextSchema,
    expectedCommitId: writeCommitIdSchema,
  })
  .strict();

const updateBodySchema = z
  .string()
  .max(MAX_WRITE_TEXT_LENGTH)
  .refine((value) => !value.includes("\0"), {
    message: "Must not contain NUL",
  })
  .refine(
    (value) => value === "" || value.split(/\r?\n/).length <= MAX_WRITE_LINES,
    { message: `Must not contain more than ${MAX_WRITE_LINES} lines` },
  );

const updatePageInputSchema = z
  .object({
    title: writeTitleSchema,
    expectedCommitId: writeCommitIdSchema,
    body: updateBodySchema.optional(),
    newTitle: writeTitleSchema.optional(),
  })
  .strict()
  .refine((input) => input.body !== undefined || input.newTitle !== undefined, {
    message: "At least one of body or newTitle is required",
  });

const replaceLinksInputSchema = z
  .object({
    fromTitle: writeTitleSchema,
    toTitle: writeTitleSchema,
  })
  .strict()
  .refine(
    (input) =>
      normalizeTitle(input.fromTitle) !== normalizeTitle(input.toTitle),
    { message: "fromTitle and toTitle must refer to different titles" },
  );

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

const editableExistingPageSchema = z.object({
  persistent: z.literal(true),
  title: z.string(),
  id: z.string().min(1),
  commitId: z.string().min(1),
  lines: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string(),
      }),
    )
    .min(1),
});

const editablePageResponseSchema = z.discriminatedUnion("persistent", [
  missingPageSchema,
  editableExistingPageSchema,
]);

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

const listedPageSchema = z.object({
  id: z.string(),
  title: z.string(),
  descriptions: z.array(z.string()).optional(),
  pin: z.number().finite().optional(),
  views: z.number().finite().optional(),
  linked: z.number().finite().optional(),
  linesCount: z.number().finite().optional(),
  charsCount: z.number().finite().optional(),
  created: z.number().finite().optional(),
  updated: z.number().finite().optional(),
  accessed: z.number().finite().optional(),
});

const listPagesResponseSchema = z.object({
  projectName: z.string(),
  count: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  skip: z.number().int().nonnegative(),
  pages: z.array(listedPageSchema),
});

const commitLineSchema = z.object({
  id: z.string().optional(),
  text: z.string().optional(),
  origText: z.string().optional(),
});

const commitChangeSchema = z.object({
  title: z.string().optional(),
  _insert: z.string().optional(),
  _update: z.string().optional(),
  _delete: z.string().optional(),
  lines: commitLineSchema.optional(),
});

const commitSchema = z.object({
  id: z.string().optional(),
  changes: z.array(commitChangeSchema).optional(),
  userId: z.string().optional(),
  created: z.number().finite().optional(),
});

const commitsResponseSchema = z.object({
  commits: z.array(commitSchema).optional(),
});

const userEntrySchema = z.object({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  displayName: z.unknown().optional(),
});

const serviceAccountEntrySchema = z.object({
  id: z.unknown().optional(),
  usage: z.unknown().optional(),
});

const usersResponseSchema = z.object({
  users: z.array(userEntrySchema).optional(),
  memberSnapshots: z
    .array(z.object({ data: userEntrySchema.optional() }))
    .optional(),
  serviceAccounts: z.array(serviceAccountEntrySchema).optional(),
  serviceAccountSnapshots: z.array(serviceAccountEntrySchema).optional(),
});

const editPreviewResponseSchema = z.object({
  previewId: z.string().min(1).max(MAX_INPUT_LENGTH),
  expireAt: z.string().min(1),
  pagePreview: z.object({
    title: z.string(),
    persistent: z.boolean(),
    lines: z.array(
      z.object({
        id: z.string().min(1),
        text: z.string(),
      }),
    ),
  }),
});

const editSubmitResponseSchema = z.object({
  commitId: z.string().min(1).max(MAX_INPUT_LENGTH),
  page: z.object({ title: z.string() }),
});

const editConflictResponseSchema = z.object({
  error: z.enum(["NotFastForward", "DuplicateTitle"]),
});

const replaceLinksResponseSchema = z.object({
  message: z.string().max(MAX_INPUT_LENGTH),
});

export type MatchMode = "and" | "or";
export type SearchSort = "pageRank" | "updated";
export type RelatedPageRelation = "outgoing" | "incoming" | "bidirectional";
export type PageListSort =
  "updated" | "created" | "accessed" | "linked" | "views" | "title";
export type PageChangeKind = "title" | "insert" | "update" | "delete";

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

export interface ListPagesInput {
  sort?: PageListSort;
  limit?: number;
  skip?: number;
}

export interface ListedPageResultItem {
  pageId: string;
  title: string;
  canonicalUrl: string;
  descriptions: string[];
  pin?: number;
  views?: number;
  linked?: number;
  linesCount?: number;
  charsCount?: number;
  createdAt?: string;
  updatedAt?: string;
  accessedAt?: string;
}

export interface ListPagesResult {
  reportedCount: number;
  skip: number;
  returned: number;
  hasNext: boolean;
  nextSkip?: number;
  results: ListedPageResultItem[];
}

export interface GetPageChangesInput {
  pageId: string;
  commitId?: string;
}

export interface PageChangeResultItem {
  kind: PageChangeKind;
  authors: string[];
  createdAt?: string;
  before?: string;
  after?: string;
}

export interface GetPageChangesResult {
  pageId: string;
  afterCommitId?: string;
  commitCount: number;
  totalChanges: number;
  returned: number;
  truncated: boolean;
  latestCommitId?: string;
  latestTitleChange?: {
    title: string;
    canonicalUrl: string;
  };
  changes: PageChangeResultItem[];
}

export interface CreatePageInput {
  title: string;
  text: string;
}

export interface AppendToPageInput {
  title: string;
  text: string;
  expectedCommitId: string;
}

export interface UpdatePageInput {
  title: string;
  expectedCommitId: string;
  body?: string | undefined;
  newTitle?: string | undefined;
}

export interface ReplaceLinksInput {
  fromTitle: string;
  toTitle: string;
}

export interface CreatePageResult {
  action: "create";
  title: string;
  canonicalUrl: string;
  commitId: string;
  addedLines: number;
}

export interface AppendToPageResult {
  action: "append";
  title: string;
  canonicalUrl: string;
  commitId: string;
  previousCommitId: string;
  addedLines: number;
}

export interface UpdatePageResult {
  action: "update";
  previousTitle: string;
  title: string;
  canonicalUrl: string;
  previousCommitId: string;
  commitId: string;
  changed: boolean;
  titleChanged: boolean;
  bodyChanged: boolean;
}

export interface ReplaceLinksResult {
  action: "replace-links";
  fromTitle: string;
  toTitle: string;
  message: string;
}

export type CosenseWriteConflictReason =
  | "page-already-exists"
  | "page-missing"
  | "page-renamed"
  | "stale-commit"
  | "page-replaced"
  | "not-fast-forward"
  | "duplicate-title";

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

export class CosenseAuthenticationError extends Error {
  readonly status: 401 | 403;
  readonly operation: string;

  constructor(status: 401 | 403, operation: string) {
    super("Cosense authentication failed.");
    this.name = "CosenseAuthenticationError";
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

export class CosenseWriteConflictError extends Error {
  readonly reason: CosenseWriteConflictReason;
  readonly operation: string;
  readonly status: 409 | undefined;

  constructor(
    reason: CosenseWriteConflictReason,
    operation: string,
    status?: 409,
  ) {
    super("Cosense write conflict. Refresh the page before trying again.");
    this.name = "CosenseWriteConflictError";
    this.reason = reason;
    this.operation = operation;
    this.status = status;
  }
}

export class CosenseWriteOutcomeUnknownError extends Error {
  readonly operation: "page edit submit";

  constructor(cause: unknown) {
    super(
      "Cosense page edit outcome is unknown. Check the page before trying again.",
      { cause },
    );
    this.name = "CosenseWriteOutcomeUnknownError";
    this.operation = "page edit submit";
  }
}

export class CosenseReplaceLinksRetryableError extends Error {
  readonly operation: "replace links";

  constructor(cause: unknown) {
    super(
      "Cosense link replacement did not return a reliable result. Retry with the exact same titles.",
      { cause },
    );
    this.name = "CosenseReplaceLinksRetryableError";
    this.operation = "replace links";
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
  listPages(
    input: ListPagesInput,
    signal?: AbortSignal,
  ): Promise<ListPagesResult>;
  getPageChanges(
    input: GetPageChangesInput,
    signal?: AbortSignal,
  ): Promise<GetPageChangesResult>;
  createPage(
    input: CreatePageInput,
    signal?: AbortSignal,
  ): Promise<CreatePageResult>;
  appendToPage(
    input: AppendToPageInput,
    signal?: AbortSignal,
  ): Promise<AppendToPageResult>;
  updatePage(
    input: UpdatePageInput,
    signal?: AbortSignal,
  ): Promise<UpdatePageResult>;
  replaceLinks(
    input: ReplaceLinksInput,
    signal?: AbortSignal,
  ): Promise<ReplaceLinksResult>;
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
  personalAccessToken: string,
  url: string,
  operation: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const requestSignal = makeRequestSignal(signal);
  const response = await fetcher(url, {
    method: "GET",
    cache: "no-store",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "x-personal-access-token": personalAccessToken,
    },
    signal: requestSignal,
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CosenseAuthenticationError(response.status, operation);
    }
    throw new CosenseUpstreamError(response.status, operation);
  }

  try {
    return schema.parse(await response.json());
  } catch (error) {
    if (requestSignal.aborted) throw requestSignal.reason;
    throw new CosenseResponseError(operation, error);
  }
}

function makeRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal]);
}

async function parseWriteConflict(
  response: Response,
  operation: string,
): Promise<CosenseWriteConflictError | undefined> {
  if (response.status !== 409) return undefined;

  try {
    const body = editConflictResponseSchema.parse(await response.json());
    return new CosenseWriteConflictError(
      body.error === "NotFastForward" ? "not-fast-forward" : "duplicate-title",
      operation,
      409,
    );
  } catch {
    return undefined;
  }
}

async function requestWriteJson<T>(
  fetcher: Fetcher,
  personalAccessToken: string,
  url: string,
  operation: string,
  body: unknown,
  schema: z.ZodType<T>,
  outcomeCanBeUnknown: boolean,
  signal?: AbortSignal,
): Promise<T> {
  const requestSignal = makeRequestSignal(signal);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      cache: "no-store",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-personal-access-token": personalAccessToken,
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
  } catch (error) {
    if (outcomeCanBeUnknown) {
      throw new CosenseWriteOutcomeUnknownError(error);
    }
    throw error;
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CosenseAuthenticationError(response.status, operation);
    }
    const conflict = await parseWriteConflict(response, operation);
    if (conflict !== undefined) throw conflict;
    if (outcomeCanBeUnknown && response.status >= 500) {
      throw new CosenseWriteOutcomeUnknownError(
        new CosenseUpstreamError(response.status, operation),
      );
    }
    throw new CosenseUpstreamError(response.status, operation);
  }

  try {
    return schema.parse(await response.json());
  } catch (error) {
    if (outcomeCanBeUnknown) {
      throw new CosenseWriteOutcomeUnknownError(error);
    }
    if (requestSignal.aborted) throw requestSignal.reason;
    throw new CosenseResponseError(operation, error);
  }
}

async function requestReplaceLinks(
  fetcher: Fetcher,
  personalAccessToken: string,
  body: { from: string; to: string },
  signal?: AbortSignal,
): Promise<z.infer<typeof replaceLinksResponseSchema>> {
  const operation = "replace links";
  const requestSignal = makeRequestSignal(signal);
  let response: Response;
  try {
    response = await fetcher(apiUrl(`/api/pages/${PROJECT}/replace/links`), {
      method: "POST",
      cache: "no-store",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-personal-access-token": personalAccessToken,
      },
      body: JSON.stringify(body),
      signal: requestSignal,
    });
  } catch (error) {
    throw new CosenseReplaceLinksRetryableError(error);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CosenseAuthenticationError(response.status, operation);
    }
    if (response.status >= 500) {
      throw new CosenseReplaceLinksRetryableError(
        new CosenseUpstreamError(response.status, operation),
      );
    }
    throw new CosenseUpstreamError(response.status, operation);
  }

  try {
    return replaceLinksResponseSchema.parse(await response.json());
  } catch (error) {
    throw new CosenseReplaceLinksRetryableError(error);
  }
}

function newLineId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

type InsertChange = {
  _insert: string;
  lines: { id: string; text: string };
};

type UpdateChange = {
  _update: string;
  lines: { text: string };
};

type DeleteChange = {
  _delete: string;
};

type PageEditChange = InsertChange | UpdateChange | DeleteChange;

type EditableLine = z.infer<typeof editableExistingPageSchema>["lines"][number];

function makeInsertChanges(
  lines: string[],
  insertBefore = "_end",
): InsertChange[] {
  return lines.map((text) => ({
    _insert: insertBefore,
    lines: { id: newLineId(), text },
  }));
}

function assertPreviewLines(
  preview: z.infer<typeof editPreviewResponseSchema>,
  expected: {
    title: string;
    persistent: boolean;
    lines: EditableLine[];
  },
): void {
  const actual = preview.pagePreview;
  const linesMatch =
    actual.lines.length === expected.lines.length &&
    actual.lines.every((line, index) => {
      const expectedLine = expected.lines[index];
      return line.id === expectedLine?.id && line.text === expectedLine.text;
    });

  if (
    actual.title !== expected.title ||
    actual.persistent !== expected.persistent ||
    !linesMatch
  ) {
    throw new CosenseResponseError(
      "page edit preview",
      new Error("Preview did not match the requested edit."),
    );
  }
}

async function requestPageForWrite(
  fetcher: Fetcher,
  personalAccessToken: string,
  title: string,
  operation: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof pageResponseSchema> | undefined> {
  try {
    return await requestJson(
      fetcher,
      personalAccessToken,
      apiUrl(pagePath(title)),
      operation,
      pageResponseSchema,
      signal,
    );
  } catch (error) {
    if (error instanceof CosenseUpstreamError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

async function requestEditablePageForWrite(
  fetcher: Fetcher,
  personalAccessToken: string,
  title: string,
  operation: string,
  signal?: AbortSignal,
): Promise<z.infer<typeof editablePageResponseSchema> | undefined> {
  try {
    return await requestJson(
      fetcher,
      personalAccessToken,
      apiUrl(pagePath(title)),
      operation,
      editablePageResponseSchema,
      signal,
    );
  } catch (error) {
    if (error instanceof CosenseUpstreamError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

function requireEditableTarget(
  page: z.infer<typeof editablePageResponseSchema> | undefined,
  title: string,
  expectedCommitId: string,
  operation: "page append" | "page update",
  expectedPageId?: string,
): z.infer<typeof editableExistingPageSchema> {
  if (page === undefined || !page.persistent) {
    throw new CosenseWriteConflictError("page-missing", operation);
  }
  if (page.title !== title) {
    throw new CosenseWriteConflictError("page-renamed", operation);
  }
  if (expectedPageId !== undefined && page.id !== expectedPageId) {
    throw new CosenseWriteConflictError("page-replaced", operation);
  }
  if (page.commitId !== expectedCommitId) {
    throw new CosenseWriteConflictError("stale-commit", operation);
  }
  if (page.lines[0]?.text !== page.title) {
    throw new CosenseResponseError(
      operation,
      new Error("Editable page title line did not match the page title."),
    );
  }
  return page;
}

interface UpdatePlan {
  desiredTitle: string;
  changes: PageEditChange[];
  expectedLines: EditableLine[];
  titleChanged: boolean;
  bodyChanged: boolean;
}

function buildUpdatePlan(
  page: z.infer<typeof editableExistingPageSchema>,
  body: string | undefined,
  newTitle: string | undefined,
): UpdatePlan {
  const titleLine = page.lines[0] as EditableLine;
  const currentBody = page.lines.slice(1);
  const desiredBodyTexts =
    body === undefined
      ? currentBody.map(({ text }) => text)
      : body === ""
        ? []
        : body.split(/\r?\n/);
  const desiredTitle = newTitle ?? page.title;
  const titleChanged = desiredTitle !== page.title;
  const bodyChanged =
    desiredBodyTexts.length !== currentBody.length ||
    desiredBodyTexts.some((text, index) => text !== currentBody[index]?.text);

  let prefixLength = 0;
  while (
    prefixLength < currentBody.length &&
    prefixLength < desiredBodyTexts.length &&
    currentBody[prefixLength]?.text === desiredBodyTexts[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < currentBody.length - prefixLength &&
    suffixLength < desiredBodyTexts.length - prefixLength &&
    currentBody[currentBody.length - 1 - suffixLength]?.text ===
      desiredBodyTexts[desiredBodyTexts.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  const oldMiddle = currentBody.slice(
    prefixLength,
    currentBody.length - suffixLength,
  );
  const newMiddle = desiredBodyTexts.slice(
    prefixLength,
    desiredBodyTexts.length - suffixLength,
  );
  const pairedLength = Math.min(oldMiddle.length, newMiddle.length);
  const changes: PageEditChange[] = [];
  const desiredMiddle: EditableLine[] = [];

  if (titleChanged) {
    changes.push({ _update: titleLine.id, lines: { text: desiredTitle } });
  }

  for (let index = 0; index < pairedLength; index += 1) {
    const oldLine = oldMiddle[index] as EditableLine;
    const text = newMiddle[index] as string;
    desiredMiddle.push({ id: oldLine.id, text });
    if (oldLine.text !== text) {
      changes.push({ _update: oldLine.id, lines: { text } });
    }
  }

  const insertAnchor =
    suffixLength === 0
      ? "_end"
      : (currentBody[currentBody.length - suffixLength] as EditableLine).id;
  const insertChanges = makeInsertChanges(
    newMiddle.slice(pairedLength),
    insertAnchor,
  );
  changes.push(...insertChanges);
  desiredMiddle.push(...insertChanges.map(({ lines }) => lines));

  for (const oldLine of oldMiddle.slice(pairedLength)) {
    changes.push({ _delete: oldLine.id });
  }

  if (changes.length > MAX_WRITE_LINES) {
    throw new Error(
      `Page update must not require more than ${MAX_WRITE_LINES} changes.`,
    );
  }

  return {
    desiredTitle,
    changes,
    expectedLines: [
      { id: titleLine.id, text: desiredTitle },
      ...currentBody.slice(0, prefixLength),
      ...desiredMiddle,
      ...currentBody.slice(currentBody.length - suffixLength),
    ],
    titleChanged,
    bodyChanged,
  };
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

type UserMap = Map<string, string>;

type PageChangeEvent =
  | {
      kind: "title";
      userIds: string[];
      created?: number;
      title: string;
    }
  | {
      kind: "insert";
      userIds: string[];
      created?: number;
      text: string;
    }
  | {
      kind: "update";
      userIds: string[];
      created?: number;
      lineId: string;
      before: string;
      after: string;
    }
  | {
      kind: "delete";
      userIds: string[];
      created?: number;
      text: string;
    };

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function makeUserMap(data: z.infer<typeof usersResponseSchema>): UserMap {
  const users: UserMap = new Map();

  const addUser = (entry: z.infer<typeof userEntrySchema>): void => {
    const id = nonEmptyString(entry.id);
    if (id === undefined || users.has(id)) return;
    const name =
      nonEmptyString(entry.displayName) ?? nonEmptyString(entry.name);
    if (name !== undefined) users.set(id, name.slice(0, MAX_AUTHOR_LENGTH));
  };

  for (const user of data.users ?? []) addUser(user);
  for (const snapshot of data.memberSnapshots ?? []) {
    if (snapshot.data !== undefined) addUser(snapshot.data);
  }

  const addServiceAccount = (
    entry: z.infer<typeof serviceAccountEntrySchema>,
    deleted: boolean,
  ): void => {
    const id = nonEmptyString(entry.id);
    const usage = nonEmptyString(entry.usage);
    if (id === undefined || usage === undefined || users.has(id)) return;
    const suffix = deleted
      ? " (deleted service account)"
      : " (service account)";
    users.set(id, `${usage}${suffix}`.slice(0, MAX_AUTHOR_LENGTH));
  };

  for (const account of data.serviceAccounts ?? []) {
    addServiceAccount(account, false);
  }
  for (const snapshot of data.serviceAccountSnapshots ?? []) {
    addServiceAccount(snapshot, true);
  }

  return users;
}

function buildPageChangeEvents(
  commits: z.infer<typeof commitSchema>[],
): PageChangeEvent[] {
  const events: PageChangeEvent[] = [];

  for (const commit of commits) {
    const userId = commit.userId ?? "";
    for (const change of commit.changes ?? []) {
      if (typeof change.title === "string") {
        events.push({
          kind: "title",
          userIds: [userId],
          ...(commit.created === undefined ? {} : { created: commit.created }),
          title: change.title,
        });
      } else if (typeof change._insert === "string") {
        events.push({
          kind: "insert",
          userIds: [userId],
          ...(commit.created === undefined ? {} : { created: commit.created }),
          text: change.lines?.text ?? "",
        });
      } else if (typeof change._update === "string") {
        const previous = events.at(-1);
        if (previous?.kind === "update" && previous.lineId === change._update) {
          previous.after = change.lines?.text ?? "";
          if (commit.created === undefined) {
            delete previous.created;
          } else {
            previous.created = commit.created;
          }
          if (userId !== "" && !previous.userIds.includes(userId)) {
            previous.userIds.push(userId);
          }
        } else {
          events.push({
            kind: "update",
            userIds: [userId],
            ...(commit.created === undefined
              ? {}
              : { created: commit.created }),
            lineId: change._update,
            before: change.lines?.origText ?? "",
            after: change.lines?.text ?? "",
          });
        }
      } else if (typeof change._delete === "string") {
        events.push({
          kind: "delete",
          userIds: [userId],
          ...(commit.created === undefined ? {} : { created: commit.created }),
          text: change.lines?.origText ?? "",
        });
      }
    }
  }

  return events;
}

function resolveAuthors(userIds: string[], users: UserMap): string[] {
  return [
    ...new Set(userIds.map((userId) => users.get(userId) ?? "Unknown user")),
  ];
}

function compactChangeText(text: string): string {
  return text.slice(0, MAX_CHANGE_TEXT_LENGTH);
}

function mapPageChangeEvent(
  event: PageChangeEvent,
  users: UserMap,
): PageChangeResultItem {
  const common = {
    kind: event.kind,
    authors: resolveAuthors(event.userIds, users),
    ...(event.created === undefined
      ? {}
      : { createdAt: toIsoTime(event.created) }),
  };

  switch (event.kind) {
    case "title":
      return { ...common, after: compactChangeText(event.title) };
    case "insert":
      return { ...common, after: compactChangeText(event.text) };
    case "update":
      return {
        ...common,
        before: compactChangeText(event.before),
        after: compactChangeText(event.after),
      };
    case "delete":
      return { ...common, before: compactChangeText(event.text) };
  }
}

export function createCosenseClient(
  personalAccessToken: string,
  fetcher: Fetcher = globalThis.fetch,
): CosenseClient {
  if (
    typeof personalAccessToken !== "string" ||
    personalAccessToken.trim() === ""
  ) {
    throw new Error("Cosense Personal Access Token is required.");
  }

  return {
    async getPage(input, signal) {
      const { title } = getPageInputSchema.parse(input);
      let page: z.infer<typeof pageResponseSchema>;
      try {
        page = await requestJson(
          fetcher,
          personalAccessToken,
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
        personalAccessToken,
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
        personalAccessToken,
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
          personalAccessToken,
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
          personalAccessToken,
          apiUrl(pagePath(parsed.title)),
          "relation base page",
          relationBasePageSchema,
          signal,
        ),
        requestJson(
          fetcher,
          personalAccessToken,
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

    async listPages(input, signal) {
      const parsed = listPagesInputSchema.parse(input);
      const params = new URLSearchParams();
      params.set("sort", parsed.sort);
      params.set("limit", String(parsed.limit));
      params.set("skip", String(parsed.skip));

      const response = await requestJson(
        fetcher,
        personalAccessToken,
        apiUrl(`/api/pages/${PROJECT}/`, params),
        "page list",
        listPagesResponseSchema,
        signal,
      );
      const results = response.pages
        .slice(0, parsed.limit)
        .map((page): ListedPageResultItem => ({
          pageId: page.id,
          title: page.title,
          canonicalUrl: canonicalUrl(page.title),
          descriptions: (page.descriptions ?? [])
            .slice(0, 5)
            .map((description) => description.slice(0, 240)),
          ...(page.pin === undefined ? {} : { pin: page.pin }),
          ...(page.views === undefined ? {} : { views: page.views }),
          ...(page.linked === undefined ? {} : { linked: page.linked }),
          ...(page.linesCount === undefined
            ? {}
            : { linesCount: page.linesCount }),
          ...(page.charsCount === undefined
            ? {}
            : { charsCount: page.charsCount }),
          ...(page.created === undefined
            ? {}
            : { createdAt: toIsoTime(page.created) }),
          ...(page.updated === undefined
            ? {}
            : { updatedAt: toIsoTime(page.updated) }),
          ...(page.accessed === undefined
            ? {}
            : { accessedAt: toIsoTime(page.accessed) }),
        }));
      const nextSkip = response.skip + results.length;
      const hasNext = results.length > 0 && nextSkip < response.count;

      return {
        reportedCount: response.count,
        skip: response.skip,
        returned: results.length,
        hasNext,
        ...(hasNext ? { nextSkip } : {}),
        results,
      };
    },

    async getPageChanges(input, signal) {
      const parsed = getPageChangesInputSchema.parse(input);
      const params = new URLSearchParams();
      if (parsed.commitId !== undefined) {
        params.set("head", parsed.commitId);
      }
      const changesUrl = apiUrl(
        `/api/commits/${PROJECT}/${encodeURIComponent(parsed.pageId)}`,
        params.size === 0 ? undefined : params,
      );

      const [changesResponse, usersResponse] = await Promise.all([
        requestJson(
          fetcher,
          personalAccessToken,
          changesUrl,
          "page changes",
          commitsResponseSchema,
          signal,
        ),
        requestJson(
          fetcher,
          personalAccessToken,
          apiUrl(`/api/projects/${PROJECT}/users`),
          "project users",
          usersResponseSchema,
          signal,
        ),
      ]);

      const commits = changesResponse.commits ?? [];
      const events = buildPageChangeEvents(commits);
      const selectedEvents = events.slice(-MAX_CHANGE_EVENTS);
      const users = makeUserMap(usersResponse);
      const latestCommitId = commits.at(-1)?.id;
      const latestTitle = events
        .filter((event) => event.kind === "title")
        .at(-1)?.title;

      return {
        pageId: parsed.pageId,
        ...(parsed.commitId === undefined
          ? {}
          : { afterCommitId: parsed.commitId }),
        commitCount: commits.length,
        totalChanges: events.length,
        returned: selectedEvents.length,
        truncated: events.length > selectedEvents.length,
        ...(latestCommitId === undefined ? {} : { latestCommitId }),
        ...(latestTitle === undefined
          ? {}
          : {
              latestTitleChange: {
                title: latestTitle,
                canonicalUrl: canonicalUrl(latestTitle),
              },
            }),
        changes: selectedEvents.map((event) =>
          mapPageChangeEvent(event, users),
        ),
      };
    },

    async createPage(input, signal) {
      const parsed = createPageInputSchema.parse(input);
      const current = await requestPageForWrite(
        fetcher,
        personalAccessToken,
        parsed.title,
        "page create preflight",
        signal,
      );
      if (current?.persistent) {
        throw new CosenseWriteConflictError(
          "page-already-exists",
          "page create",
        );
      }

      const lines = [parsed.title, ...parsed.text.split(/\r?\n/)];
      const changes = makeInsertChanges(lines);
      const preview = await requestWriteJson(
        fetcher,
        personalAccessToken,
        apiUrl(`/api/pages/v2/${PROJECT}/page-edit-for-ai/preview`),
        "page edit preview",
        { changes },
        editPreviewResponseSchema,
        false,
        signal,
      );
      assertPreviewLines(preview, {
        title: parsed.title,
        persistent: false,
        lines: changes.map(({ lines }) => lines),
      });

      const rechecked = await requestPageForWrite(
        fetcher,
        personalAccessToken,
        parsed.title,
        "page create recheck",
        signal,
      );
      if (rechecked?.persistent) {
        throw new CosenseWriteConflictError(
          "page-already-exists",
          "page create",
        );
      }

      const submitted = await requestWriteJson(
        fetcher,
        personalAccessToken,
        apiUrl(`/api/pages/v2/${PROJECT}/page-edit-for-ai/submit`),
        "page edit submit",
        { previewId: preview.previewId },
        editSubmitResponseSchema,
        true,
        signal,
      );

      return {
        action: "create",
        title: submitted.page.title,
        canonicalUrl: canonicalUrl(submitted.page.title),
        commitId: submitted.commitId,
        addedLines: lines.length,
      };
    },

    async appendToPage(input, signal) {
      const parsed = appendToPageInputSchema.parse(input);
      const current = requireEditableTarget(
        await requestEditablePageForWrite(
          fetcher,
          personalAccessToken,
          parsed.title,
          "page append preflight",
          signal,
        ),
        parsed.title,
        parsed.expectedCommitId,
        "page append",
      );
      const lines = parsed.text.split(/\r?\n/);
      const changes = makeInsertChanges(lines);
      const preview = await requestWriteJson(
        fetcher,
        personalAccessToken,
        apiUrl(`/api/pages/v2/${PROJECT}/page-edit-for-ai/preview`),
        "page edit preview",
        { pageId: current.id, changes },
        editPreviewResponseSchema,
        false,
        signal,
      );
      assertPreviewLines(preview, {
        title: parsed.title,
        persistent: true,
        lines: [...current.lines, ...changes.map(({ lines }) => lines)],
      });

      requireEditableTarget(
        await requestEditablePageForWrite(
          fetcher,
          personalAccessToken,
          parsed.title,
          "page append recheck",
          signal,
        ),
        parsed.title,
        parsed.expectedCommitId,
        "page append",
        current.id,
      );

      const submitted = await requestWriteJson(
        fetcher,
        personalAccessToken,
        apiUrl(`/api/pages/v2/${PROJECT}/page-edit-for-ai/submit`),
        "page edit submit",
        { previewId: preview.previewId },
        editSubmitResponseSchema,
        true,
        signal,
      );

      return {
        action: "append",
        title: submitted.page.title,
        canonicalUrl: canonicalUrl(submitted.page.title),
        commitId: submitted.commitId,
        previousCommitId: parsed.expectedCommitId,
        addedLines: lines.length,
      };
    },

    async updatePage(input, signal) {
      const parsed = updatePageInputSchema.parse(input);
      const current = requireEditableTarget(
        await requestEditablePageForWrite(
          fetcher,
          personalAccessToken,
          parsed.title,
          "page update preflight",
          signal,
        ),
        parsed.title,
        parsed.expectedCommitId,
        "page update",
      );
      const plan = buildUpdatePlan(current, parsed.body, parsed.newTitle);

      if (plan.changes.length === 0) {
        return {
          action: "update",
          previousTitle: current.title,
          title: current.title,
          canonicalUrl: canonicalUrl(current.title),
          previousCommitId: current.commitId,
          commitId: current.commitId,
          changed: false,
          titleChanged: false,
          bodyChanged: false,
        };
      }

      const preview = await requestWriteJson(
        fetcher,
        personalAccessToken,
        apiUrl(`/api/pages/v2/${PROJECT}/page-edit-for-ai/preview`),
        "page edit preview",
        { pageId: current.id, changes: plan.changes },
        editPreviewResponseSchema,
        false,
        signal,
      );
      if (
        plan.titleChanged &&
        preview.pagePreview.title !== plan.desiredTitle
      ) {
        throw new CosenseWriteConflictError("duplicate-title", "page update");
      }
      assertPreviewLines(preview, {
        title: plan.desiredTitle,
        persistent: true,
        lines: plan.expectedLines,
      });

      requireEditableTarget(
        await requestEditablePageForWrite(
          fetcher,
          personalAccessToken,
          parsed.title,
          "page update recheck",
          signal,
        ),
        parsed.title,
        parsed.expectedCommitId,
        "page update",
        current.id,
      );

      const submitted = await requestWriteJson(
        fetcher,
        personalAccessToken,
        apiUrl(`/api/pages/v2/${PROJECT}/page-edit-for-ai/submit`),
        "page edit submit",
        { previewId: preview.previewId },
        editSubmitResponseSchema,
        true,
        signal,
      );

      return {
        action: "update",
        previousTitle: current.title,
        title: submitted.page.title,
        canonicalUrl: canonicalUrl(submitted.page.title),
        previousCommitId: current.commitId,
        commitId: submitted.commitId,
        changed: true,
        titleChanged: plan.titleChanged,
        bodyChanged: plan.bodyChanged,
      };
    },

    async replaceLinks(input, signal) {
      const parsed = replaceLinksInputSchema.parse(input);
      const response = await requestReplaceLinks(
        fetcher,
        personalAccessToken,
        { from: parsed.fromTitle, to: parsed.toTitle },
        signal,
      );
      return {
        action: "replace-links",
        fromTitle: parsed.fromTitle,
        toTitle: parsed.toTitle,
        message: response.message,
      };
    },
  };
}
