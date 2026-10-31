import { identifier, type Json, type Operation } from "./core/contracts.js";
export class JetskiClient {
  private readonly base: URL;
  constructor(
    url: string,
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    this.base = new URL(url);
    if (
      this.base.protocol !== "https:" &&
      !(
        this.base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(this.base.hostname)
      )
    )
      throw new Error("HTTPS required outside loopback");
    if (this.base.username || this.base.password)
      throw new Error("URL credentials prohibited");
  }
  async request<T>(path: string, method = "GET", body?: Json): Promise<T> {
    if (!path.startsWith("/v1/") || path.includes("..") || path.includes("\\"))
      throw new Error("Invalid API path");
    const headers = {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
    const options: RequestInit = { method, headers, redirect: "error" };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await this.transport(new URL(path, this.base), options);
    if (!response.ok)
      throw new Error(`Jetski request failed (${response.status})`);
    return (await response.json()) as T;
  }
  operation(sandbox: string, id: string): Promise<Operation> {
    return this.request(
      `/v1/sandboxes/${identifier(sandbox)}/operations/${identifier(id)}`,
    );
  }
}
