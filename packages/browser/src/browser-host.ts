import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import type { EventSource, ResolvedSearchQuery } from "@event-agg/core";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Response
} from "playwright-core";

type PersistentContextOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;

export interface ObservedSearchContract {
  source: EventSource;
  origin: string;
  allowedHosts: readonly string[];
  connectUrl: string;
  performSearch(page: Page, query: ResolvedSearchQuery): Promise<void>;
  responseMatches(response: Response): boolean;
}

export interface BrowserHostOptions {
  profilePath?: string;
  launchOptions?: PersistentContextOptions;
}

export class BrowserHost {
  readonly profilePath: string;

  private contextPromise: Promise<BrowserContext> | null = null;
  private readonly pages = new Map<EventSource, Promise<Page>>();
  private readonly launchOptions: PersistentContextOptions;

  constructor(options: BrowserHostOptions = {}) {
    this.profilePath = resolve(options.profilePath ?? ".data/chrome-profile");
    this.launchOptions = options.launchOptions ?? {};
  }

  async pageFor(source: EventSource, origin: string): Promise<Page> {
    const target = parseWebUrl(origin);
    const existing = this.pages.get(source);
    if (existing !== undefined) {
      const page = await existing;
      if (!page.isClosed()) return page;
      this.pages.delete(source);
    }

    const pagePromise = this.createSourcePage(target.href);
    this.pages.set(source, pagePromise);

    try {
      return await pagePromise;
    } catch (error) {
      if (this.pages.get(source) === pagePromise) this.pages.delete(source);
      throw error;
    }
  }

  async closeSource(source: EventSource): Promise<void> {
    const pagePromise = this.pages.get(source);
    this.pages.delete(source);
    if (pagePromise === undefined) return;

    const page = await pagePromise;
    if (!page.isClosed()) await page.close();
  }

  async close(): Promise<void> {
    this.pages.clear();
    const contextPromise = this.contextPromise;
    this.contextPromise = null;
    if (contextPromise === null) return;

    const context = await contextPromise;
    await context.close();
  }

  private async createSourcePage(target: string): Promise<Page> {
    const context = await this.context();
    const page = await context.newPage();
    try {
      await page.goto(target, { waitUntil: "domcontentloaded" });
      return page;
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  private context(): Promise<BrowserContext> {
    if (this.contextPromise !== null) return this.contextPromise;

    const pending = this.launchContext();
    this.contextPromise = pending;
    void pending.catch(() => {
      if (this.contextPromise === pending) this.contextPromise = null;
    });
    return pending;
  }

  private async launchContext(): Promise<BrowserContext> {
    await mkdir(this.profilePath, { recursive: true, mode: 0o700 });
    await chmod(this.profilePath, 0o700);
    return chromium.launchPersistentContext(this.profilePath, {
      channel: "chrome",
      headless: false,
      serviceWorkers: "block",
      ...this.launchOptions
    });
  }
}

function parseWebUrl(value: string): URL {
  const target = new URL(value);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new TypeError("BrowserHost only accepts HTTP(S) origins");
  }
  return target;
}
