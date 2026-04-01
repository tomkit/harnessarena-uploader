import { serializeBatch } from "./batch.js";
import type { UploadBatch } from "./models.js";
import { VERSION } from "./version.js";

export async function uploadBatch(
  batch: UploadBatch,
  apiUrl: string,
  apiKey: string,
  force = false,
): Promise<boolean> {
  const payload = JSON.stringify(serializeBatch(batch));
  let url = `${apiUrl}/api/v1/upload`;
  if (force) {
    url += "?force=true";
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": `harnessarena-uploader/${VERSION}`,
      },
      body: payload,
      signal: AbortSignal.timeout(300_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      process.stderr.write(
        `Upload failed (HTTP ${resp.status}): ${body}\n`,
      );
      return false;
    }

    const body = (await resp.json()) as Record<string, unknown>;
    process.stderr.write(
      `Upload successful: ${(body.message as string) ?? "OK"}\n`,
    );
    return true;
  } catch (e) {
    if (e instanceof TypeError) {
      process.stderr.write(`Upload failed (network): ${e.message}\n`);
    } else {
      process.stderr.write(`Upload failed: ${e}\n`);
    }
    return false;
  }
}
