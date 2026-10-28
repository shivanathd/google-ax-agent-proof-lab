import { describe, expect, it } from "vitest";
import { axAddressRule, parseAxAllowlist } from "../../profiles/ax/allowlist.ts";

const floci = { scheme: "http" as const, host: "floci.apl-ax-0123abcd.svc.cluster.local", port: 4566, addresses: ["10.0.0.7"] };

describe("AX allowlist (profiles/ax/allowlist.ts)", () => {
  it("accepts loopback and lab-namespace service hosts with pinned addresses only", () => {
    expect(parseAxAllowlist(JSON.stringify([floci, { scheme: "http", host: "127.0.0.1", port: 1 }]))).toHaveLength(2);
    expect(() => parseAxAllowlist(JSON.stringify([{ ...floci, addresses: [] }]))).toThrow(/pinned addresses/);
    expect(() => parseAxAllowlist(JSON.stringify([{ ...floci, host: "floci.default.svc.cluster.local" }]))).toThrow(/lab-namespace/);
    expect(() => parseAxAllowlist(JSON.stringify([{ ...floci, host: "example.com" }]))).toThrow(/lab-namespace/);
    expect(() => parseAxAllowlist(JSON.stringify([{ ...floci, scheme: "https" }]))).toThrow(/only http/);
  });

  it("requires a service host to resolve to exactly its pinned ClusterIPs, and loopback to stay loopback", () => {
    const rule = axAddressRule([floci]);
    expect(rule(floci, ["10.0.0.7"])).toBe(true);
    expect(rule(floci, ["10.0.0.7", "10.0.0.8"])).toBe(false);
    expect(rule({ ...floci, port: 4567 }, ["10.0.0.7"])).toBe(false);
    expect(rule({ scheme: "http", host: "127.0.0.1", port: 1 }, ["127.0.0.1"])).toBe(true);
    expect(rule({ scheme: "http", host: "localhost", port: 1 }, ["10.0.0.7"])).toBe(false);
  });
});
