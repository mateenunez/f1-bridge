import axios from "axios";

export async function getF1ApiToken(options: {
  baseUrl: string;
  email: string;
  password: string;
}): Promise<string> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("F1T_API_URL is required to log in to the F1 Telemetry API.");
  }

  let data: {
    success?: boolean;
    token?: unknown;
    message?: string;
  };
  try {
    ({ data } = await axios.post<{
      success?: boolean;
      token?: unknown;
      message?: string;
    }>(
      `${baseUrl}/users/login`,
      {
        email: options.email,
        password: options.password,
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 15000,
      },
    ));
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      throw new Error(
        `F1 Telemetry API login request failed${status ? ` (HTTP ${status})` : ""}.`,
      );
    }
    throw error;
  }

  if (data.success !== true || typeof data.token !== "string" || !data.token.trim()) {
    throw new Error(
      `F1 Telemetry API login did not return a token${data.message ? `: ${data.message}` : "."}`,
    );
  }

  return data.token.trim();
}
