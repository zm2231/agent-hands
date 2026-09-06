// CDP transport types.

export interface CDPMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

export interface CDPTransport {
  send(msg: CDPMessage): void;
  onMessage(handler: (msg: CDPMessage) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface CDPClient {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  on(event: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): void;
  off(event: string, handler: (params: Record<string, unknown>, sessionId?: string) => void): void;
  close(): void;
}
