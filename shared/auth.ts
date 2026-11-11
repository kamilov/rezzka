export interface SourceCredentials {
  mirrorUrl: string;
  username: string;
  password: string;
}

export interface SourceSession {
  authenticated: boolean;
  origin: string;
  username?: string;
}
