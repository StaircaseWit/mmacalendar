const USER_AGENT = "ufc-detailed-calendar/0.1 (+public calendar feed; respectful scheduled requests)";

interface FetchTextOptions {
  attempts?: number;
  timeoutMs?: number;
}

export async function fetchText(url: string, { attempts = 3, timeoutMs = 20_000 }: FetchTextOptions = {}): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-GB,en;q=0.9",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  const message = lastError instanceof Error ? lastError.message : "unknown error";
  throw new Error(`Could not fetch ${url}: ${message}`);
}
