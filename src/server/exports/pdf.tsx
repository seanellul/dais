import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import type { PrintPack } from "./print-pack";

const styles = StyleSheet.create({
  page: { padding: 32, fontFamily: "Helvetica", fontSize: 9, lineHeight: 1.4, color: "#16202b" },
  card: { padding: 18, fontSize: 9 },
  eyebrow: { fontSize: 8, color: "#526171", marginBottom: 8 },
  title: { fontFamily: "Helvetica-Bold", fontSize: 22, marginBottom: 6 },
  subtitle: { fontSize: 11, marginBottom: 18 },
  row: { flexDirection: "row", borderBottom: "0.5 solid #cbd5df" },
  head: { backgroundColor: "#e9eef5", fontFamily: "Helvetica-Bold" },
  cell: { padding: 6, flexGrow: 1, flexBasis: 0 },
  notes: { marginTop: 12 },
  note: { marginBottom: 6 },
  footer: { position: "absolute", bottom: 14, left: 32, right: 32, fontSize: 7, color: "#526171" },
  qr: { width: 115, height: 115, alignSelf: "center", marginVertical: 12 },
  watermark: { color: "#8a5a00", fontSize: 8, marginBottom: 8 },
});

export async function printPackPdf(pack: PrintPack): Promise<Buffer> {
  return renderToBuffer(
    <Document title={`${pack.tournament} — ${pack.title}`} author="Dais">
      {pack.sections.map((section, index) => (
        <Page
          key={index}
          size={pack.kind === "judges" ? "A6" : "A4"}
          orientation={pack.kind === "scoresheets" ? "landscape" : "portrait"}
          style={pack.kind === "judges" ? [styles.page, styles.card] : styles.page}
        >
          <Text style={styles.eyebrow}>
            {pack.tournament} · {pack.title}
          </Text>
          {pack.practice && <Text style={styles.watermark}>DEMO / PRACTICE</Text>}
          <Text style={styles.title}>{section.title}</Text>
          {section.subtitle && <Text style={styles.subtitle}>{section.subtitle}</Text>}
          {/* React PDF's Image is a PDF object, not an HTML img element. */}
          {/* eslint-disable-next-line jsx-a11y/alt-text */}
          {section.qr && <Image src={section.qr} style={styles.qr} />}
          <View style={[styles.row, styles.head]} fixed>
            {section.columns.map((column, n) => (
              <Text key={n} style={styles.cell}>
                {column}
              </Text>
            ))}
          </View>
          {section.rows.map((row, n) => (
            <View key={n} style={styles.row} wrap={false}>
              {row.map((value, k) => (
                <Text key={k} style={styles.cell}>
                  {value}
                </Text>
              ))}
            </View>
          ))}
          <View style={styles.notes}>
            {section.notes.map((note, n) => (
              <Text key={n} style={styles.note}>
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
