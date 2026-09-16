"use client";
import { useActionState } from "react";
import { acceptInviteAction, signInAction, signUpAction } from "@/server/actions/auth";
import { Field } from "./controls";
export function AuthForm({
  mode,
  token,
  next,
}: {
  mode: "signin" | "setup" | "invite";
  token?: string;
  next?: string;
}) {
  const [state, action, pending] = useActionState(
    async (_: unknown, form: FormData) =>
      mode === "signin"
        ? signInAction(form)
        : mode === "setup"
          ? signUpAction(form)
          : acceptInviteAction(form),
    null,
  );
  return (
    <form action={action} className="org-form">
      {token && <input type="hidden" name="token" value={token} />}{" "}
      {next && <input type="hidden" name="next" value={next} />}{" "}
      {mode === "setup" && <Field name="orgName" label="Organisation name" required />}
      {mode !== "signin" && <Field name="name" label="Your name" required />}
      {mode !== "invite" && <Field name="email" type="email" label="Email address" required />}
      <Field
        name="password"
        label={mode === "invite" ? "Your existing password, or a new password" : "Password"}
        type="password"
        required
        help={mode !== "signin" ? "Use at least 12 characters." : undefined}
      />
      {state && !state.ok && (
        <div className="org-error" role="alert">
          {state.error.message}
        </div>
      )}
      <button className="org-button primary" disabled={pending}>
        {pending
          ? "Please wait…"
          : mode === "signin"
            ? "Sign in"
            : mode === "setup"
              ? "Create organisation"
              : "Accept invitation"}
      </button>
    </form>
  );
}
