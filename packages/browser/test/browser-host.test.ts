import { createServer } from "node:http";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BrowserHost } from "../src/browser-host.js";

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("BrowserHost", () => {
  const hosts: BrowserHost[] = [];

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.close()));
  });

  it("reuses a page per source while keeping sources isolated", async () => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>fixture</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let host: BrowserHost | undefined;

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("fixture server did not expose a TCP address");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const profilePath = await mkdtemp(join(tmpdir(), "event-agg-browser-"));
      host = new BrowserHost({
        profilePath,
        launchOptions: {
          executablePath: chromePath,
          headless: true
        }
      });
      hosts.push(host);

      const luma = await host.pageFor("luma", origin);
      const sameLuma = await host.pageFor("luma", origin);
      const guild = await host.pageFor("guild", origin);

      expect(sameLuma).toBe(luma);
      expect(guild).not.toBe(luma);
      expect(await luma.title()).toBe("fixture");
      expect((await stat(profilePath)).mode & 0o777).toBe(0o700);

      await host.closeSource("luma");
      expect(luma.isClosed()).toBe(true);
      expect(await guild.title()).toBe("fixture");
    } finally {
      if (host !== undefined) {
        await host.close();
        hosts.splice(hosts.indexOf(host), 1);
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }, 20_000);
});
