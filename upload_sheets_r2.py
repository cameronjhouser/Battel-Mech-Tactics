"""
Upload BattleMech PDF sheets to Cloudflare R2.

Usage:
    pip install boto3
    python upload_sheets_r2.py

Fill in the four config values below before running.
"""

import boto3
import os
import sys
from pathlib import Path
from botocore.config import Config

# Fix Unicode print errors on Windows consoles with non-UTF-8 codepages
sys.stdout.reconfigure(encoding='utf-8')

# ── CONFIG — fill these in ──────────────────────────────────────────────────
ACCOUNT_ID       = "f3c0610bbcc6c56b15ee1a69c02f9470"          # Cloudflare dashboard → right side
BUCKET_NAME      = "battletech-sheets"        # whatever you named the bucket
ACCESS_KEY_ID    = "c4e30e9a03fb45a62e06bfeefa30ef56"       # from R2 API token
SECRET_ACCESS_KEY = "6e62cf8afa8b8d7623a6a9d4b4a71679d3df6529dbb4d6110e7b82a1c116a25f"  # from R2 API token

SHEETS_DIR = r"\\HouserNAS\HouserFileBackup\AIBattletechProjects\Mech Sheets\Extracted Files"
# ────────────────────────────────────────────────────────────────────────────

ENDPOINT = f"https://{ACCOUNT_ID}.r2.cloudflarestorage.com"

def main():
    if "YOUR_ACCOUNT_ID" in ACCOUNT_ID:
        print("ERROR: Fill in your Cloudflare credentials in upload_sheets_r2.py first.")
        sys.exit(1)

    client = boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=ACCESS_KEY_ID,
        aws_secret_access_key=SECRET_ACCESS_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )

    pdfs = sorted(Path(SHEETS_DIR).glob("*.pdf"))
    total = len(pdfs)
    if total == 0:
        print(f"No PDFs found in: {SHEETS_DIR}")
        sys.exit(1)

    print(f"Found {total} PDFs — uploading to R2 bucket '{BUCKET_NAME}'...")
    print(f"Endpoint: {ENDPOINT}\n")

    # Check which files already exist so the script is safe to re-run
    existing = set()
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET_NAME):
        for obj in page.get("Contents", []):
            existing.add(obj["Key"])

    skipped = 0
    uploaded = 0
    failed = []

    for i, pdf in enumerate(pdfs, 1):
        key = pdf.name  # filename as the object key
        if key in existing:
            skipped += 1
            print(f"  [{i:4d}/{total}] SKIP  {key}")
            continue
        try:
            client.upload_file(
                str(pdf),
                BUCKET_NAME,
                key,
                ExtraArgs={"ContentType": "application/pdf"},
            )
            uploaded += 1
            print(f"  [{i:4d}/{total}] OK    {key}")
        except Exception as e:
            failed.append(key)
            print(f"  [{i:4d}/{total}] FAIL  {key}  ({e})")

    print(f"\nDone. {uploaded} uploaded · {skipped} skipped · {len(failed)} failed.")
    if failed:
        print("Failed files:")
        for f in failed:
            print(f"  {f}")

if __name__ == "__main__":
    main()
