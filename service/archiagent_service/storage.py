"""The one place that knows where bytes live.

Spec §7.4: everything else calls put/get/presign/delete_prefix and never learns
whether that is S3Mock, MinIO, S3 or a directory. Swapping the backing store is
a config change, not a rewrite.
"""
from functools import lru_cache
from pathlib import Path

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from archiagent_service.config import get_settings


class ObjectStore:
    def __init__(self, *, endpoint: str, bucket: str, access_key: str, secret_key: str):
        self.bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(
                signature_version="s3v4",
                s3={"addressing_style": "path"},
                # Recent botocore attaches CRC32 checksums to every upload by
                # default ("when_supported"). Multipart uploads then require the
                # per-part checksum echoed back on CompleteMultipartUpload, which
                # S3-compatible stores without flexible-checksum support reject.
                # "when_required" restores interoperable behaviour; genuine AWS
                # S3 accepts it too, so this costs nothing in production.
                request_checksum_calculation="when_required",
                response_checksum_validation="when_required",
            ),
            region_name="us-east-1",
        )

    def ensure_bucket(self) -> None:
        try:
            self._client.head_bucket(Bucket=self.bucket)
        except ClientError:
            self._client.create_bucket(Bucket=self.bucket)

    def put(self, key: str, data: bytes) -> None:
        self._client.put_object(Bucket=self.bucket, Key=key, Body=data)

    def put_file(self, key: str, path: Path) -> None:
        self._client.upload_file(str(path), self.bucket, key)

    def get(self, key: str) -> bytes:
        return self._client.get_object(Bucket=self.bucket, Key=key)["Body"].read()

    def download(self, key: str, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._client.download_file(self.bucket, key, str(path))

    def exists(self, key: str) -> bool:
        try:
            self._client.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError:
            return False

    def presign_get(self, key: str, expires: int = 3600) -> str:
        return self._client.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=expires
        )

    def presign_put(self, key: str, expires: int = 3600) -> str:
        return self._client.generate_presigned_url(
            "put_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=expires
        )

    def list_prefix(self, prefix: str) -> list[str]:
        paginator = self._client.get_paginator("list_objects_v2")
        keys: list[str] = []
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            keys.extend(item["Key"] for item in page.get("Contents", []))
        return keys

    def delete_prefix(self, prefix: str) -> int:
        keys = self.list_prefix(prefix)
        for i in range(0, len(keys), 1000):
            batch = keys[i : i + 1000]
            self._client.delete_objects(
                Bucket=self.bucket, Delete={"Objects": [{"Key": k} for k in batch]}
            )
        return len(keys)


@lru_cache
def get_store() -> ObjectStore:
    settings = get_settings()
    return ObjectStore(
        endpoint=settings.s3_endpoint,
        bucket=settings.s3_bucket,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
    )
