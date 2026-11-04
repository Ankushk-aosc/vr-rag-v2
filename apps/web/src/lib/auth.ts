const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export const TOKEN_STORAGE_KEY = "aether_auth_token";
export const USER_STORAGE_KEY = "aether_auth_user";

export interface UserMembership {
  id: string;
  family_entity_id: string;
  entity_name?: string;
  role: string;
}

export interface UserProfile {
  id: string;
  email: string;
  full_name: string;
  memberships: UserMembership[];
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  user: UserProfile;
}

export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setAuthToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export function getStoredUser(): UserProfile | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserProfile;
  } catch {
    return null;
  }
}

export function setStoredUser(user: UserProfile | null): void {
  if (typeof window === "undefined") return;
  if (user) {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_STORAGE_KEY);
  }
}

export function getAuthHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { ...extraHeaders };
  const token = getAuthToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Login failed with status ${res.status}`);
  }

  const data: AuthResponse = await res.json();
  setAuthToken(data.access_token);
  setStoredUser(data.user);
  return data;
}

export async function register(
  email: string,
  password: string,
  fullName: string,
  familyEntityName?: string,
  inviteToken?: string
): Promise<AuthResponse> {
  // With an invite the server places the user in the inviting family; otherwise it creates a new one
  const res = await fetch(`${API_BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(
      inviteToken
        ? { email, password, full_name: fullName, invite_token: inviteToken }
        : { email, password, full_name: fullName, family_entity_name: familyEntityName || `${fullName}'s Family Trust` }
    ),
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Registration failed with status ${res.status}`);
  }

  const data: AuthResponse = await res.json();
  setAuthToken(data.access_token);
  setStoredUser(data.user);
  return data;
}

export async function fetchCurrentUser(): Promise<UserProfile | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/me`, {
      headers: getAuthHeaders(),
      credentials: "include",
    });

    if (!res.ok) {
      if (res.status === 401) {
        logout();
      }
      return null;
    }

    const user: UserProfile = await res.json();
    setStoredUser(user);
    return user;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  const token = getAuthToken();
  if (token) {
    try {
      await fetch(`${API_BASE_URL}/api/auth/logout`, {
        method: "POST",
        headers: getAuthHeaders(),
        credentials: "include",
      });
    } catch {
      // Ignore network errors on logout
    }
  }
  setAuthToken(null);
  setStoredUser(null);
}

export async function resetPassword(currentPassword: string, newPassword: string): Promise<{ message: string }> {
  // A password change invalidates every existing token, this one included; the response carries a fresh one (I-15)
  const res = await fetch(`${API_BASE_URL}/api/auth/password-reset`, {
    method: "POST",
    headers: getAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Password reset failed with status ${res.status}`);
  }
  const data = await res.json();
  if (data.access_token) setAuthToken(data.access_token);
  return { message: data.message };
}

export async function deleteAccount(): Promise<{ message: string }> {
  const res = await fetch(`${API_BASE_URL}/api/auth/account`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new Error(errorBody.detail || `Account deletion failed with status ${res.status}`);
  }
  await logout();
  return await res.json();
}


export async function refreshSession(): Promise<AuthResponse | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
      method: "POST",
      headers: getAuthHeaders(),
      credentials: "include",
    });
    if (!res.ok) {
      if (res.status === 401) await logout();
      return null;
    }
    const data: AuthResponse = await res.json();
    setAuthToken(data.access_token);
    setStoredUser(data.user);
    return data;
  } catch {
    return null;
  }
}
