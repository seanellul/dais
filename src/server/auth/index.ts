/**
 * The auth layer, minus the request guards. `guards.ts` reads Next's
 * `cookies()` and is imported directly by the code that runs inside a
 * request; everything here works on a plain database handle, in tests and
 * in the CLI alike.
 */
export {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  SCRYPT_PARAMS,
  dummyPasswordHash,
  hashPassword,
  parseStoredHash,
  passwordIssue,
  verifyPassword,
} from "./password";

export {
  ORGANISER_COOKIE,
  SESSION_SLIDE_INTERVAL_MS,
  SESSION_TTL_MS,
  clearSessionCookie,
  createUserSession,
  expiryFrom,
  isSessionLive,
  newSessionToken,
  resolveUserSession,
  revokeAllUserSessions,
  revokeSession,
  sessionCookieOptions,
  setSessionCookie,
  slideSession,
  type CookieOptions,
  type CookieStore,
  type IssuedSession,
  type ResolvedUserSession,
  type SessionMeta,
} from "./session";

export {
  JUDGE_COOKIE,
  clearJudgeCookie,
  createJudgeSession,
  resolveJudgeSession,
  revokeJudgeSessions,
  setJudgeCookie,
  type ResolvedJudgeSession,
} from "./judge-session";

export {
  INVITE_TTL_DAYS,
  acceptInvite,
  createInvite,
  createUser,
  ensureMembership,
  findLiveInvite,
  findUserByEmail,
  inviteLinkFor,
  issueJoinToken,
  joinLinkFor,
  joinTokenFor,
  joinTokenHashFor,
  normaliseEmail,
  verifyJoinToken,
  type AcceptInviteInput as AcceptInviteServiceInput,
  type AcceptedInvite,
  type CreateInviteInput as CreateInviteServiceInput,
  type IssuedInvite,
} from "./tokens";

export {
  RATE_LIMITS,
  assertAllowed,
  enforce,
  enforceAll,
  rateLimitKey,
  secondsUntilWindowEnds,
  sweep,
  take,
  takeAll,
  windowKey,
  type RateLimitCheck,
  type RateLimitDecision,
  type RateLimitPolicy,
} from "./rate-limit";

export { AUTH_AUDIT_ACTIONS, recordAuthAudit, type AuthAuditAction } from "./audit-actions";

export { clientIpOf, ipHashOf, userAgentOf } from "./request-meta";

export {
  acceptInviteSchema,
  createInviteSchema,
  fromFormData,
  parseInput,
  signInSchema,
  signUpSchema,
  type AcceptInviteInput,
  type ActionInput,
  type CreateInviteInput,
  type SignInInput,
  type SignUpInput,
} from "./forms";
