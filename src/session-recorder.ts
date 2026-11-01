import fs from "node:fs";
import path from "node:path";
import type { WriteStream } from "node:fs";

interface SessionSnapshot {
  R: Record<string, any>;
}

export interface RecordingMetadata {
  sessionName: string | null;
  sessionType: string | null;
}

interface SessionIdentity {
  key: string;
  type: string;
  sessionType: string;
  year: string;
  meetingKey: string;
  meetingName: string;
  sessionPath: string;
  name: string;
  sessionName: string;
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
    const sessionInfo = state.R.SessionInfo ?? {};
    const meeting = sessionInfo.Meeting ?? {};
    const sessionPath = String(sessionInfo.Path ?? "");
    const meetingKey = String(meeting.Key ?? "");
    const meetingName = String(meeting.Name ?? "");
    const sessionName = String(sessionInfo.Name ?? "");
    const sessionType = String(sessionInfo.Type ?? "");
    const name = sessionName || sessionType || "session";
    const type = (sessionType || name).toLowerCase();
    const fallbackKey = [
      meetingKey,
      sessionInfo.StartDate ?? "",
      name,
    ].join("-");

    return {
      key: sessionPath || fallbackKey,
      type,
      sessionType,
      year: String(
        sessionInfo.StartDate
          ? new Date(sessionInfo.StartDate).getFullYear()
          : new Date().getFullYear(),
      ),
      meetingKey,
      meetingName,
      sessionPath,
      name,
      sessionName,
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
            sessionName: identity.sessionName || null,
            sessionType: identity.sessionType || null,
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
