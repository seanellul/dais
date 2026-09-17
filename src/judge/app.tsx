"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ChevronRight, HelpCircle, Wifi, WifiOff } from "lucide-react";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import {
  actualSide,
  categoryBandFor,
  GUIDE_TEXT,
  ROLE_KEYS,
  roleFor,
  roleLabel,
  speakingOrder,
} from "@/domain/rubric";
import { completeness, feedbackGaps, parseSheetPayload, SCORE_FIELDS } from "@/domain/sheet";
import type { SheetPayload } from "@/domain/types";
import type { JudgeAssignment, JudgeBootstrap } from "@/judge/api-types";
import {
  ActionButton,
  AppSettings,
  BandBar,
  NumberField,
  OverallField,
  PageHeader,
  RoleTag,
  SegmentedControl,
  SideTag,
  StatusChip,
  StickyActionBar,
} from "@/ui";
import { api, JudgeApiError } from "./api";
import { encodeHandoff, handoffComments } from "./handoff";
import { JudgeStore, StoreError, type DraftPatch, type LocalDraft, type Workspace } from "./store";
import { JudgeSync } from "./sync";
import { useJudgePwa } from "./use-pwa";
import { withBlankFeedback } from "./store/feedback";
import "./judge.css";

type View = "join" | "home" | "before" | "score" | "review" | "receipt" | "handoff" | "help";
const time = (value: string) =>
  new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const stateLabel = {
  queued: "Waiting to send",
  sending: "Sending",
  received: "Received",
  conflict: "Under organiser review",
  stale: "The draw changed",
  attention: "Needs attention",
  auth: "Sign in to send",
};
const quiet = "judge-button";

