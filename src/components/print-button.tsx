"use client";

export function PrintButton() {
  return (
    <button
      type="button"
      className="min-h-12 rounded-lg bg-primary px-5 py-3 text-primary-foreground"
      onClick={() => window.print()}
    >
      Print / save as PDF
    </button>
  );
}
