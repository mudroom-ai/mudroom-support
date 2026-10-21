import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { hostValidation } from "../src/middleware/hosts.js";

/** Runs the middleware once; returns the rejection message, or null when it called next(). */
function run(bindHost: string, allowed: string[], host: string, origin?: string): string | null {
  let rejected: string | null = null;
  const mw = hostValidation(bindHost, allowed, (_res, e) => void (rejected = e.message), () => {});
  mw({ headers: { host, ...(origin ? { origin } : {}) } } as Request, {} as Response, () => {});
  return rejected;
}

describe("hostValidation fails closed", () => {
  it("a specific non-loopback bind accepts only its own address or localhost", () => {
    expect(run("192.168.1.5", [], "192.168.1.5:3000")).toBeNull();
    expect(run("192.168.1.5", [], "localhost")).toBeNull();
    expect(run("192.168.1.5", [], "evil.example.com")).toMatch(/Host not allowed/);
  });

  it("any 127.0.0.0/8 bind is loopback: Host and Origin are checked", () => {
    expect(run("127.0.0.2", [], "127.0.0.2:3000")).toBeNull();
    expect(run("127.0.0.2", [], "evil.example.com")).toMatch(/Host not allowed/);
    expect(run("127.0.0.2", [], "localhost", "https://evil.example.com")).toMatch(/Origin not allowed/);
  });

  it("an IPv6 bind matches its bracketed Host", () => {
    expect(run("fd00::5", [], "[fd00::5]:3000")).toBeNull();
    expect(run("fd00::5", [], "evil.example.com")).toMatch(/Host not allowed/);
  });

  it("only a wildcard bind with no ALLOWED_HOSTS skips the check", () => {
    expect(run("0.0.0.0", [], "evil.example.com")).toBeNull();
  });
});
