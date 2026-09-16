import { NextRequest } from "next/server";
import { csvText } from "@/domain/export";
import { actorForUser, requireViewer } from "@/server/auth/guards";
import { getDb } from "@/server/db";
import { errors } from "@/server/errors";
import { CSV_FORMATS, csvExport, exportFilename, type CsvFormat } from "@/server/exports/data";
import { buildPrintPack, PRINT_KINDS, type PrintKind } from "@/server/exports/print-pack";
import { httpError } from "@/server/http";
import { exportBackup } from "@/server/services/backup";
import { createContext } from "@/server/services/context";
import { loadGraph } from "@/server/services/graph";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; format: string }> },
) {
  try {
    const { id, format } = await params;
    const access = await requireViewer(id);
    const db = await getDb();
    const division = request.nextUrl.searchParams.get("division") || undefined;
    const graph = await loadGraph(db, id);
    let body: string | Uint8Array;
    let extension: string;
    let type: string;
    if (CSV_FORMATS.includes(format as CsvFormat)) {
      const spec = csvExport(graph, format as CsvFormat, division);
      body = "\uFEFF" + csvText(spec.headers, spec.rows);
      extension = "csv";
      type = "text/csv; charset=utf-8";
    } else if (format === "backup") {
      if (access.membership.role !== "owner") throw errors.forbidden();
      const ctx = createContext({ db, actor: actorForUser(access.user) });
      body = JSON.stringify(await exportBackup(ctx, id), null, 2);
      extension = "json";
      type = "application/json";
    } else if (format === "workbook") {
      const { buildWorkbook } = await import("@/server/exports/workbook");
      body = new Uint8Array(await buildWorkbook(graph, division));
      extension = "xlsx";
      type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else if (format.startsWith("pdf-") && PRINT_KINDS.includes(format.slice(4) as PrintKind)) {
      const kind = format.slice(4) as PrintKind;
      if (kind === "judges" && access.membership.role !== "owner") throw errors.forbidden();
      const { printPackPdf } = await import("@/server/exports/pdf");
      body = new Uint8Array(await printPackPdf(await buildPrintPack(graph, kind, division)));
      extension = "pdf";
      type = "application/pdf";
    } else throw errors.notFound("That export");
    return new Response(body as BodyInit, {
      headers: {
        "Content-Type": type,
        "Content-Disposition": `attachment; filename="${exportFilename(graph.tournament.slug, format, extension)}"`,
        "Cache-Control": "private, no-store",
        "X-Dais": "1",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return httpError(error, request.headers);
  }
}
