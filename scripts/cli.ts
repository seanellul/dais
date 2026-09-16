/**
 * Account administration from the host's terminal: `pnpm cli <command>`.
 *
 *   users:create <email> <name> [--org <name>] [--owner]
 *   users:reset-password <email>
 *   sessions:revoke <email>
 *
 * Passwords are typed at a prompt with echo off, never passed as arguments
 * (they would land in the shell history). Loads `.env.local` then `.env`
 * like `scripts/migrate.ts`, so the same database and SESSION_SECRET are
 * used as by the app. Every change writes an audit row as the system actor.
 */
import { config as loadDotenv } from "dotenv";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

loadDotenv({ path: [".env.local", ".env"], quiet: true });

const USAGE = `Usage:
  pnpm cli users:create <email> <name> [--org <organisation>] [--owner]
  pnpm cli users:reset-password <email>
  pnpm cli sessions:revoke <email>`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  options: Record<string, string | true>;
}

/** Splits argv into the command, its positional words and `--flag [value]` options. */
function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const options: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i];
    if (!word.startsWith("--")) {
      positional.push(word);
      continue;
    }
    const name = word.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[name] = next;
      i += 1;
    } else {
      options[name] = true;
    }
  }
  return { command, positional, options };
}

/**
 * Hidden prompts. On a terminal, readline echoes keystrokes through
 * `output`, which is muted while a question is pending. When input is piped
 * (a script, a test), readline never echoes and lines may arrive before
 * they are asked for, so they are queued rather than dropped.
 */
const isTerminal = Boolean(process.stdin.isTTY);
let muted = false;
const promptOutput = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk);
    callback();
  },
});
const prompts = createInterface({
  input: process.stdin,
  output: promptOutput,
  terminal: isTerminal,
});
const bufferedLines: string[] = [];
const waiting: Array<(line: string | undefined) => void> = [];
let inputClosed = false;

prompts.on("line", (line) => {
  const next = waiting.shift();
  if (next) next(line);
  else bufferedLines.push(line);
});
prompts.on("close", () => {
  inputClosed = true;
  for (const next of waiting.splice(0)) next(undefined);
});

/** Asks a question and reads the answer with echo off. Rejects at end of input. */
function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  muted = true;
  return new Promise((resolve, reject) => {
    const answer = (line: string | undefined) => {
      muted = false;
      process.stdout.write("\n");
      if (line === undefined) reject(new Error("No password was entered."));
      else resolve(line);
    };
    const buffered = bufferedLines.shift();
    if (buffered !== undefined) answer(buffered);
    else if (inputClosed) answer(undefined);
    else waiting.push(answer);
  });
}

/** Asks for a password twice and refuses when the two differ. */
async function promptNewPassword(): Promise<string> {
  const first = await promptHidden("New password: ");
  const second = await promptHidden("Type it again: ");
  if (first !== second) throw new Error("The two passwords differ. Nothing was changed.");
  return first;
}

function require(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing ${what}.\n${USAGE}`);
  return value;
}

async function main(): Promise<void> {
  const { command, positional, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }

  // Imported after dotenv so the validated env sees the file's values.
  const { closeDb, getDb } = await import("../src/server/db/client");
  const { SYSTEM_ACTOR, createContext, withTransaction } = await import("../src/server/services");
  const { createUserByCli, resetPasswordByCli, signOutEverywhere } =
    await import("../src/server/services/users");
  const { findUserByEmail } = await import("../src/server/auth/tokens");
  const { passwordIssue } = await import("../src/server/auth/password");

  const ctx = createContext({
    db: await getDb(),
    actor: { ...SYSTEM_ACTOR, id: "cli", name: "Command line" },
  });

  try {
    switch (command) {
      case "users:create": {
        const email = require(positional[0], "<email>");
        const name = require(positional[1], "<name>");
        const orgName = typeof options.org === "string" ? options.org : undefined;
        const password = await promptNewPassword();
        const issue = passwordIssue(password);
        if (issue) throw new Error(issue);
        const created = await withTransaction(ctx, (tx) =>
          createUserByCli(tx, ctx, {
            email,
            name,
            password,
            orgName,
            owner: options.owner === true,
          }),
        );
        console.log(`Created ${created.user.email} (${created.user.name}).`);
        if (created.organisation && created.membership) {
          console.log(`Member of ${created.organisation.name} as ${created.membership.role}.`);
        } else {
          console.log("Not a member of any organisation yet; run again with --org to add one.");
        }
        return;
      }
      case "users:reset-password": {
        const email = require(positional[0], "<email>");
        const password = await promptNewPassword();
        const user = await withTransaction(ctx, (tx) =>
          resetPasswordByCli(tx, ctx, email, password),
        );
        console.log(`Password reset for ${user.email}. Every device was signed out.`);
        return;
      }
      case "sessions:revoke": {
        const email = require(positional[0], "<email>");
        const user = await findUserByEmail(ctx.db, email);
        if (!user) throw new Error(`No account has the email ${email}.`);
        const count = await withTransaction(ctx, (tx) =>
          signOutEverywhere(tx, ctx, user.id, "signed out from the command line"),
        );
        console.log(`Signed ${user.email} out of ${count} ${count === 1 ? "device" : "devices"}.`);
        return;
      }
      default:
        throw new Error(`Unknown command "${command}".\n${USAGE}`);
    }
  } finally {
    await closeDb();
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prompts.close());
