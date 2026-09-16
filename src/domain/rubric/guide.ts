/**
 * The Guide to Judging as structured data: what each band looks like in
 * each speech category, the reminders judges see on their sheet, and the
 * penalties the guide allows.
 *
 * The text is a faithful summary of the guide, not a quotation. Keep it in
 * the guide's own words where possible so judges recognise it.
 */

export type SpeechCategory = "argumentation" | "rebuttal" | "presentation";
export type GuideBandLabel = "Excellent" | "Very good" | "Competent" | "Fair" | "Ineffective";

export const SPEECH_CATEGORIES: SpeechCategory[] = ["argumentation", "rebuttal", "presentation"];
export const GUIDE_BAND_LABELS: GuideBandLabel[] = [
  "Excellent",
  "Very good",
  "Competent",
  "Fair",
  "Ineffective",
];

export interface GuideEntry {
  category: SpeechCategory;
  band: GuideBandLabel;
  /** Short points, in the order the guide lists them. */
  points: string[];
}

export const GUIDE_TEXT: GuideEntry[] = [
  {
    category: "argumentation",
    band: "Excellent",
    points: [
      "Insightful, creative and relevant arguments",
      "Well developed and well researched",
      "Logical and easy to follow",
      "Excellent synthesis with partner",
    ],
  },
  {
    category: "argumentation",
    band: "Very good",
    points: [
      "Relevant arguments in a logical, organised manner",
      "Good research; understood most of the issues",
      "Arguments supported and well reasoned",
    ],
  },
  {
    category: "argumentation",
    band: "Competent",
    points: [
      "Acceptable organisation and logic",
      "Some points supported, others merely asserted",
      "Attempted coordination with partner",
    ],
  },
  {
    category: "argumentation",
    band: "Fair",
    points: [
      "Basic or weak understanding of the issues",
      "Significant logical gaps",
      "Teamwork not sufficient",
    ],
  },
  {
    category: "argumentation",
    band: "Ineffective",
    points: [
      "Little evidence or structure",
      "Little understanding of the issues",
      "Little coordination with partner",
    ],
  },
  {
    category: "rebuttal",
    band: "Excellent",
    points: ["All of the opponents' key arguments demolished", "Own case rebuilt completely"],
  },
  {
    category: "rebuttal",
    band: "Very good",
    points: ["Refuted the key arguments adequately", "Own case mainly rebuilt"],
  },
  {
    category: "rebuttal",
    band: "Competent",
    points: [
      "Identified some of the issues but did not counter-attack sufficiently",
      "Own case only half rebuilt",
    ],
  },
  {
    category: "rebuttal",
    band: "Fair",
    points: ["Poor or ineffective rebuttal", "No anticipation of the other side's case"],
  },
  {
    category: "rebuttal",
    band: "Ineffective",
    points: ["No rebuttal", "A debater who attempts no rebuttal scores 13"],
  },
  {
    category: "presentation",
    band: "Excellent",
    points: [
      "Excellent style, clarity and polish",
      "Rhetorical devices; variation in volume, pitch and pace",
      "Complete eye contact",
      "Riveting",
    ],
  },
  {
    category: "presentation",
    band: "Very good",
    points: [
      "Kept you interested; good eye contact",
      "Filled nearly all of the time",
      "Solid, not riveting",
    ],
  },
  {
    category: "presentation",
    band: "Competent",
    points: [
      "Easy to listen to but relied on notes",
      "Some gaps or timing problems",
      "A lot of monotone",
    ],
  },
  {
    category: "presentation",
    band: "Fair",
    points: [
      "Delivery flaws in pace, tone or diction",
      "Much reliance on notes",
      "Poor eye contact",
    ],
  },
  {
    category: "presentation",
    band: "Ineffective",
    points: ["Uncomfortable to watch", "Mumbles or reads", "Complete breakdown"],
  },
];

/** The guide's points for one category in one band, or null if unknown. */
export function guideEntry(category: SpeechCategory, band: string): GuideEntry | null {
  return GUIDE_TEXT.find((entry) => entry.category === category && entry.band === band) ?? null;
}

/** The guide's entries for one category, best band first. */
export function guideForCategory(category: SpeechCategory): GuideEntry[] {
  return GUIDE_TEXT.filter((entry) => entry.category === category);
}

/** Reminders shown on the judge's sheet and in the judge help page. */
export const JUDGE_REMINDERS: string[] = [
  "Wait for the Prime Minister's reply before you score the Prime Minister.",
  "Give two positives and two improvements for every debater.",
  "Do not announce a winner. Preliminary rankings use points, not wins.",
];

/** Shown beside the Overall score field. */
export const RARE_HIGH_SCORE_NOTE =
  "Scores above 90 are very rare, about 1 to 2 debaters in a tournament.";

export interface GuidePenalty {
  /** What the penalty is for. */
  reason: string;
  /** Points to take off, as an inclusive range. */
  min: number;
  max: number;
}

export const GUIDE_PENALTIES: GuidePenalty[] = [
  { reason: "Going 3 to 5 sentences over time", min: 2, max: 3 },
  { reason: "New arguments in the Prime Minister's reply", min: 1, max: 5 },
];
