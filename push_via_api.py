#!/usr/bin/env python3
"""Push changed files via GitHub REST API (avoids git push --force HTTP 500 errors)."""
import json, base64, os, sys, time

try:
    import urllib.request
    import urllib.error
    HAS_URLLIB = True
except ImportError:
    HAS_URLLIB = False

MAX_RETRIES = 3
RETRY_DELAY = 2


def api_call(url, headers, data=None, method="GET"):
    """Make a GitHub API call with retry and error body reading."""
    for attempt in range(MAX_RETRIES):
        try:
            # Encode data into body bytes BEFORE creating the Request
            if data is not None:
                body = json.dumps(data).encode("utf-8")
                headers = dict(headers)  # copy to avoid mutation
                headers["Content-Type"] = "application/json"
            else:
                body = None

            req = urllib.request.Request(url, data=body, headers=headers, method=method)
            resp = urllib.request.urlopen(req, timeout=120)
            return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # Read error body for debugging
            err_body = e.read().decode("utf-8", errors="replace")
            print(f"  HTTP {e.code} on {method} {url} (attempt {attempt+1}/{MAX_RETRIES})")
            print(f"  Error body: {err_body[:500]}")
            if e.code == 422 and "blob is too large" in err_body.lower():
                print("  FATAL: Blob too large for Git Data API, cannot retry")
                raise
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY * (attempt + 1))
            else:
                raise
        except urllib.error.URLError as e:
            print(f"  URL error on {method} {url} (attempt {attempt+1}/{MAX_RETRIES}): {e.reason}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY * (attempt + 1))
            else:
                raise


def main():
    token = os.environ["GITHUB_TOKEN"]
    repo = os.environ["GITHUB_REPOSITORY"]
    api = f"https://api.github.com/repos/{repo}"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "TheFrontStats-sync/1.0"
    }

    commit_msg = sys.argv[1] if len(sys.argv) > 1 else "[auto] sync"
    files_to_push = sys.argv[2:] if len(sys.argv) > 2 else []

    if not files_to_push:
        print("No files specified")
        sys.exit(0)

    # Get current HEAD
    head = api_call(f"{api}/git/ref/heads/main", headers)
    base_tree = head["object"]["sha"]
    print(f"Base tree: {base_tree}")

    # Create blobs + build tree entries
    tree_entries = []
    for fpath in files_to_push:
        if not os.path.exists(fpath):
            print(f"  SKIP (missing): {fpath}")
            continue

        # Normalize path: use path relative to repo root (not basename, which strips directories)
        rel_path = os.path.relpath(fpath, os.getcwd()).replace("\\", "/")

        fsize = os.path.getsize(fpath)
        print(f"  Processing: {rel_path} ({fsize} bytes raw)...")

        with open(fpath, "rb") as f:
            raw = f.read()

        # Check blob size limit (GitHub API: 100MB)
        if len(raw) > 100 * 1024 * 1024:
            print(f"  SKIP (too large): {rel_path} ({fsize} bytes > 100MB)")
            continue

        content = base64.b64encode(raw).decode("ascii")
        print(f"  Base64 encoded: {len(content)} chars from {fsize} bytes")

        try:
            blob = api_call(
                f"{api}/git/blobs", headers,
                {"content": content, "encoding": "base64"},
                "POST"
            )
            tree_entries.append({
                "path": rel_path, "mode": "100644", "type": "blob", "sha": blob["sha"]
            })
            print(f"  OK: {rel_path} -> {blob['sha'][:12]}")
        except Exception as e:
            print(f"  FAILED (base64): {rel_path}: {e}")
            # Try utf-8 encoding for small text files
            if fsize < 1024 * 1024:
                try:
                    text_content = raw.decode("utf-8", errors="replace")
                    blob = api_call(
                        f"{api}/git/blobs", headers,
                        {"content": text_content, "encoding": "utf-8"},
                        "POST"
                    )
                    tree_entries.append({
                        "path": rel_path, "mode": "100644", "type": "blob", "sha": blob["sha"]
                    })
                    print(f"  OK (utf-8 fallback): {rel_path} -> {blob['sha'][:12]}")
                except Exception as e2:
                    print(f"  FAILED (utf-8 fallback): {rel_path}: {e2}")
            continue

    if not tree_entries:
        print("No valid entries to push")
        sys.exit(1)

    # Create tree
    tree = api_call(
        f"{api}/git/trees", headers,
        {"base_tree": base_tree, "tree": tree_entries},
        "POST"
    )
    print(f"Tree: {tree['sha']}")

    # Create commit
    commit = api_call(
        f"{api}/git/commits", headers,
        {
            "message": commit_msg,
            "tree": tree["sha"],
            "parents": [base_tree]
        },
        "POST"
    )
    print(f"Commit: {commit['sha']}")

    # Force update ref
    result = api_call(
        f"{api}/git/refs/heads/main", headers,
        {"sha": commit["sha"], "force": True},
        "PATCH"
    )
    print(f"Ref updated: {result['object']['sha']}")
    print("SUCCESS")


if __name__ == "__main__":
    main()
