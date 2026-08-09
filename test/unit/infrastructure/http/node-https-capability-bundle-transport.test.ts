import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createNodeHttpsCapabilityBundleTransport,
  type NodeHttpsDnsResolver,
  type NodeHttpsRequest,
} from "../../../../src/infrastructure/http/node-https-capability-bundle-transport.js";

describe("Node HTTPS capability bundle transport", () => {
  it("resolves both public address families with a cancellable resolver", async () => {
    const resolver: NodeHttpsDnsResolver = {
      resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
      resolve6: vi.fn().mockResolvedValue(["2606:2800:220:1:248:1893:25c8:1946"]),
      cancel: vi.fn(),
    };
    const transport = createNodeHttpsCapabilityBundleTransport({
      createResolver: vi.fn(() => resolver),
      request: vi.fn() as unknown as NodeHttpsRequest,
    });

    await expect(
      transport.resolveHostname("packages.example.test", new AbortController().signal),
    ).resolves.toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
    expect(resolver.resolve4).toHaveBeenCalledWith("packages.example.test");
    expect(resolver.resolve6).toHaveBeenCalledWith("packages.example.test");
  });

  it("cancels outstanding DNS queries when the signal aborts", async () => {
    let rejectIpv4: (error: Error) => void = () => undefined;
    let rejectIpv6: (error: Error) => void = () => undefined;
    const resolver: NodeHttpsDnsResolver = {
      resolve4: vi.fn(
        async () =>
          await new Promise<readonly string[]>((_resolve, reject) => {
            rejectIpv4 = reject;
          }),
      ),
      resolve6: vi.fn(
        async () =>
          await new Promise<readonly string[]>((_resolve, reject) => {
            rejectIpv6 = reject;
          }),
      ),
      cancel: vi.fn(() => {
        rejectIpv4(new Error("DNS cancelled"));
        rejectIpv6(new Error("DNS cancelled"));
      }),
    };
    const transport = createNodeHttpsCapabilityBundleTransport({
      createResolver: vi.fn(() => resolver),
      request: vi.fn() as unknown as NodeHttpsRequest,
    });
    const controller = new AbortController();
    const pending = transport.resolveHostname("packages.example.test", controller.signal);

    controller.abort(new Error("cancelled by caller"));

    await expect(pending).rejects.toThrow("cancelled by caller");
    expect(resolver.cancel).toHaveBeenCalledOnce();
  });

  it("opens HTTPS with the validated address pinned into socket lookup", async () => {
    const response = Readable.from([Buffer.from("bundle")]) as Readable & {
      statusCode: number;
      headers: Readonly<Record<string, string>>;
    };
    response.statusCode = 200;
    response.headers = { "content-length": "6" };
    const requestHandle = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
    requestHandle.end = vi.fn();
    const request = vi.fn((_url, _options, receiveResponse) => {
      receiveResponse(response);
      return requestHandle;
    }) as unknown as NodeHttpsRequest;
    const transport = createNodeHttpsCapabilityBundleTransport({
      createResolver: vi.fn(),
      request,
    });
    const signal = new AbortController().signal;

    const opened = await transport.openPinnedResponse({
      url: "https://packages.example.test/review.flowpkg",
      hostname: "packages.example.test",
      address: { address: "93.184.216.34", family: 4 },
      headers: { accept: "application/test", "user-agent": "flow-harness" },
      signal,
    });

    expect(request).toHaveBeenCalledOnce();
    const call = vi.mocked(request).mock.calls[0];
    if (call === undefined) {
      throw new Error("expected one HTTPS request");
    }
    const [url, options] = call;
    expect(url.toString()).toBe("https://packages.example.test/review.flowpkg");
    expect(options).toMatchObject({
      method: "GET",
      agent: false,
      headers: { accept: "application/test", "user-agent": "flow-harness" },
      signal,
    });
    if (options.lookup === undefined) {
      throw new Error("expected HTTPS request to pin socket lookup");
    }
    const lookupResult = await invokeLookup(options.lookup, "packages.example.test");
    expect(lookupResult).toEqual({ address: "93.184.216.34", family: 4 });
    expect(requestHandle.end).toHaveBeenCalledOnce();
    expect(opened).toMatchObject({ statusCode: 200, headers: { "content-length": "6" } });
    opened.close();
    expect(response.destroyed).toBe(true);
  });
});

async function invokeLookup(
  lookup: NonNullable<Parameters<NodeHttpsRequest>[1]["lookup"]>,
  hostname: string,
): Promise<{ readonly address: string; readonly family: number }> {
  return await new Promise((resolve, reject) => {
    lookup(hostname, {}, (error, address, family) => {
      if (error !== null) {
        reject(error);
        return;
      }
      if (typeof address !== "string") {
        reject(new Error("expected pinned lookup to return one address"));
        return;
      }
      if (family === undefined) {
        reject(new Error("expected pinned lookup to return an address family"));
        return;
      }
      resolve({ address, family });
    });
  });
}
