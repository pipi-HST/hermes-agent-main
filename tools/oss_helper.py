"""Alibaba Cloud OSS helper for DashScope filetrans API.

Provides upload/download/delete operations for audio files that need to be
accessible via public URL for the DashScope filetrans API (qwen3-asr-flash-filetrans).

Configuration (via environment variables or ~/.hermes/config.yaml):
- OSS_ACCESS_KEY_ID: Alibaba Cloud access key ID
- OSS_ACCESS_KEY_SECRET: Alibaba Cloud access key secret
- OSS_BUCKET_NAME: OSS bucket name (e.g. "hermes-audio-temp")
- OSS_ENDPOINT: OSS endpoint (e.g. "oss-cn-hangzhou.aliyuncs.com")

The uploaded files are temporary and should be deleted after transcription.
"""

import os
import time
import uuid
from pathlib import Path
from typing import Optional

try:
    import oss2
    OSS_AVAILABLE = True
except ImportError:
    OSS_AVAILABLE = False


def _get_oss_config() -> dict:
    """Load OSS configuration from environment variables or config.yaml.

    Returns:
        dict with keys: access_key_id, access_key_secret, bucket_name, endpoint
        Returns empty dict if OSS is not configured.
    """
    # Try environment variables first
    access_key_id = os.getenv("OSS_ACCESS_KEY_ID", "")
    access_key_secret = os.getenv("OSS_ACCESS_KEY_SECRET", "")
    bucket_name = os.getenv("OSS_BUCKET_NAME", "")
    endpoint = os.getenv("OSS_ENDPOINT", "")

    # Fallback to config.yaml if env vars not set
    if not all([access_key_id, access_key_secret, bucket_name, endpoint]):
        try:
            from hermes_cli.config import load_config
            config = load_config()
            oss_config = config.get("stt", {}).get("paraformer", {}).get("oss", {})
            access_key_id = access_key_id or oss_config.get("access_key_id", "")
            access_key_secret = access_key_secret or oss_config.get("access_key_secret", "")
            bucket_name = bucket_name or oss_config.get("bucket_name", "")
            endpoint = endpoint or oss_config.get("endpoint", "")
        except Exception:
            pass

    return {
        "access_key_id": access_key_id,
        "access_key_secret": access_key_secret,
        "bucket_name": bucket_name,
        "endpoint": endpoint,
    }


def is_oss_configured() -> bool:
    """Check if OSS is properly configured and available."""
    if not OSS_AVAILABLE:
        return False
    config = _get_oss_config()
    return all([
        config["access_key_id"],
        config["access_key_secret"],
        config["bucket_name"],
        config["endpoint"],
    ])


def _get_bucket() -> Optional["oss2.Bucket"]:
    """Create and return an OSS Bucket instance.

    Returns:
        oss2.Bucket instance or None if OSS is not configured.
    """
    if not OSS_AVAILABLE:
        return None

    config = _get_oss_config()
    if not all([config["access_key_id"], config["access_key_secret"],
                config["bucket_name"], config["endpoint"]]):
        return None

    try:
        auth = oss2.Auth(config["access_key_id"], config["access_key_secret"])
        bucket = oss2.Bucket(auth, config["endpoint"], config["bucket_name"])
        return bucket
    except Exception:
        return None


def upload_audio_to_oss(local_path: str, ttl_seconds: int = 3600) -> Optional[str]:
    """Upload a local audio file to OSS and return a temporary signed URL.

    Args:
        local_path: Path to the local audio file.
        ttl_seconds: Time-to-live for the signed URL in seconds (default: 1 hour).
                    The file itself is not auto-deleted; caller should call
                    delete_oss_file() after transcription completes.

    Returns:
        Signed URL string that DashScope can use to download the file,
        or None if upload failed or OSS is not configured.
    """
    bucket = _get_bucket()
    if bucket is None:
        return None

    try:
        # Generate unique object key to avoid collisions
        file_ext = Path(local_path).suffix
        object_key = f"hermes-stt/{int(time.time())}_{uuid.uuid4().hex[:8]}{file_ext}"

        # Upload file
        with open(local_path, "rb") as f:
            result = bucket.put_object(object_key, f)

        if result.status != 200:
            return None

        # Generate signed URL for DashScope to download
        url = bucket.sign_url("GET", object_key, ttl_seconds)
        return url
    except Exception:
        return None


def delete_oss_file(object_url: str) -> bool:
    """Delete a file from OSS by its URL.

    Args:
        object_url: The signed URL or object URL returned by upload_audio_to_oss().

    Returns:
        True if deletion succeeded or file didn't exist, False otherwise.
    """
    bucket = _get_bucket()
    if bucket is None:
        return False

    try:
        # Extract object key from signed URL
        # Signed URL format: https://bucket.endpoint/object_key?signature...
        # We need to extract the object_key part
        from urllib.parse import urlparse
        parsed = urlparse(object_url)
        object_key = parsed.path.lstrip("/")

        # Delete the object
        bucket.delete_object(object_key)
        return True
    except Exception:
        return False


def upload_and_get_url(local_path: str, ttl_seconds: int = 3600) -> tuple[Optional[str], Optional[str]]:
    """Upload file to OSS and return both the public URL and object key.

    This is a convenience function for callers who need to track the object key
    separately (e.g. for cleanup).

    Args:
        local_path: Path to the local audio file.
        ttl_seconds: Time-to-live for the signed URL in seconds (unused, kept for API compatibility).

    Returns:
        Tuple of (public_url, object_key) or (None, None) if failed.
    """
    bucket = _get_bucket()
    if bucket is None:
        return None, None

    try:
        file_ext = Path(local_path).suffix
        object_key = f"hermes-stt/{int(time.time())}_{uuid.uuid4().hex[:8]}{file_ext}"

        with open(local_path, "rb") as f:
            result = bucket.put_object(object_key, f)

        if result.status != 200:
            return None, None

        # Generate public URL (no signature) - bucket must be public-read
        config = _get_oss_config()
        public_url = f"https://{config['bucket_name']}.{config['endpoint']}/{object_key}"
        return public_url, object_key
    except Exception:
        return None, None


def delete_by_key(object_key: str) -> bool:
    """Delete a file from OSS by its object key.

    Args:
        object_key: The OSS object key (e.g. "hermes-stt/1234567890_abc12345.m4a")

    Returns:
        True if deletion succeeded or file didn't exist, False otherwise.
    """
    bucket = _get_bucket()
    if bucket is None:
        return False

    try:
        bucket.delete_object(object_key)
        return True
    except Exception:
        return False
