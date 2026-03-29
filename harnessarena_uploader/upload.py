from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

from ._version import __version__
from .batch import serialize_batch
from .models import UploadBatch


def upload_batch(batch: UploadBatch, api_url: str, api_key: str) -> bool:
    """Upload batch to harnessarena.com API.

    Uses urllib to avoid external dependencies.
    """
    payload = json.dumps(serialize_batch(batch), default=str).encode("utf-8")

    req = urllib.request.Request(
        f"{api_url}/api/v1/upload",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": f"harnessarena-uploader/{__version__}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            print(f"Upload successful: {body.get('message', 'OK')}", file=sys.stderr)
            return True
    except urllib.error.HTTPError as e:
        print(f"Upload failed (HTTP {e.code}): {e.read().decode()}", file=sys.stderr)
        return False
    except urllib.error.URLError as e:
        print(f"Upload failed (network): {e.reason}", file=sys.stderr)
        return False
