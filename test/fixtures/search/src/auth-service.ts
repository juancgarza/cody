export type AuthToken = {
  value: string;
  expiresAt: number;
};

export function issueAuthToken(userId: string): AuthToken {
  return {
    value: `auth-token-${userId}`,
    expiresAt: Date.now() + 3600,
  };
}
