/**
 * One error type for every API call, so screens can show a calm, specific message instead of a raw
 * status code or stack trace. The backend's `detail` strings are already user-safe (Audit I-11).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function toApiError(res: Response): Promise<ApiError> {
  let detail = "";
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") detail = body.detail;
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, detail);
}

export interface FriendlyError {
  title: string;
  body: string;
  /** 401: the caller should send the user back to sign-in. */
  sessionExpired?: boolean;
  /** 403: the user's role does not permit this; retrying will not help. */
  forbidden?: boolean;
}

export function friendlyError(err: unknown, action = "complete that request"): FriendlyError {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return { title: "Your session has ended", body: "Please sign in again to continue.", sessionExpired: true };
    }
    if (err.status === 403) {
      return {
        title: "Not available for your role",
        body: err.message || "Your access level for this family entity does not permit this action.",
        forbidden: true,
      };
    }
    if (err.status === 404) {
      return { title: "Not found", body: err.message || "The requested record is no longer available." };
    }
    if (err.status === 429) {
      return { title: "Too many requests", body: "Please wait a moment and try again." };
    }
    if (err.status >= 400 && err.status < 500 && err.message) {
      return { title: `We couldn't ${action}`, body: err.message };
    }
  }
  return {
    title: `We couldn't ${action}`,
    body: "The financial intelligence service is temporarily unavailable. Please try again.",
  };
}
