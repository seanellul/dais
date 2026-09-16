"use client";
import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { tournamentCommandAction } from "@/server/actions/tournament";
import type { OrganiserData } from "@/server/organiser-queries";
export type Data = OrganiserData;
export function useCommand(tournamentId: string) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const execute = (action: string, data: unknown, onSuccess?: (data: unknown) => void) =>
    start(async () => {
      setError(null);
      setNotice(null);
      try {
        const result = await tournamentCommandAction({ action, tournamentId, data });
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setNotice("Saved to the tournament.");
        onSuccess?.(result.data.data);
        router.refresh();
      } catch {
        setError(
          "The connection was interrupted. Try again; the tournament will check the latest version.",
        );
      }
    });
  return {
    execute,
    pending,
    feedback: (
      <>
        <div aria-live="assertive">
          {error && (
            <div className="org-error" role="alert" tabIndex={-1}>
              {error}
            </div>
          )}
        </div>
        <div aria-live="polite">{notice && <div className="org-success">{notice}</div>}</div>
      </>
    ),
  };
}
export type Command = ReturnType<typeof useCommand>;
export function Field({
  label,
  name,
  type = "text",
  value,
  required = false,
  min,
  max,
  children,
  help,
}: {
  label: string;
  name: string;
  type?: string;
  value?: string | number;
  required?: boolean;
  min?: number;
  max?: number;
  children?: React.ReactNode;
  help?: string;
}) {
  const id = useId();
  return (
    <label className="org-field" htmlFor={id}>
      <span id={`${id}-label`}>{label}</span>
      {children ? (
        <select
          id={id}
          aria-labelledby={`${id}-label`}
          aria-describedby={help ? `${id}-help` : undefined}
          name={name}
          defaultValue={value}
          required={required}
        >
          {children}
        </select>
      ) : type === "textarea" ? (
        <textarea
          id={id}
          aria-labelledby={`${id}-label`}
          aria-describedby={help ? `${id}-help` : undefined}
          name={name}
          defaultValue={value}
          required={required}
        />
      ) : (
        <input
          id={id}
          aria-labelledby={`${id}-label`}
          aria-describedby={help ? `${id}-help` : undefined}
          name={name}
          type={type}
          step={type === "number" ? "any" : undefined}
          defaultValue={value}
          required={required}
          min={min}
          max={max}
        />
      )}{" "}
      {help && (
        <span id={`${id}-help`} className="org-muted">
          {help}
        </span>
      )}
    </label>
  );
}
export function Check({
  label,
  name,
  checked = false,
}: {
  label: string;
  name: string;
  checked?: boolean;
}) {
  return (
    <label className="org-check">
      <input type="checkbox" name={name} defaultChecked={checked} />
      {label}
    </label>
  );
}
export function ActionForm({
  command,
  action,
  make,
  label = "Save",
  children,
  primary = false,
  onSuccess,
}: {
  command: Command;
  action: string;
  make: (form: FormData) => unknown;
  label?: string;
  children?: React.ReactNode;
  primary?: boolean;
  onSuccess?: (data: unknown) => void;
}) {
  return (
    <form
      className="org-form"
      onSubmit={(e) => {
        e.preventDefault();
        command.execute(action, make(new FormData(e.currentTarget)), onSuccess);
      }}
    >
      {children}
      <div>
        <button className={`org-button ${primary ? "primary" : ""}`} disabled={command.pending}>
          {command.pending ? "Saving…" : label}
        </button>
      </div>
    </form>
  );
}
export const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
export const number = (f: FormData, k: string) => Number(text(f, k));
export function Reason() {
  return <Field name="reason" label="Reason kept in the history" type="textarea" required />;
}
export function Table({
  caption,
  heads,
  children,
}: {
  caption: string;
  heads: string[];
  children: React.ReactNode;
}) {
  return (
    <div className="org-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="org-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
export function human(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(human).join(", ");
  if (typeof value === "object")
    return Object.entries(value)
      .map(([k, v]) => `${k.replace(/([A-Z])/g, " $1").replaceAll("_", " ")}: ${human(v)}`)
      .join(" · ");
  return "—";
}
export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function date(value: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
