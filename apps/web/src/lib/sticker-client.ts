import {
  StickerPageRequestSchema,
  StickerPackRequestSchema,
  StickerPackPageSchema,
  StickerPageSchema,
  StickerFavoriteSchema,
  StickerFavoriteImageSchema,
  StickerFavoriteResultSchema,
  StickerStageSchema,
  stickerMediaUrl,
  validateStickerStageResult,
  validate,
  type ImageRef,
  type StickerStage,
} from "@lamplit/contracts";

/** One instance belongs to one authenticated chat session and must be closed on session change. */
export class StickerClient {
  private closed = false;
  private authorizationLost?: 401 | 403;
  private epoch = Symbol();
  private authorizationListeners = new Set<(status: 401 | 403) => void>();
  private media = new Map<string, { blob: Blob; etag: string }>();
  private bytes = 0;
  private listeners = new Map<string, Set<(blob: Blob | null) => void>>();
  private generations = new Map<string, symbol>();
  constructor(
    readonly sessionId: string,
    private readonly isCurrent: () => boolean,
    private readonly transport: typeof fetch = fetch,
  ) {}
  /** The instance cannot be reused after authorization loss; reconnect with a new instance. */
  onAuthorizationLost(listener: (status: 401 | 403) => void): () => void {
    if (this.authorizationLost) listener(this.authorizationLost);
    else if (!this.closed) this.authorizationListeners.add(listener);
    return () => this.authorizationListeners.delete(listener);
  }
  /** Propagate an authenticated session's explicit 401/403 to this active client. */
  revokeAuthorization(status: 401 | 403) {
    if (this.closed || this.authorizationLost || !this.isCurrent()) return;
    this.authorizationLost = status;
    const listeners = [...this.authorizationListeners];
    this.authorizationListeners.clear();
    this.clear();
    for (const listener of listeners) listener(status);
  }
  close() {
    this.closed = true;
    this.authorizationListeners.clear();
    this.clear();
  }
  private clear() {
    this.epoch = Symbol();
    this.media.clear();
    this.bytes = 0;
    const listeners = this.listeners;
    this.listeners = new Map();
    this.generations.clear();
    for (const group of listeners.values())
      for (const update of group) update(null);
  }
  private assertCurrent() {
    if (this.authorizationLost) throw new Error("Sticker authorization lost");
    if (this.closed || !this.isCurrent()) {
      this.clear();
      throw new Error("Stale sticker session");
    }
  }
  private assertEpoch(epoch: symbol) {
    this.assertCurrent();
    if (this.epoch !== epoch) throw new Error("Stale sticker request");
  }
  private async request(path: string, init?: RequestInit) {
    this.assertCurrent();
    const epoch = this.epoch;
    const response = await this.transport.call(globalThis, path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
    });
    this.assertEpoch(epoch);
    if (response.status === 401 || response.status === 403)
      this.revokeAuthorization(response.status);
    return response;
  }
  private async json(path: string, value?: unknown) {
    const epoch = this.epoch;
    const response = await this.request(
      path,
      value === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(value),
          },
    );
    if (!response.ok)
      throw new Error(`Sticker request failed: ${response.status}`);
    const result: unknown = await response.json();
    this.assertEpoch(epoch);
    return result;
  }
  async page(
    kind: "packs" | "favorites" | "search" | "pack",
    options: {
      cursor?: string | null;
      limit?: number;
      query?: string;
      packId?: string;
    } = {},
  ) {
    const epoch = this.epoch;
    const input = validate(StickerPageRequestSchema, {
      sessionId: this.sessionId,
      cursor: options.cursor ?? null,
      limit: options.limit ?? 30,
      ...(options.query === undefined ? {} : { query: options.query }),
    });
    let path: string = kind;
    if (kind === "pack") {
      const pack = validate(StickerPackRequestSchema, {
        sessionId: input.sessionId,
        cursor: input.cursor,
        limit: input.limit,
        packId: options.packId,
      });
      if (input.query !== undefined) throw new Error("Invalid pack query");
      path = `packs/${encodeURIComponent(pack.packId)}`;
    }
    const query = new URLSearchParams({
      sessionId: input.sessionId,
      limit: String(input.limit),
    });
    if (input.cursor) query.set("cursor", input.cursor);
    if (input.query !== undefined) query.set("query", input.query);
    const raw = await this.json(`/api/stickers/${path}?${query}`);
    this.assertEpoch(epoch);
    const page =
      kind === "packs"
        ? validate(StickerPackPageSchema, raw)
        : validate(StickerPageSchema, raw);
    if (
      ("packs" in page ? page.packs.length : page.stickers.length) > input.limit
    )
      throw new Error("Invalid sticker page size");
    return page;
  }
  async favorite(stickerId: string, favorite: boolean) {
    const epoch = this.epoch;
    const input = validate(StickerFavoriteSchema, {
      sessionId: this.sessionId,
      stickerId,
      favorite,
    });
    const result = validate(
      StickerFavoriteResultSchema,
      await this.json("/api/stickers/favorites", input),
    );
    this.assertEpoch(epoch);
    if (result.sticker.id !== stickerId || result.favorite !== favorite)
      throw new Error("Invalid favorite result");
    return result;
  }
  async favoriteImage(image: ImageRef) {
    if (image.sticker) return this.favorite(image.sticker.id, true);
    const epoch = this.epoch;
    const input = validate(StickerFavoriteImageSchema, {
      sessionId: this.sessionId,
      imageId: image.attachmentId,
      name: image.name.trim().slice(0, 160) || "Image",
      tags: [],
    });
    const result = validate(
      StickerFavoriteResultSchema,
      await this.json("/api/stickers/favorites/image", input),
    );
    this.assertEpoch(epoch);
    if (!result.favorite) throw new Error("Invalid favorite result");
    return result;
  }
  async stage(input: StickerStage) {
    const epoch = this.epoch;
    const request = validate(StickerStageSchema, input);
    if (request.sessionId !== this.sessionId)
      throw new Error("Wrong sticker session");
    const result = validateStickerStageResult(
      await this.json("/api/stickers/stage", request),
      request,
    );
    this.assertEpoch(epoch);
    return result.image;
  }
  /** Returns the same-session cached blob immediately and always starts revalidation. */
  loadMedia(
    version: string,
    variant: "thumbnail" | "original",
    update: (blob: Blob | null) => void,
  ) {
    this.assertCurrent();
    const path = stickerMediaUrl(version, variant);
    const epoch = this.epoch;
    const generation = Symbol();
    this.generations.set(path, generation);
    const listeners = this.listeners.get(path) ?? new Set();
    listeners.add(update);
    this.listeners.set(path, listeners);
    const current = () => this.generations.get(path) === generation;
    const notify = (blob: Blob | null) => {
      for (const listener of listeners) {
        if (!current()) return;
        this.assertCurrent();
        listener(blob);
      }
    };
    const cached = this.media.get(path);
    if (cached) update(cached.blob);
    const revalidated = (async () => {
      const response = await this.request(
        path,
        cached ? { headers: { "If-None-Match": cached.etag } } : undefined,
      );
      if (response.status === 401 || response.status === 403) return;
      if (response.status === 404) {
        this.assertEpoch(epoch);
        const paths = [
          stickerMediaUrl(version, "thumbnail"),
          stickerMediaUrl(version, "original"),
        ];
        for (const item of paths) {
          this.generations.delete(item);
          this.evict(item);
        }
        for (const item of paths) {
          for (const listener of this.listeners.get(item) ?? []) {
            this.assertCurrent();
            listener(null);
          }
        }
        return;
      }
      if (!current()) return;
      if (response.status === 304 && cached) return;
      if (!response.ok)
        throw new Error(`Sticker media failed: ${response.status}`);
      const blob = await response.blob();
      this.assertCurrent();
      if (!current()) return;
      const max = variant === "thumbnail" ? 160_000 : 5 * 1024 * 1024;
      if (
        !blob.size ||
        blob.size > max ||
        (variant === "thumbnail" && blob.type !== "image/webp")
      )
        throw new Error("Invalid sticker media");
      const etag = response.headers.get("etag");
      this.evict(path);
      if (etag) {
        // Bounded, session-local memory only; oldest entries are evicted first.
        while (
          this.bytes + blob.size > 10 * 1024 * 1024 ||
          this.media.size >= 128
        )
          this.evict(this.media.keys().next().value!);
        this.media.set(path, { blob, etag });
        this.bytes += blob.size;
      }
      notify(blob);
    })();
    return revalidated.finally(() => {
      if (current()) this.generations.delete(path);
    });
  }
  /** Unsubscribe when a view no longer displays the media. */
  releaseMedia(
    version: string,
    variant: "thumbnail" | "original",
    update: (blob: Blob | null) => void,
  ) {
    const path = stickerMediaUrl(version, variant);
    const listeners = this.listeners.get(path);
    listeners?.delete(update);
    if (!listeners?.size) this.listeners.delete(path);
  }
  private evict(path: string) {
    const entry = this.media.get(path);
    if (entry) this.bytes -= entry.blob.size;
    this.media.delete(path);
  }
}
