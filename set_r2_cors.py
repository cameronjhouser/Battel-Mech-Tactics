"""
Set CORS policy on the Cloudflare R2 bucket so browsers can fetch PDFs
via JavaScript (required for the Print All / Download All merge feature).

Run once:
    python set_r2_cors.py
"""

import boto3
from botocore.config import Config

ACCOUNT_ID        = "f3c0610bbcc6c56b15ee1a69c02f9470"
BUCKET_NAME       = "battletech-sheets"
ACCESS_KEY_ID     = "c4e30e9a03fb45a62e06bfeefa30ef56"
SECRET_ACCESS_KEY = "6e62cf8afa8b8d7623a6a9d4b4a71679d3df6529dbb4d6110e7b82a1c116a25f"

ENDPOINT = f"https://{ACCOUNT_ID}.r2.cloudflarestorage.com"

client = boto3.client(
    "s3",
    endpoint_url=ENDPOINT,
    aws_access_key_id=ACCESS_KEY_ID,
    aws_secret_access_key=SECRET_ACCESS_KEY,
    config=Config(signature_version="s3v4"),
    region_name="auto",
)

cors_config = {
    "CORSRules": [
        {
            "AllowedOrigins": ["*"],
            "AllowedMethods": ["GET", "HEAD"],
            "AllowedHeaders": ["*"],
            "MaxAgeSeconds": 86400,
        }
    ]
}

client.put_bucket_cors(Bucket=BUCKET_NAME, CORSConfiguration=cors_config)
print(f"CORS policy applied to '{BUCKET_NAME}' — browsers can now fetch PDFs cross-origin.")
