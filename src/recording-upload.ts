import type { RecordingMetadata } from "./session-recorder.js";

function setOptionalParam(
  params: Record<string, string | number>,
  key: string,
  value: string | number | null,
): void {
  if (value !== null) params[key] = value;
}

/**
 * Builds the query params accepted by
 * `PUT /admin/recordings/:sessionId` in f1-api-ws.
 *
 * `qualifyingPart` is always sent when known, even if the rest of the
 * identity is incomplete, so Q1/Q2/Q3 never collide on the same
 * `(session_key, qualifying_part)` pair. When the identity is incomplete we
 * omit `sessionKey` on purpose: the API then rebuilds the meeting/session from
 * the first JSONL record (`R.SessionInfo`).
 */
export function buildRecordingUploadParams(
  metadata: RecordingMetadata,
): Record<string, string | number> {
  const { meeting, session } = metadata;
  const params: Record<string, string | number> = {};

  if (session.qualifyingPart !== null) {
    params.qualifyingPart = session.qualifyingPart;
  }
  if (session.name !== null) params.sessionName = session.name;
  if (session.type !== null) params.sessionType = session.type;

  if (
    session.key === null ||
    meeting.key === null ||
    meeting.name === null ||
    session.name === null ||
    session.type === null
  ) {
    return params;
  }

  params.sessionKey = session.key;
  params.meetingKey = meeting.key;
  params.meetingName = meeting.name;

  setOptionalParam(params, "officialName", meeting.officialName);
  setOptionalParam(params, "location", meeting.location);
  setOptionalParam(params, "countryKey", meeting.countryKey);
  setOptionalParam(params, "countryCode", meeting.countryCode);
  setOptionalParam(params, "countryName", meeting.countryName);
  setOptionalParam(params, "circuitKey", meeting.circuitKey);
  setOptionalParam(params, "circuitShortName", meeting.circuitShortName);
  setOptionalParam(params, "startDate", session.startDate);
  setOptionalParam(params, "endDate", session.endDate);

  return params;
}