export function JudgeApp() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [view, setView] = useState<View>("join");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LocalDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState("Saved on this phone");
  const [discarded, setDiscarded] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const [tournamentCode, setTournamentCode] = useState("");
  const [judgeCode, setJudgeCode] = useState("");
  const store = useRef<JudgeStore | null>(null);
  const sync = useRef<JudgeSync | null>(null);
  const persisted = useRef<LocalDraft | null>(null);
  const pending = useRef(Promise.resolve());
  const pendingCount = useRef(0);
  const saveFailed = useRef(false);
  const pwa = useJudgePwa();
  const key = workspace?.key;
  const row = workspace?.bootstrap.assignments.find((row) => row.id === selectedId);
  const item =
    workspace && Object.values(workspace.outbox).find((item) => item.assignmentId === selectedId);
  const receipt = selectedId ? workspace?.receipts[selectedId] : undefined;
  const rubric = workspace?.bootstrap.tournament.rubric ?? DEFAULT_SETTINGS.rubric;
  const timings = workspace?.bootstrap.tournament.timings ?? DEFAULT_SETTINGS.timings;
  const labels = workspace?.bootstrap.tournament.roles ?? DEFAULT_SETTINGS.roles;
  const reload = useCallback(async () => {
    const saved = await store.current?.active();
    if (saved) setWorkspace(saved);
  }, []);

  useEffect(() => {
    let disposed = false;
    const db = new JudgeStore();
    store.current = db;
    const params = new URLSearchParams(location.search);
    const token = params.get("t") || params.get("token");
    (async () => {
      const cached = await db.active();
      if (disposed) return;
      if (cached) {
        setWorkspace(cached);
        if (!token) setView("home");
      }
      try {
        if (token) {
          await api("/api/judge/join", { token });
          if (disposed) return;
          // Remove the card secret only once its session cookie is established.
          // A reload during sign-in must be able to retry the same join link.
          history.replaceState(null, "", "/j/");
        }
        const bootstrap = await api<JudgeBootstrap>("/api/judge/me");
        if (disposed) return;
        const downloaded = await db.download(bootstrap);
        if (!disposed) {
          setWorkspace(downloaded);
          setView("home");
        }
      } catch (error) {
        if (
          !disposed &&
          error instanceof JudgeApiError &&
          (token || error.error.code !== "unauthenticated")
        )
          setNotice(error.message);
      } finally {
        if (!disposed) setLoading(false);
      }
    })().catch((error) => {
      if (!disposed) {
        setLoading(false);
        setNotice(
          error instanceof Error
            ? error.message
            : "This phone cannot save sheets. Use another device or ask for a paper sheet.",
        );
      }
    });
    return () => {
      disposed = true;
      void db.close();
    };
  }, []);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  useEffect(() => {
    if (!key || !store.current) return;
    const engine = new JudgeSync(
      store.current,
      key,
      () => {
        void reload();
      },
      setNotice,
    );
    sync.current = engine;
    void engine.flush();
    const interval = setInterval(() => {
      void engine.flush();
    }, 15_000);
    const connected = () => {
      void engine.flush();
    };
    const visible = () => {
      if (document.visibilityState === "visible") void engine.flush();
    };
    window.addEventListener("online", connected);
    document.addEventListener("visibilitychange", visible);
    return () => {
      engine.close();
      clearInterval(interval);
      window.removeEventListener("online", connected);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [key, reload]);
  useEffect(() => {
    document.getElementById("page-title")?.focus();
    window.scrollTo(0, 0);
  }, [view, selectedId]);
  const go = (next: View) => {
    setNotice(null);
    setView(next);
  };
  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setNotice(null);
    try {
      await pending.current;
      if (saveFailed.current)
        throw new StoreError(
          "storage",
          "Some changes could not be saved. Keep this screen open and copy your sheet to the organiser.",
        );
      await operation();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "This action could not finish. Your saved sheets are still on this phone.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function open(assignment: JudgeAssignment) {
    if (!store.current || !key) return;
    setSelectedId(assignment.id);
    setHandoffId(null);
    setQr(null);
    saveFailed.current = false;
    const pending = Object.values(workspace!.outbox).some(
      (item) => item.assignmentId === assignment.id,
    );
    if (
      pending ||
      (assignment.current && !workspace!.drafts[assignment.id]) ||
      assignment.retiredAt
    ) {
      setDraft(workspace!.drafts[assignment.id] ?? null);
      persisted.current = workspace!.drafts[assignment.id] ?? null;
      go("receipt");
      return;
    }
    const saved = await store.current.draft(key, assignment.id);
    persisted.current = saved;
    setDraft(saved);
    go(saved.beforeConfirmed ? "score" : "before");
    await reload();
  }
  function patch(change: DraftPatch) {
    if (!key || !selectedId || !store.current || !persisted.current) return;
    const activeKey = key,
      id = selectedId;
    pendingCount.current++;
    setSaved("Saving…");
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      if ("speakerId" in change) {
        const score = next.payload.scores[change.speakerId] ?? {};
        if (change.value === null) delete score[change.field];
        else Object.assign(score, { [change.field]: change.value });
        next.payload.scores[change.speakerId] = score;
      } else if ("sideFlipped" in change) {
        next.payload.sideFlipped = change.sideFlipped;
        next.beforeConfirmed = false;
      } else {
        next.payload.roleSwaps[change.teamId] = change.swapped;
        next.beforeConfirmed = false;
      }
      next.requestId = crypto.randomUUID();
      next.reviewed = false;
      return next;
    });
    pending.current = pending.current.then(async () => {
      try {
        const savedDraft = await store.current!.patch(
          activeKey,
          id,
          persisted.current!.revision,
          change,
        );
        persisted.current = savedDraft;
        pendingCount.current--;
        if (pendingCount.current === 0) {
          setDraft(savedDraft);
          setSaved("Saved on this phone");
        }
        sync.current?.broadcast();
      } catch (error) {
        pendingCount.current--;
        saveFailed.current = true;
        setSaved("Could not save");
        setNotice(
          error instanceof Error
            ? error.message
            : "This phone could not save. Keep the screen open.",
        );
      }
    });
  }
  const people =
    row?.display.speakers
      .map((speaker) => ({
        ...speaker,
        actual: actualSide(
          speaker.side,
          draft?.payload.sideFlipped ?? row.current?.payload.sideFlipped ?? false,
        ),
        role: roleFor(
          actualSide(
            speaker.side,
            draft?.payload.sideFlipped ?? row.current?.payload.sideFlipped ?? false,
          ),
          speaker.position,
          draft?.payload.roleSwaps[speaker.teamId] ??
            row.current?.payload.roleSwaps[speaker.teamId] ??
            false,
        ),
      }))
      .sort((a, b) => ROLE_KEYS.indexOf(a.role) - ROLE_KEYS.indexOf(b.role)) ?? [];
  const progress =
    draft && row
      ? completeness(
          draft.payload,
          row.identity.speakers.map((speaker) => speaker.id),
        )
      : null;
  const payload =
    item?.payload ??
    (draft && row
      ? parseSheetPayload(withBlankFeedback(draft.payload), {
          rubric,
          speakerIds: row.identity.speakers.map((speaker) => speaker.id),
          teamIds: [row.identity.governmentTeamId, row.identity.oppositionTeamId],
        })
      : null);
  const completed: SheetPayload | null =
    payload && "ok" in payload
      ? payload.ok
        ? payload.data
        : null
      : (payload as SheetPayload | null);
  const handoff =
    completed && row && workspace && (item?.requestId || draft?.requestId || handoffId)
      ? encodeHandoff({
          assignmentId: row.id,
          judgeId: workspace.bootstrap.judge.id,
          requestId: item?.requestId ?? draft?.requestId ?? handoffId!,
          baseVersion: item?.baseVersion ?? draft?.baseVersion ?? row.current?.version ?? 0,
          payload: completed,
        })
      : null;
  useEffect(() => {
    let active = true;
    if (view === "handoff" && handoff?.text)
      QRCode.toDataURL(handoff.text, { width: 280, margin: 2, errorCorrectionLevel: "M" })
        .then((url) => {
          if (active) setQr(url);
        })
        .catch(() => {
          if (active) setQr(null);
        });
    return () => {
      active = false;
    };
  }, [view, handoff?.text]);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied. Share it with the organiser.");
    } catch {
      setNotice("Select and copy the text below, then give it to the organiser.");
    }
  };
  const content = (children: React.ReactNode) => <div className="judge-content">{children}</div>;
  const title = (text: string, sub?: string) => (
    <PageHeader title={text} subtitle={sub} eyebrow={workspace?.bootstrap.tournament.name} />
  );
  const homeButton = (
    <button className={quiet} onClick={() => go(workspace ? "home" : "join")}>
      <ArrowLeft aria-hidden="true" size={18} />
      Home
    </button>
  );
  const beginHandoff = () => {
    setHandoffId(item?.requestId ?? draft?.requestId ?? handoffId ?? crypto.randomUUID());
    go("handoff");
  };

  return (
    <div className="judge-app">
      <header className="judge-topbar">
        <Link
          href="/"
          aria-label="Back to Dais home"
          className="flex min-h-11 flex-col justify-center font-display text-h3 text-inherit"
        >
          Dais <span className="text-body-sm font-sans">Judge sheets</span>
        </Link>
        <div className="flex items-center gap-1">
          <button className="judge-icon" aria-label="Help and rubric" onClick={() => go("help")}>
            <HelpCircle aria-hidden="true" size={22} />
          </button>
          <AppSettings className="text-inherit">
            <InstallHelp pwa={pwa} />
            {pwa.waiting ? (
              <div className="space-y-3">
                <p className="text-body-sm">
                  An update is available. Send or keep aside waiting sheets before updating.
                </p>
                <button
                  className={quiet}
                  disabled={
                    busy || loading || (!!workspace && Object.keys(workspace.outbox).length > 0)
                  }
                  onClick={() =>
                    void perform(async () => {
                      const latest = await store.current?.active();
                      if (latest && Object.keys(latest.outbox).length)
                        throw new Error("Send or keep aside your waiting sheets first.");
                      pwa.activate();
                    })
                  }
                >
                  Update app
                </button>
              </div>
            ) : null}
          </AppSettings>
        </div>
      </header>
      {workspace ? (
        <div className="judge-connection" role="status">
          {online ? (
            <Wifi aria-hidden="true" size={16} />
          ) : (
            <WifiOff aria-hidden="true" size={16} />
          )}
          <span>
            {online ? "Connection available" : "Without signal · your work stays on this phone"}
          </span>
        </div>
      ) : null}
      {notice ? (
        <div className="judge-notice" role="status">
          <p>{notice}</p>
          {saved === "Could not save" && row ? (
            <button
              className={quiet}
              onClick={() => {
                saveFailed.current = false;
                void perform(async () => {
                  await reload();
                  await open(row);
                });
              }}
            >
              Reopen saved version
            </button>
          ) : null}
          {saved === "Could not save" && completed ? (
            <button className={quiet} onClick={beginHandoff}>
              Hand off visible scores
            </button>
          ) : null}
          {workspace && saved !== "Could not save" ? (
            <button className={quiet} onClick={() => go("help")}>
              Sign-in and connection help
            </button>
          ) : null}
          <button
            className="judge-icon"
            aria-label="Dismiss message"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      ) : null}
      {loading
        ? content(
            <>
              {title("Your judge sheets", "Opening the sheets saved on this phone…")}
              <div className="judge-panel" role="status">
                Checking your saved work.
              </div>
            </>,
          )
        : null}
      {!loading && view === "join"
        ? content(
            <>
              {title("Take your seat", "Sign in with the codes on your judge card.")}
              <form
                className="judge-panel space-y-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(async () => {
                    await api("/api/judge/login", { tournamentCode, judgeCode });
                    const profile = await api<JudgeBootstrap>("/api/judge/me");
                    const next = await store.current!.download(profile);
                    setWorkspace(next);
                    setView("home");
                    void navigator.storage?.persist?.();
                  });
                }}
              >
                <label className="judge-label">
                  Tournament code
                  <input
                    className="judge-input uppercase"
                    name="tournamentCode"
                    value={tournamentCode}
                    onChange={(event) => setTournamentCode(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    maxLength={128}
                    required
                  />
                </label>
                <label className="judge-label">
                  Judge code
                  <input
                    className="judge-input uppercase"
                    name="judgeCode"
                    value={judgeCode}
                    onChange={(event) => setJudgeCode(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="characters"
                    maxLength={128}
                    required
                  />
                </label>
                <ActionButton type="submit" size="lg" className="w-full" disabled={busy || !online}>
                  {busy ? "Signing in…" : "Open my sheets"}
                </ActionButton>
              </form>
              <p className="text-body-sm text-text-secondary">
                You can also scan the QR on your judge card with your phone camera. In an installed
                app, type the codes here to sign in.
              </p>
              {workspace ? (
                <button className={quiet} onClick={() => go("home")}>
                  Return to sheets saved on this phone
                </button>
              ) : null}
              <section className="judge-panel space-y-3" aria-label="Try Dais">
                <h2 className="text-h3">Just exploring?</h2>
                <p className="text-body-sm text-text-secondary">
                  Try three rounds with fictional teams. No codes or installation needed.
                </p>
                <Link className={quiet} href="/demo/judge">
                  Try a sample room
                </Link>
              </section>
            </>,
          )
        : null}
      {!loading && view === "home" && workspace
        ? content(
            <>
              {title(
                `Hello, ${workspace.bootstrap.judge.name}`,
                workspace.bootstrap.judge.homeRoomName
                  ? `Your fixed room: ${workspace.bootstrap.judge.homeRoomName}`
                  : "Your room is shown on each round below.",
              )}
              <div className="flex items-center justify-between gap-3">
                <StatusChip variant={pwa.ready ? "success" : "warning"}>
                  {pwa.ready
                    ? "Ready to work without signal"
                    : "Keep this app open until offline setup finishes"}
                </StatusChip>
              </div>
              <div className="space-y-3">
                {workspace.bootstrap.assignments
                  .filter((row) => !row.retiredAt)
                  .sort((a, b) => a.identity.round - b.identity.round)
                  .map((assignment) => {
                    const pending = Object.values(workspace.outbox).find(
                      (item) => item.assignmentId === assignment.id,
                    );
                    const stored = workspace.drafts[assignment.id];
                    const status = pending
                      ? stateLabel[pending.state]
                      : assignment.current
                        ? "Received"
                        : stored
                          ? "Draft saved"
                          : "Ready to score";
                    return (
                      <section className="judge-round" key={assignment.id}>
                        <div className="judge-round-number tabular">
                          {assignment.identity.round}
                          <span>Round</span>
                        </div>
                        <div className="min-w-0 flex-1">
                          <h2 className="text-h3">{assignment.display.roomName}</h2>
                          <p className="text-body-sm text-text-secondary">
                            {assignment.identity.divisionCode} · {assignment.display.roundFormat}
                          </p>
                          <StatusChip
                            variant={
                              assignment.current && !pending
                                ? "success"
                                : pending
                                  ? "warning"
                                  : "neutral"
                            }
                          >
                            {status}
                          </StatusChip>
                        </div>
                        <button
                          className="judge-icon"
                          aria-label={`Open round ${assignment.identity.round} sheet`}
                          disabled={busy}
                          onClick={() => void perform(() => open(assignment))}
                        >
                          <ChevronRight aria-hidden="true" />
                        </button>
                      </section>
                    );
                  })}
                {!workspace.bootstrap.assignments.some((row) => !row.retiredAt) ? (
                  <div className="judge-panel">
                    <h2>Your sheets are on their way</h2>
                    <p>The organiser will finish the draw. Refresh when connected.</p>
                  </div>
                ) : null}
              </div>
              {workspace.bootstrap.assignments.some(
                (row) => row.retiredAt && workspace.drafts[row.id],
              ) ? (
                <section className="judge-panel">
                  <h2 className="text-h3">Saved sheets from the old draw</h2>
                  <p className="text-body-sm text-text-secondary">
                    Your scores are preserved. Open a copy to use the new draw or hand it off.
                  </p>
                  {workspace.bootstrap.assignments
                    .filter((row) => row.retiredAt && workspace.drafts[row.id])
                    .map((row) => (
                      <button
                        key={row.id}
                        className={`${quiet} w-full mt-3`}
                        onClick={() => void perform(() => open(row))}
                      >
                        Round {row.identity.round} · {row.display.roomName}
                      </button>
                    ))}
                </section>
              ) : null}
              {Object.keys(workspace.tombstones).length ? (
                <section className="judge-panel space-y-3">
                  <h2 className="text-h3">Copies kept aside</h2>
                  <p className="text-body-sm text-text-secondary">
                    Restore a copy to review it or retry its saved send.
                  </p>
                  {Object.values(workspace.tombstones).map((copy) => {
                    const assignment = workspace.bootstrap.assignments.find(
                      (row) => row.id === copy.assignmentId,
                    );
                    return (
                      <button
                        key={copy.id}
                        className={`${quiet} w-full`}
                        disabled={busy}
                        onClick={() =>
                          void perform(async () => {
                            await store.current!.undo(workspace.key, copy.id);
                            setDiscarded(null);
                            await reload();
                            sync.current?.broadcast();
                          })
                        }
                      >
                        Restore{" "}
                        {assignment
                          ? `round ${assignment.identity.round} · ${assignment.display.roomName}`
                          : "saved copy"}
                      </button>
                    );
                  })}
                </section>
              ) : null}
              <div className="flex flex-wrap gap-3">
                <button
                  className={quiet}
                  disabled={busy || !online}
                  onClick={() =>
                    void perform(async () => {
                      await sync.current?.refresh();
                      await sync.current?.flush();
                    })
                  }
                >
                  Refresh and send waiting sheets
                </button>
                <button className={quiet} onClick={() => go("help")}>
                  Rubric and help
                </button>
              </div>
              <button
                className={quiet}
                disabled={busy || !online}
                onClick={() =>
                  void perform(async () => {
                    await api("/api/judge/logout", {});
                    await store.current!.signOut();
                    setWorkspace(null);
                    setView("join");
                  })
                }
              >
                Sign out · saved sheets are kept
              </button>
            </>,
          )
        : null}
      {!loading && view === "before" && row && draft
        ? content(
            <>
              {homeButton}
              {title("Before you score", `Round ${row.identity.round} · ${row.display.roomName}`)}
              <section className="judge-panel">
                <p className="text-eyebrow">The motion</p>
                <h2 className="mt-2 text-h2">
                  {row.display.motion || "The organiser will announce the motion."}
                </h2>
                <p className="mt-3 text-body-sm text-text-secondary">
                  {row.display.roundFormat === "impromptu"
                    ? "Impromptu · allow 15 minutes to prepare"
                    : "Prepared debate"}
                </p>
              </section>
              <section className="judge-panel space-y-4">
                <h2 className="text-h3">Which side did each team take?</h2>
                <SegmentedControl
                  label="Sides in the room"
                  value={draft.payload.sideFlipped ? "swapped" : "drawn"}
                  onValueChange={(value) => patch({ sideFlipped: value === "swapped" })}
                  options={[
                    { value: "drawn", label: "As drawn" },
                    {
                      value: "swapped",
                      label:
                        row.display.sidesDecided === "in-room"
                          ? "Coin toss swapped"
                          : "Sides swapped",
                    },
                  ]}
                />
                <div className="space-y-2">
                  {[row.display.government, row.display.opposition].map((team, index) => (
                    <p className="text-body-sm" key={team.teamId}>
                      <SideTag
                        side={actualSide(
                          index === 0 ? "government" : "opposition",
                          draft.payload.sideFlipped,
                        )}
                      />{" "}
                      <strong>{team.name}</strong> · {team.school}
                    </p>
                  ))}
                </div>
              </section>
              <section className="judge-panel space-y-4">
                <h2 className="text-h3">Confirm the speaking roles</h2>
                {[row.display.government, row.display.opposition].map((team) => (
                  <label className="judge-check" key={team.teamId}>
                    <input
                      type="checkbox"
                      checked={draft.payload.roleSwaps[team.teamId] ?? false}
                      onChange={(event) =>
                        patch({ teamId: team.teamId, swapped: event.target.checked })
                      }
                    />
                    <span>{team.name}: teammates exchanged first and second speeches</span>
                  </label>
                ))}
                <ol className="space-y-2">
                  {people.map((speaker) => (
                    <li className="flex items-center gap-3" key={speaker.id}>
                      <RoleTag roleKey={speaker.role} />
                      <span>{speaker.name}</span>
                    </li>
                  ))}
                </ol>
              </section>
              <ActionButton
                size="lg"
                className="w-full"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const next = await store.current!.before(
                      key!,
                      row.id,
                      persisted.current!.revision,
                    );
                    persisted.current = next;
                    setDraft(next);
                    go("score");
                    await reload();
                  })
                }
              >
                Start scoring
              </ActionButton>
            </>,
          )
        : null}
      {!loading && view === "score" && row && draft ? (
        <>
          {content(
            <>
              <button className={quiet} onClick={() => go("before")}>
                <ArrowLeft aria-hidden="true" size={18} />
                Sides and roles
              </button>
              {title("Your scoresheet", `Round ${row.identity.round} · ${row.display.roomName}`)}
              <p className="text-body-sm text-text-secondary">
                Overall is your judgement of the speech. The category scores are guidance; they are
                not added for ranking.
              </p>
              {people.map((speaker) => {
                const score = draft.payload.scores[speaker.id] ?? {};
                const slot = speakingOrder(row.display.roundFormat, timings, labels).find(
                  (slot) => slot.role === speaker.role,
                );
                return (
                  <fieldset
                    className="judge-panel space-y-5"
                    key={speaker.id}
                    data-speaker={speaker.id}
                  >
                    <legend className="judge-speaker-legend">
                      <RoleTag roleKey={speaker.role} />
                      <span>{speaker.name}</span>
                    </legend>
                    <p className="text-body-sm text-text-secondary">
                      {roleLabel(speaker.role, labels)} · {slot?.minutes} minutes
                      {speaker.role === "pm"
                        ? ` + ${timings[row.display.roundFormat][4]} minute reply`
                        : ""}
                    </p>
                    {rubric.categories
                      .filter((category) => category.key !== "poi")
                      .map((category) => {
                        const value = score[category.key];
                        const band =
                          typeof value === "number"
                            ? categoryBandFor(value, category.max, rubric.bands)
                            : null;
                        return (
                          <div className="space-y-2" key={category.key}>
                            <NumberField
                              label={category.label}
                              hint={`Out of ${category.max}`}
                              value={typeof value === "number" ? value : null}
                              onValueChange={(value) =>
                                patch({ speakerId: speaker.id, field: category.key, value })
                              }
                              min={0}
                              max={category.max}
                              allowDecimals={!rubric.integersOnly}
                              trailing={band?.label}
                            />
                            <details className="judge-details">
                              <summary>{category.label} rubric</summary>
                              {GUIDE_TEXT.filter((entry) => entry.category === category.key).map(
                                (entry) => (
                                  <p key={entry.band} className="mb-2 text-body-sm">
                                    <strong>{entry.band}:</strong> {entry.points.join(". ")}
                                  </p>
                                ),
                              )}
                            </details>
                            {category.key === "rebuttal" ? (
                              <button
                                className={`${quiet} text-body-sm`}
                                onClick={() =>
                                  patch({
                                    speakerId: speaker.id,
                                    field: "rebuttal",
                                    value: rubric.noRebuttalScore,
                                  })
                                }
                              >
                                No rebuttal attempted = {rubric.noRebuttalScore}
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    <div>
                      <p className="judge-label mb-2">
                        Points of information · out of{" "}
                        {rubric.categories.find((category) => category.key === "poi")?.max ?? 4}
                      </p>
                      {(rubric.categories.find((category) => category.key === "poi")?.max ?? 4) <=
                      4 ? (
                        <SegmentedControl
                          label={`Points of information for ${speaker.name}`}
                          value={score.poi === undefined ? null : String(score.poi)}
                          onValueChange={(value) =>
                            patch({ speakerId: speaker.id, field: "poi", value: Number(value) })
                          }
                          options={Array.from(
                            {
                              length:
                                (rubric.categories.find((category) => category.key === "poi")
                                  ?.max ?? 4) + 1,
                            },
                            (_, index) => ({ value: String(index), label: String(index) }),
                          )}
                        />
                      ) : (
                        <NumberField
                          label="Points of information"
                          value={score.poi ?? null}
                          onValueChange={(value) =>
                            patch({ speakerId: speaker.id, field: "poi", value })
                          }
                          min={0}
                          max={
                            rubric.categories.find((category) => category.key === "poi")?.max ?? 4
                          }
                        />
                      )}
                    </div>
                    <OverallField
                      value={score.overall ?? null}
                      onValueChange={(value) =>
                        patch({ speakerId: speaker.id, field: "overall", value })
                      }
                      bands={rubric.bands}
                      max={rubric.overallMax}
                      note="Scores above 90 are very rare."
                    />
                    {(["www", "ebi"] as const).map((field) => (
                      <label className="judge-label" key={field}>
                        {field === "www" ? "What went well" : "Even better if"}
                        <textarea
                          className="judge-input min-h-24"
                          value={score[field] ?? ""}
                          onChange={(event) =>
                            patch({ speakerId: speaker.id, field, value: event.target.value })
                          }
                          maxLength={rubric.commentMaxLength}
                          rows={3}
                        />
                      </label>
                    ))}
                  </fieldset>
                );
              })}
            </>,
          )}
          <StickyActionBar
            status={
              <span>
                {saved}
                <br />
                {progress?.scored} of {progress?.total} debaters scored
              </span>
            }
          >
            <ActionButton
              size="lg"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const next = await store.current!.review(
                    key!,
                    row.id,
                    persisted.current!.revision,
                  );
                  persisted.current = next;
                  setDraft(next);
                  go("review");
                  await reload();
                })
              }
            >
              Review sheet
            </ActionButton>
          </StickyActionBar>
        </>
      ) : null}
      {!loading && view === "review" && row && draft
        ? content(
            <>
              <button className={quiet} onClick={() => go("score")}>
                <ArrowLeft aria-hidden="true" size={18} />
                Edit scores
              </button>
              {title(
                "Review your sheet",
                "Check the four Overall scores and speaking roles before sending.",
              )}
              <div className="judge-panel space-y-4">
                {people.map((speaker) => (
                  <div className="judge-review-row" key={speaker.id}>
                    <div>
                      <RoleTag roleKey={speaker.role} />
                      <h2 className="text-h3 mt-1">{speaker.name}</h2>
                      <p className="text-body-sm text-text-secondary">
                        {SCORE_FIELDS.filter((field) => field !== "overall")
                          .map(
                            (field) =>
                              `${field === "poi" ? "POI" : field} ${draft.payload.scores[speaker.id]?.[field] ?? "—"}`,
                          )
                          .join(" · ")}
                      </p>
                    </div>
                    <strong className="numeral text-numeral">
                      {draft.payload.scores[speaker.id]?.overall}
                    </strong>
                  </div>
                ))}
                <p className="text-body-sm">
                  Sides: {draft.payload.sideFlipped ? "swapped in the room" : "as drawn"}. Role
                  exchanges are recorded with these scores.
                </p>
              </div>
              {feedbackGaps(
                draft.payload,
                row.identity.speakers.map((speaker) => speaker.id),
              ).length > 0 ? (
                <p className="text-body-sm text-warning">
                  Some feedback boxes are empty. You can return to add comments.
                </p>
              ) : null}
              <ActionButton
                size="lg"
                className="w-full"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await store.current!.enqueue(key!, row.id, persisted.current!.revision);
                    sync.current?.broadcast();
                    go("receipt");
                    await reload();
                    void sync.current?.flush();
                  })
                }
              >
                {online ? "Send to the tournament" : "Save to send when connected"}
              </ActionButton>
              <p className="text-body-sm text-text-secondary">
                Your reviewed sheet stays on this phone until the tournament sends a receipt.
              </p>
            </>,
          )
        : null}
      {!loading && view === "receipt" && row && workspace
        ? content(
            <>
              {homeButton}
              {title(
                item
                  ? stateLabel[item.state]
                  : row.retiredAt
                    ? "The draw changed"
                    : receipt || row.current
                      ? "Received by the tournament"
                      : "Your saved sheet",
                `Round ${row.identity.round} · ${row.display.roomName}`,
              )}
              <section className="judge-panel space-y-3">
                <StatusChip variant={!item && (receipt || row.current) ? "success" : "warning"}>
                  {item
                    ? stateLabel[item.state]
                    : row.retiredAt
                      ? "Old draw copy"
                      : receipt || row.current
                        ? "Received"
                        : "Saved on this phone"}
                </StatusChip>
                <p>
                  {item?.error?.message ??
                    (!item && (receipt?.status === "received" || row.current)
                      ? `Received by the tournament at ${time(receipt?.status === "received" ? receipt.receivedAt : row.current!.receivedAt)}.`
                      : "Your reviewed scores are safe on this phone. Keep the app open to send when a connection is available.")}
                </p>
                {item?.error?.requestId ? (
                  <p className="text-body-sm text-text-secondary">
                    Request ID: {item.error.requestId}
                  </p>
                ) : null}
                {row.current ? (
                  <div className="space-y-2">
                    {row.display.speakers.map((speaker) => (
                      <p key={speaker.id} className="flex justify-between gap-3">
                        <span>{speaker.name}</span>
                        <strong className="tabular">
                          {row.current!.payload.scores[speaker.id]?.overall ?? "—"}
                        </strong>
                      </p>
                    ))}
                  </div>
                ) : null}
              </section>
              <div className="grid gap-3">
                {item ? (
                  <ActionButton
                    size="lg"
                    disabled={busy || item.state === "sending"}
                    onClick={() =>
                      void perform(async () => {
                        await store.current!.retry(key!, item.requestId);
                        sync.current?.broadcast();
                        await sync.current?.flush();
                        await reload();
                      })
                    }
                  >
                    Retry saved sheet
                  </ActionButton>
                ) : null}
                {item?.state === "auth" ? (
                  <button className={quiet} onClick={() => go("join")}>
                    Sign in again with my judge code
                  </button>
                ) : null}
                {row.retiredAt && row.successorId ? (
                  <ActionButton
                    size="lg"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const next = await store.current!.successor(key!, row.id);
                        setSelectedId(next.assignmentId);
                        persisted.current = next;
                        setDraft(next);
                        go("before");
                        await reload();
                      })
                    }
                  >
                    Open the new sheet · copy matching debaters
                  </ActionButton>
                ) : null}
                {draft && item?.state !== "sending" && !row.retiredAt ? (
                  <button
                    className={quiet}
                    disabled={busy || row.divisionFinalized}
                    onClick={() =>
                      void perform(async () => {
                        const next = await store.current!.edit(key!, row.id);
                        persisted.current = next;
                        setDraft(next);
                        go("score");
                        await reload();
                      })
                    }
                  >
                    Edit and resubmit
                  </button>
                ) : null}
                {completed ? (
                  <button className={quiet} onClick={beginHandoff}>
                    Hand off to the organiser
                  </button>
                ) : null}
                {row.current && !draft && !row.divisionFinalized ? (
                  <button
                    className={quiet}
                    onClick={() =>
                      void perform(async () => {
                        const next = await store.current!.draft(key!, row.id);
                        persisted.current = next;
                        setDraft(next);
                        go("before");
                        await reload();
                      })
                    }
                  >
                    Correct my scores
                  </button>
                ) : null}
                {draft || item ? (
                  <button
                    className={quiet}
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const id = await store.current!.discard(key!, row.id);
                        setDiscarded(id);
                        setDraft(null);
                        persisted.current = null;
                        go("home");
                        sync.current?.broadcast();
                        await reload();
                      })
                    }
                  >
                    Keep aside this local copy
                  </button>
                ) : null}
                <button className={quiet} onClick={() => go("help")}>
                  Get help
                </button>
              </div>
              {row.retiredAt ? (
                <p className="text-body-sm text-text-secondary">
                  Only debaters still in the new debate are copied. Confirm the sides and roles
                  again. Your old copy is kept.
                </p>
              ) : null}
            </>,
          )
        : null}
      {!loading && view === "handoff"
        ? content(
            <>
              <button className={quiet} onClick={() => go("receipt")}>
                <ArrowLeft aria-hidden="true" size={18} />
                Back to saved sheet
              </button>
              {title(
                "Hand off your sheet",
                "The organiser can scan or paste the scores below. Keep this phone copy until you have a receipt.",
              )}
              {handoff ? (
                <>
                  <section className="judge-panel text-center">
                    {qr ? (
                      <Image
                        unoptimized
                        src={qr}
                        alt="QR containing the checked scores, sides and role exchanges"
                        width={280}
                        height={280}
                        className="mx-auto max-w-full"
                      />
                    ) : (
                      <p>Use the complete code below.</p>
                    )}
                    <p className="text-body-sm mt-3">Read out the check code</p>
                    <p className="font-mono text-h1 tracking-widest">{handoff.code}</p>
                    <p className="text-body-sm text-text-secondary">
                      This checks the scan or pasted code. The six digits alone do not contain your
                      scores.
                    </p>
                  </section>
                  <label className="judge-label">
                    Complete hand-off code
                    <textarea
                      className="judge-input font-mono text-base"
                      rows={5}
                      readOnly
                      value={handoff.text}
                    />
                  </label>
                  <ActionButton size="lg" disabled={busy} onClick={() => void copy(handoff.text)}>
                    Copy scores and sides
                  </ActionButton>
                  <label className="judge-label">
                    Feedback · sent separately
                    <textarea
                      className="judge-input"
                      readOnly
                      rows={8}
                      value={handoffComments(
                        completed!,
                        Object.fromEntries(
                          row!.display.speakers.map((speaker) => [speaker.id, speaker.name]),
                        ),
                      )}
                    />
                  </label>
                  <button
                    className={quiet}
                    onClick={() =>
                      void copy(
                        handoffComments(
                          completed!,
                          Object.fromEntries(
                            row!.display.speakers.map((speaker) => [speaker.id, speaker.name]),
                          ),
                        ),
                      )
                    }
                  >
                    Copy feedback
                  </button>
                  <p className="text-body-sm text-text-secondary">
                    After the organiser enters the scores, retry the same saved sheet. The
                    tournament will absorb matching numbers and keep your comments with the phone
                    receipt.
                  </p>
                </>
              ) : (
                <div className="judge-panel">
                  Fill in all four debaters&apos; scores before making a hand-off. Your draft is
                  still saved.
                </div>
              )}
            </>,
          )
        : null}
      {!loading && view === "help"
        ? content(
            <>
              {homeButton}
              {title("Rubric and help", "A calm guide for the debate in front of you.")}
              <section className="judge-panel space-y-3">
                <h2 className="text-h3">Without signal</h2>
                <p>
                  Your downloaded sheets and every saved change stay on this phone. Review and send
                  as usual; the app retries when you reconnect. Keep the app open until you see
                  “Received by the tournament”.
                </p>
                <p className="text-body-sm">
                  If a send needs attention, retry the saved copy, edit and resubmit, or hand it to
                  the organiser. Keeping a copy aside is reversible.
                </p>
                <button className={quiet} onClick={() => go("join")}>
                  Sign in again
                </button>
              </section>
              <section className="judge-panel">
                <h2 className="text-h3">Speech timings</h2>
                {(["prepared", "impromptu"] as const).map((format) => (
                  <div key={format} className="mt-4">
                    <h3 className="capitalize">{format}</h3>
                    {speakingOrder(format, timings, labels).map((slot) => (
                      <p key={slot.key} className="flex justify-between gap-4 text-body-sm">
                        <span>{slot.label}</span>
                        <strong>{slot.minutes} min</strong>
                      </p>
                    ))}
                  </div>
                ))}
              </section>
              <section className="judge-panel space-y-4">
                <h2 className="text-h3">Overall score · out of {rubric.overallMax}</h2>
                {rubric.bands.map((band) => (
                  <p key={band.min} className="text-body-sm">
                    <strong>
                      {band.min}–{band.max} · {band.label}.
                    </strong>{" "}
                    {band.summary}
                  </p>
                ))}
                <BandBar bands={rubric.bands} value={78} />
                <p className="text-body-sm">
                  Scores above 90 are very rare. Overall is independent of the category total. No
                  rebuttal attempted scores {rubric.noRebuttalScore} for rebuttal.
                </p>
              </section>
              <section className="judge-panel">
                <h2 className="text-h3">Ask the organiser</h2>
                <p>
                  {workspace?.bootstrap.tournament.contact ||
                    "Go to the organiser's desk, or ask the room steward. Bring your saved sheet or hand-off code."}
                </p>
              </section>
              <InstallHelp pwa={pwa} />
            </>,
          )
        : null}
      {discarded && workspace ? (
        <div className="judge-notice" role="status">
          <p>Your local copy was kept aside.</p>
          <button
            className={quiet}
            onClick={() =>
              void perform(async () => {
                await store.current!.undo(workspace.key, discarded);
                setDiscarded(null);
                sync.current?.broadcast();
                await reload();
              })
            }
          >
            Undo
          </button>
        </div>
      ) : null}
      <footer className="judge-footer">
        <span>Your judgement. Safely recorded.</span>
      </footer>
    </div>
  );
}
function InstallHelp({ pwa }: { pwa: ReturnType<typeof useJudgePwa> }) {
  return (
    <details className="judge-details">
      <summary>Add to home screen (optional)</summary>
      <p className="text-body-sm">
        Dais works in your browser. If you prefer an app shortcut, install after your sheets finish
        downloading. Open the installed app while connected, then use your judge codes or choose
        “Try a sample room”.
      </p>
      {pwa.install ? (
        <button className="judge-button mt-3" onClick={() => void pwa.installApp()}>
          Install Dais
        </button>
      ) : (
        <p className="text-body-sm mt-2">
          {pwa.ios
            ? "On iPhone: Share → Add to Home Screen → Add."
            : "In your browser menu, choose Install app or Add to Home Screen."}
        </p>
      )}
      <p className="text-body-sm mt-2">
        {pwa.ready
          ? "The app is ready to open without signal."
          : "Offline setup finishes after opening Dais while connected."}
      </p>
    </details>
  );
}
