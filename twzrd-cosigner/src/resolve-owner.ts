/**
 * ATA → owner resolvers for decidePayment.
 *
 * SPL TransferChecked destinations are token accounts, not wallets. Policy
 * blocklists/allowlists are wallet-level, so the co-signer needs this hop.
 * Offline tests use a static map; production wires Helius (or any RPC).
 */

export type ResolveOwnerFn = (
  tokenAccount: string,
) => Promise<string | null> | string | null;

/** Offline / dry-run: fixed ATA → owner table. Missing keys → null (fail closed). */
export function createStaticResolveOwner(
  map: Record<string, string>,
): ResolveOwnerFn {
  return (tokenAccount: string) => map[tokenAccount] ?? null;
}

export type HeliusResolveOwnerOptions = {
  apiKey: string;
  /** Default mainnet Helius RPC. */
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  cache?: Map<string, string>;
};

export type RpcResolveOwnerOptions = {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
  cache?: Map<string, string>;
};

const TOKEN_PROGRAMS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

type JsonParsedAccountInfo = {
  result?: {
    value?: {
      owner?: unknown;
      data?: {
        parsed?: {
          type?: string;
          info?: { owner?: unknown };
        };
      };
    };
  };
};

/**
 * Live resolver via any Solana JSON-RPC getAccountInfo endpoint.
 * Only a parsed token-account payload may provide an owner. Every other
 * response, including mints and network errors, resolves to null.
 */
export function createRpcResolveOwner(
  opts: RpcResolveOwnerOptions,
): ResolveOwnerFn {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cache = opts.cache;

  return async (tokenAccount: string) => {
    if (cache?.has(tokenAccount)) return cache.get(tokenAccount) ?? null;

    let owner: string | null = null;
    try {
      const res = await fetchImpl(opts.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getAccountInfo",
          params: [tokenAccount, { encoding: "jsonParsed" }],
        }),
      });
      if (res.ok) {
        const payload = (await res.json()) as JsonParsedAccountInfo;
        const account = payload.result?.value;
        const parsed = account?.data?.parsed;
        if (
          typeof account?.owner === "string" &&
          TOKEN_PROGRAMS.has(account.owner) &&
          parsed?.type === "account" &&
          typeof parsed.info?.owner === "string"
        ) {
          owner = parsed.info.owner;
        }
      }
    } catch {
      // Fail closed below.
    }

    // Cache only authoritative owners when the caller explicitly supplies a
    // cache. A transient RPC failure fails this decision without poisoning a
    // future attempt.
    if (owner !== null) cache?.set(tokenAccount, owner);
    return owner;
  };
}

/**
 * Live resolver via Helius JSON-RPC getAccountInfo (jsonParsed).
 * Returns null on missing key, HTTP failure, or non-token account — fail closed.
 */
export function createHeliusResolveOwner(
  opts: HeliusResolveOwnerOptions,
): ResolveOwnerFn {
  if (!opts.apiKey) return () => null;
  return createRpcResolveOwner({
    rpcUrl:
      opts.rpcUrl ?? `https://mainnet.helius-rpc.com/?api-key=${opts.apiKey}`,
    fetchImpl: opts.fetchImpl,
    cache: opts.cache,
  });
}
