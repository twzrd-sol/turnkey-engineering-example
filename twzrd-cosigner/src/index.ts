/**
 * twzrd-cosigner — TWZRD as a required payer-side co-signer on Solana.
 *
 * The seat: the payer creates an isolated Turnkey child organization whose
 * wallet requires a 2-of-3 root quorum (customer hot, TWZRD veto, customer
 * recovery). A pending sign request arrives as an unsigned Solana transaction;
 * TWZRD decodes the payment-shaped transfers, runs them through the
 * rail-agnostic policy brain + intel, and votes ALLOW / DENY. In that
 * topology a DENY means no signature on the normal path. This is payer-opt-in
 * and Turnkey-permissioned. The package moves no funds. TWZRD cannot sign
 * alone. Recovery credentials must never be available to the agent runtime.
 *
 * The policy brain is dependency-injected (see decide.ts `EvaluatePaymentFn`); wire it
 * to twzrd-x402-gate's `evaluateIntent` in the worker. This keeps the decode + decide
 * core fully offline-testable.
 */
export { decodeTransaction } from "./decode.js";
export {
  decidePayment,
  SOLANA_MAINNET_CAIP2,
  DEFAULT_STABLE_USD_MINTS,
  DEFAULT_MAX_PRIORITY_FEE_LAMPORTS,
  type DecideContext,
  type CosignerDecision,
  type PerTransferDecision,
  type Verdict,
} from "./decide.js";
export {
  decideTurnkeyActivity,
  type TurnkeyPendingActivity,
  type TurnkeyDecision,
  type TurnkeyDecideContext,
  type TurnkeyAction,
} from "./turnkey.js";
export {
  createStaticResolveOwner,
  createRpcResolveOwner,
  createHeliusResolveOwner,
  type ResolveOwnerFn,
  type RpcResolveOwnerOptions,
  type HeliusResolveOwnerOptions,
} from "./resolve-owner.js";
export {
  createMockTurnkeyApprover,
  type TurnkeyApprover,
  type MockTurnkeyApprover,
  type StampRecord,
  type StampResult,
} from "./approver.js";
export {
  assertGuardQuorum,
  attestTurnkeyGuard,
  type GuardQuorumAttestation,
  type TurnkeyQuorumClient,
  type QuorumUser,
} from "./quorum.js";
export {
  HOT_USERNAME,
  GUARD_USERNAME,
  RECOVERY_USERNAME,
} from "./setup-turnkey.js";
export {
  bindCosign,
  parseCosignRequest,
  MandateRefusal,
  REFUSE,
  COSIGN_FIELDS,
  type CosignRequest,
  type ObservedSpend,
} from "./mandate.js";
export {
  decisionIdForUnsignedTransaction,
  FileMandateStore,
  type MandateStore,
} from "./mandate-store.js";
export {
  createMandateServer,
  type MandateServerOptions,
} from "./mandate-server.js";
export {
  FileVetoReceiptStore,
  vetoReceiptPreimage,
  verifyVetoReceipt,
  type RecordVetoReceiptInput,
  type VetoReceipt,
} from "./receipt.js";
export {
  createTurnkeyApprover,
  type TurnkeyApproverConfig,
  type TurnkeySdkApproverClient,
} from "./turnkey-approver.js";
export {
  buildTurnkeyGuardSubOrganization,
  setupTurnkeyGuard,
  type SetupTurnkeyGuardOptions,
  type SetupTurnkeyGuardResult,
  type TurnkeyAdminClient,
} from "./setup-turnkey.js";
export {
  processPendingActivity,
  processPendingActivities,
  processPendingOnce,
  runCosignerWorker,
  type WorkerContext,
  type WorkerResult,
  type PollingWorkerContext,
  type CycleResult,
  type RunWorkerOptions,
} from "./worker.js";
export type {
  DecodedTx,
  DecodedTransfer,
  DecodedTransferKind,
  InstructionSummary,
  InstructionCategory,
  ComputeBudgetSummary,
  PaymentIntentLike,
  EvaluatePaymentFn,
  EvaluatedDecision,
  EvaluateOptions,
} from "./types.js";
export {
  createSellerIntelligence,
  describeSellerIntel,
  parseSellerIntelMode,
  type SellerIntelMode,
  type SellerIntelObservation,
  type SellerIntelligenceOptions,
} from "./intelligence.js";
