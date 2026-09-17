/** ATA -> owner resolver tests. Fetch is injected; no RPC calls. */
import assert from "node:assert/strict";

import { createRpcResolveOwner } from "../src/resolve-owner.js";

const OWNER = "MerchantOwnerWa11etAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function fakeFetch(payload: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => payload })) as unknown as typeof fetch;
}

/* Only a parsed token account may supply the wallet owner. */
{
  let request: { url?: string; init?: RequestInit } = {};
  const resolve = createRpcResolveOwner({
    rpcUrl: "http://rpc.invalid",
    fetchImpl: (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      request = { url: String(url), init };
      return {
        ok: true,
        json: async () => ({
          result: {
            value: {
              owner: TOKEN_PROGRAM,
              data: { parsed: { type: "account", info: { owner: OWNER } } },
            },
          },
        }),
      };
    }) as unknown as typeof fetch,
  });
  assert.equal(await resolve("SomeAta"), OWNER);
  assert.equal(request.url, "http://rpc.invalid");
  assert.deepEqual(JSON.parse(String(request.init?.body)), {
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: ["SomeAta", { encoding: "jsonParsed" }],
  });
  console.log("ok  parsed token account resolves to its owner");
}

/* A mint-shaped response must not be mistaken for a token account owner. */
{
  const resolve = createRpcResolveOwner({
    rpcUrl: "http://rpc.invalid",
    fetchImpl: fakeFetch({
      result: {
        value: {
          owner: TOKEN_PROGRAM,
          data: { parsed: { type: "mint", info: { owner: OWNER } } },
        },
      },
    }),
  });
  assert.equal(await resolve("NotAnAta"), null);
  console.log("ok  non-token parsed account fails closed");
}

/* Parsed account data owned by another program is not an SPL token account. */
{
  const resolve = createRpcResolveOwner({
    rpcUrl: "http://rpc.invalid",
    fetchImpl: fakeFetch({
      result: {
        value: {
          owner: "11111111111111111111111111111111",
          data: { parsed: { type: "account", info: { owner: OWNER } } },
        },
      },
    }),
  });
  assert.equal(await resolve("SystemAccount"), null);
  console.log("ok  non-token program ownership fails closed");
}

/* HTTP, malformed JSON shape, and fetch failures all fail closed. */
{
  const httpFailure = createRpcResolveOwner({
    rpcUrl: "http://rpc.invalid",
    fetchImpl: fakeFetch({}, false),
  });
  const malformed = createRpcResolveOwner({
    rpcUrl: "http://rpc.invalid",
    fetchImpl: fakeFetch({ result: { value: { data: "not parsed" } } }),
  });
  const thrown = createRpcResolveOwner({
    rpcUrl: "http://rpc.invalid",
    fetchImpl: (async () => {
      throw new Error("rpc unavailable");
    }) as typeof fetch,
  });
  assert.equal(await httpFailure("SomeAta"), null);
  assert.equal(await malformed("SomeAta"), null);
  assert.equal(await thrown("SomeAta"), null);
  console.log("ok  RPC failures and malformed payloads fail closed");
}

/* Successful lookups are memoized within a worker run. */
{
  let calls = 0;
  const resolve = createRpcResolveOwner({
    rpcUrl: "http://rpc.invalid",
    cache: new Map(),
    fetchImpl: (async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          result: {
            value: {
              owner: TOKEN_PROGRAM,
              data: { parsed: { type: "account", info: { owner: OWNER } } },
            },
          },
        }),
      };
    }) as unknown as typeof fetch,
  });
  assert.equal(await resolve("SomeAta"), OWNER);
  assert.equal(await resolve("SomeAta"), OWNER);
  assert.equal(calls, 1);
  console.log("ok  resolver memoizes one ATA lookup");
}

/* A transient RPC failure must not poison that ATA until process restart. */
{
  let calls = 0;
  const resolve = createRpcResolveOwner({
    rpcUrl: "http://rpc.invalid",
    fetchImpl: (async () => {
      calls += 1;
      if (calls === 1) return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          result: {
            value: {
              owner: TOKEN_PROGRAM,
              data: { parsed: { type: "account", info: { owner: OWNER } } },
            },
          },
        }),
      };
    }) as unknown as typeof fetch,
  });
  assert.equal(await resolve("SomeAta"), null);
  assert.equal(await resolve("SomeAta"), OWNER);
  assert.equal(calls, 2);
  console.log("ok  transient resolver failure is retried");
}

console.log("resolve-owner.test.ts: all passed");
