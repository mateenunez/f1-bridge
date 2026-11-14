import fs from "node:fs";
import path from "node:path";
import type { WriteStream } from "node:fs";

interface SessionSnapshot {
  R: Record<string, any>;
}

export interface RecordingMeetingMetadata {
  key: number | null;
  name: string | null;
  officialName: string | null;
  location: string | null;
  countryKey: number | null;
  countryCode: string | null;
  countryName: string | null;
  circuitKey: number | null;
  circuitShortName: string | null;
}

export interface RecordingSessionMetadata {
  key: number | null;
  name: string | null;
  type: string | null;
  startDate: string | null;
  endDate: string | null;
  qualifyingPart: number | null;
}

export interface RecordingMetadata {
  meeting: RecordingMeetingMetadata;
  session: RecordingSessionMetadata;
}

interface SessionIdentity {
  key: string;
  type: string;
  year: string;
  meetingKey: string;
  meetingName: string;
  name: string;
  meeting: RecordingMeetingMetadata;
  session: Omit<RecordingSessionMetadata, "qualifyingPart">;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function toPositiveInteger(value: unknown): number | null {
  const parsed = toInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function parseSessionDate(value: string | null): Date | null {
  if (!value) return null;
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value}Z`;
  const parsed = new Date(withZone);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class SessionRecorder {
  private readonly outputDirectory: string;
  private stream: WriteStream | null = null;
  private activeSessionKey: string | null = null;
  private activeQualifyingPart: number | null = null;
  private failedSessionKey: string | null = null;

  constructor(
    outputDirectory = process.env.F1_RECORDINGS_DIR?.trim(),
    private readonly onFileClosed?: (
      filePath: string,
      metadata: RecordingMetadata,
    ) => void | Promise<void>,
  ) {
    this.outputDirectory = path.resolve(outputDirectory || "recordings");
  }

  recordInitialState(state: SessionSnapshot): void {
    if (this.getStatus(state) === "started") {
      this.startSession(state);
    }
  }

  recordFeed(
    feedName: string,
    data: unknown,
    timestamp: string,
    state: SessionSnapshot,
  ): void {
    const isSessionFeed = feedName === "SessionInfo" || feedName === "SessionData";
    const status = isSessionFeed ? this.getStatus(state, data) : "";

    if (status === "finalised") {
      this.writeFeed(feedName, data, timestamp);
      this.finishSession();
      return;
    }

    if (status === "started") {
      const identity = this.getIdentity(state);
      const qualifyingPart = this.getQualifyingPart(state, data);
      const isQualifying =
        identity.type.includes("qual") || identity.name.toLowerCase().includes("qual");

      if (identity.key !== this.activeSessionKey) {
        this.finishSession();
        this.startSession(state);
        this.activeSessionKey = identity.key;
        this.activeQualifyingPart = qualifyingPart;
        return;
      }

      if (
        this.stream &&
        isQualifying &&
        qualifyingPart !== null &&
        qualifyingPart !== this.activeQualifyingPart
      ) {
        this.finishCurrentFile();
        this.startFile(state, identity, qualifyingPart);
        this.activeQualifyingPart = qualifyingPart;
        return;
      }
    }

    this.writeFeed(feedName, data, timestamp);
  }

  private getStatus(state: SessionSnapshot, update?: unknown): string {
    const updatedStatus = (update as { SessionStatus?: unknown } | null)
      ?.SessionStatus;
    const status =
      updatedStatus ??
      state.R.SessionInfo?.SessionStatus ??
      state.R.SessionData?.SessionStatus ??
      "";
    const normalized = String(status).toLowerCase();
    if (normalized === "started") return "started";
    if (normalized === "finalised" || normalized === "finalized") {
      return "finalised";
    }
    return normalized;
  }

  private getIdentity(state: SessionSnapshot): SessionIdentity {
    const root = asRecord(state.R);
    const sessionInfo = asRecord(root?.SessionInfo);
    const meetingNode = asRecord(sessionInfo?.Meeting);
    const countryNode = asRecord(meetingNode?.Country);
    const circuitNode = asRecord(meetingNode?.Circuit);

    const rawSessionName = toText(sessionInfo?.Name) ?? "";
    const rawSessionType = toText(sessionInfo?.Type) ?? "";
    const startDate = toText(sessionInfo?.StartDate);
    const endDate = toText(sessionInfo?.EndDate);
    const name = rawSessionName || rawSessionType || "session";
    const type = (rawSessionType || name).toLowerCase();
    const meetingKey = toPositiveInteger(meetingNode?.Key);
    const meetingName = toText(meetingNode?.Name) ?? "";
    const start = parseSessionDate(startDate);
    const sessionName = rawSessionName || rawSessionType || "Session";
    const sessionType = rawSessionType || sessionName;
    const sessionKeyValue = toPositiveInteger(sessionInfo?.Key);

    const meeting: RecordingMeetingMetadata = {
      key: meetingKey,
      name: meetingName || (meetingKey !== null ? `Meeting ${meetingKey}` : null),
      officialName: toText(meetingNode?.OfficialName),
      location: toText(meetingNode?.Location),
      countryKey: toPositiveInteger(countryNode?.Key),
      countryCode: toText(countryNode?.Code),
      countryName: toText(countryNode?.Name),
      circuitKey: toPositiveInteger(circuitNode?.Key),
      circuitShortName: toText(circuitNode?.ShortName),
    };
    const session: Omit<RecordingSessionMetadata, "qualifyingPart"> = {
      key: toPositiveInteger(sessionInfo?.Key),
      name: sessionName,
      type: sessionType,
      startDate,
      endDate,
    };

    return {
      key:
        sessionKeyValue !== null
          ? String(sessionKeyValue)
          : [meetingKey ?? "", startDate ?? "", name].join("-"),
      type,
      year: String(
        start ? start.getUTCFullYear() : new Date().getUTCFullYear(),
      ),
      meetingKey: meetingKey !== null ? String(meetingKey) : "",
      meetingName,
      name,
      meeting,
      session,
    };
  }

  private getQualifyingPart(state: SessionSnapshot, update: unknown): number | null {
    const updateData = update as { Series?: unknown } | null;
    const updatedSeries = updateData?.Series;
    const updatedPart = this.latestQualifyingPart(updatedSeries);
    if (updatedPart !== null) return updatedPart;

    const sessionInfo = state.R.SessionInfo ?? {};
    const sessionData = state.R.SessionData ?? {};
    const parts = [
      this.latestQualifyingPart(sessionData.Series),
      this.latestQualifyingPart(sessionInfo.Series),
    ].filter((part): part is number => part !== null);

    return parts.length > 0 ? Math.max(...parts) : null;
  }

  private latestQualifyingPart(series: unknown): number | null {
    if (!series || typeof series !== "object") return null;

    const entries = Array.isArray(series)
      ? series.map((value, index) => [index, value] as const)
      : Object.entries(series).sort(
          ([left], [right]) => Number(left) - Number(right),
        );

    for (let index = entries.length - 1; index >= 0; index--) {
      const value = entries[index]?.[1] as
        | { QualifyingPart?: unknown }
        | undefined;
      const part = Number(value?.QualifyingPart);
      if (Number.isInteger(part) && part >= 1 && part <= 3) return part;
    }

    return null;
  }

  private startSession(state: SessionSnapshot): void {
    const identity = this.getIdentity(state);
    const isQualifying =
      identity.type.includes("qual") || identity.name.toLowerCase().includes("qual");
    const qualifyingPart = isQualifying
      ? this.getQualifyingPart(state, null) ?? 1
      : null;

    this.startFile(state, identity, qualifyingPart);
    this.activeSessionKey = identity.key;
    this.activeQualifyingPart = qualifyingPart;
  }

  private startFile(
    state: SessionSnapshot,
    identity: SessionIdentity,
    qualifyingPart: number | null,
  ): void {
    if (this.failedSessionKey === identity.key) return;

    const safeName = (value: string) =>
      value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const meetingSlug =
      safeName(identity.meetingName) ||
      safeName(identity.meetingKey) ||
      "event";
    const baseName = [
      identity.year,
      meetingSlug,
      safeName(identity.name),
      qualifyingPart ? `q${qualifyingPart}` : "",
    ]
      .filter(Boolean)
      .join("-");

    try {
      fs.mkdirSync(this.outputDirectory, { recursive: true });

      const entries = fs.readdirSync(this.outputDirectory, {
        withFileTypes: true,
      });
      const matchingFiles = entries.flatMap((entry) => {
        if (!entry.isFile()) return [];
        if (entry.name === `${baseName}.jsonl`) {
          return [{ name: entry.name, suffix: 1 }];
        }

        const suffixPrefix = `${baseName}-`;
        if (
          !entry.name.startsWith(suffixPrefix) ||
          !entry.name.endsWith(".jsonl")
        ) {
          return [];
        }
        const suffixText = entry.name.slice(
          suffixPrefix.length,
          -".jsonl".length,
        );
        const suffix = Number(suffixText);
        return Number.isInteger(suffix) && suffix >= 2
          ? [{ name: entry.name, suffix }]
          : [];
      });
      matchingFiles.sort((left, right) => right.suffix - left.suffix);

      const existingFile = matchingFiles[0];
      let filePath: string;
      let fileDescriptor: number;
      if (existingFile) {
        filePath = path.join(this.outputDirectory, existingFile.name);
        const content = fs.readFileSync(filePath);
        const lastNewline = content.lastIndexOf(0x0a);
        const completeLength = lastNewline + 1;
        if (completeLength !== content.length) {
          fs.truncateSync(filePath, completeLength);
        }
        fileDescriptor = fs.openSync(filePath, "a");
      } else {
        filePath = path.join(this.outputDirectory, `${baseName}.jsonl`);
        fileDescriptor = fs.openSync(filePath, "wx");
      }

      const stream = fs.createWriteStream(filePath, {
        fd: fileDescriptor,
        autoClose: true,
      });
      stream.on("error", (error) => {
        console.error(`[Recorder] Failed writing ${filePath}:`, error);
        if (this.stream === stream) this.stream = null;
        this.failedSessionKey = identity.key;
      });
      stream.on("finish", () => {
        if (!this.onFileClosed) return;
        Promise.resolve(
          this.onFileClosed(filePath, {
            meeting: identity.meeting,
            session: {
              ...identity.session,
              qualifyingPart,
            },
          }),
        ).catch((error) => {
          console.error(`[Recorder] Failed to upload ${filePath}:`, error);
        });
      });

      this.stream = stream;
      this.writeRecord(stream, { R: structuredClone(state.R) });
      console.log(
        `[Recorder] Recording ${existingFile ? "resumed" : "started"}: ${filePath}`,
      );
    } catch (error) {
      this.failedSessionKey = identity.key;
      console.error("[Recorder] Could not start session recording:", error);
    }
  }

  private writeFeed(feedName: string, data: unknown, timestamp: string): void {
    if (!this.stream) return;

    this.writeRecord(this.stream, {
      M: [{ H: "Streaming", M: "feed", A: [feedName, data, timestamp] }],
    });
  }

  private writeRecord(stream: WriteStream, record: unknown): void {
    try {
      stream.write(`${JSON.stringify(record)}\n`);
    } catch (error) {
      console.error("[Recorder] Failed to serialize a telemetry record:", error);
      this.failedSessionKey = this.activeSessionKey;
      this.finishCurrentFile();
    }
  }

  private finishCurrentFile(): void {
    const stream = this.stream;
    this.stream = null;
    stream?.end();
  }

  private finishSession(): void {
    this.finishCurrentFile();
    this.activeSessionKey = null;
    this.activeQualifyingPart = null;
    this.failedSessionKey = null;
  }
}
