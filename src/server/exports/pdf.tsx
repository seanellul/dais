import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { PrintPack } from "./print-pack";

const styles = StyleSheet.create({
  // Keep line heights on leaf text: inherited page lineHeight collapses dynamic
  // page-number text during React PDF's second layout pass.
  page: { padding: 32, fontFamily: "Helvetica", fontSize: 9, color: "#16202b" },
  card: { padding: 14, paddingBottom: 30, fontSize: 8 },
  scoresheet: { padding: 24, paddingBottom: 36 },
  eyebrow: { fontSize: 8, color: "#526171", marginBottom: 8 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 22, lineHeight: 1.15, marginBottom: 10 },
  subtitle: { fontSize: 11, lineHeight: 1.3, marginBottom: 14 },
  scoreTitle: { fontSize: 18, lineHeight: 1.2, marginBottom: 8 },
  scoreSubtitle: { fontSize: 10, lineHeight: 1.2, marginBottom: 10 },
  row: { flexDirection: "row", borderBottom: "0.5 solid #cbd5df" },
  head: { backgroundColor: "#e9eef5", fontFamily: "Helvetica-Bold" },
  cell: { padding: 6, flexGrow: 1, flexBasis: 0 },
  notes: { marginTop: 12 },
  note: { marginBottom: 6, lineHeight: 1.25 },
  cardNotes: { marginTop: 6 },
  cardNote: { fontSize: 7.5, lineHeight: 1.2, marginBottom: 4 },
  scoreNote: { fontSize: 8, lineHeight: 1.15, marginBottom: 3 },
  footer: { position: "absolute", bottom: 14, left: 14, right: 14, fontSize: 7, color: "#526171" },
  qr: { width: 92, height: 92, alignSelf: "center", marginVertical: 8 },
  cardCell: { padding: 4 },
  scoreCell: { padding: 5 },
  watermark: { color: "#8a5a00", fontSize: 8, marginBottom: 8 },
});

export async function printPackPdf(pack: PrintPack): Promise<Buffer> {
  const isCard = pack.kind === "judges";
  const isScoresheet = pack.kind === "scoresheets";
  const cellStyle = isCard
    ? [styles.cell, styles.cardCell]
    : isScoresheet
      ? [styles.cell, styles.scoreCell]
      : styles.cell;
  return renderToBuffer(
    <Document title={`${pack.tournament} — ${pack.title}`} author="Dais">
      {pack.sections.map((section, index) => (
        <Page
          key={index}
          size={pack.kind === "judges" ? "A6" : "A4"}
          orientation={pack.kind === "scoresheets" ? "landscape" : "portrait"}
          style={
            isCard
              ? [styles.page, styles.card]
              : isScoresheet
                ? [styles.page, styles.scoresheet]
                : styles.page
          }
        >
          <Text style={styles.eyebrow}>
            {pack.tournament} · {pack.title}
          </Text>
          {pack.practice && <Text style={styles.watermark}>DEMO / PRACTICE</Text>}
          <Text style={isScoresheet ? [styles.title, styles.scoreTitle] : styles.title}>
            {section.title}
          </Text>
          {section.subtitle && (
            <Text style={isScoresheet ? styles.scoreSubtitle : styles.subtitle}>
              {section.subtitle}
            </Text>
          )}
          {/* React PDF's Image is a PDF object, not an HTML img element. */}
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          {section.qr && <Image src={section.qr} style={styles.qr} />}
          <View style={[styles.row, styles.head]} fixed>
            {section.columns.map((column, n) => (
              <Text key={n} style={cellStyle}>
                {column}
              </Text>
            ))}
          </View>
          {section.rows.map((row, n) => (
            <View key={n} style={styles.row} wrap={false}>
              {row.map((value, k) => (
                <Text key={k} style={cellStyle}>
                  {value}
                </Text>
              ))}
            </View>
          ))}
          <View style={pack.kind === "judges" ? styles.cardNotes : styles.notes}>
            {section.notes.map((note, n) => (
              <Text
                key={n}
                style={isCard ? styles.cardNote : isScoresheet ? styles.scoreNote : styles.note}
              >
                {note}
              </Text>
            ))}
          </View>
          <Text
            style={styles.footer}
            fixed
            render={({ pageNumber, totalPages }) =>
              `${pack.practice ? "DEMO / PRACTICE · " : ""}${pack.generatedAt.slice(0, 10)} · ${pageNumber} / ${totalPages}`
            }
          />
        </Page>
      ))}
      {!pack.sections.length && (
        <Page size="A4" style={styles.page}>
          <Text>No records to print yet.</Text>
        </Page>
      )}
    </Document>,
  );
}
