import logging
import os
import shutil
from pathlib import Path
from typing import Optional

from app.config import settings

logger = logging.getLogger(__name__)


class StorageService:
    """
    Storage service for original document persistence.
    Uploads to AWS S3 when configured; otherwise persists to local sovereign storage.
    Enables zero live AWS keys in tests while satisfying S3 pipeline requirements.
    """

    def __init__(
        self,
        bucket_name: Optional[str] = None,
        region: Optional[str] = None,
        local_dir: Optional[str] = None,
    ):
        self.bucket_name = bucket_name or settings.S3_BUCKET_NAME
        self.region = region or settings.AWS_REGION
        self.local_dir = Path(local_dir or settings.UPLOADS_DIR)
        self.local_dir.mkdir(parents=True, exist_ok=True)
        self._s3_client = None

    def _use_s3(self) -> bool:
        # Originals stay on local disk in local privacy mode (Audit I-09)
        return bool(self.bucket_name) and not settings.is_local_mode

    def _get_s3_client(self):
        if self._s3_client is None:
            import boto3
            self._s3_client = boto3.client("s3", region_name=self.region)
        return self._s3_client

    def persist_original(self, file_path: Path, document_id: str, filename: str) -> str:
        """
        Persists the original uploaded document to S3 or sovereign local disk.
        Returns the storage URI.
        """
        key = f"{document_id}/{filename}"

        if self._use_s3():
            try:
                client = self._get_s3_client()
                client.upload_file(str(file_path), self.bucket_name, key)
                s3_uri = f"s3://{self.bucket_name}/{key}"
                logger.info("Persisted original document to %s", s3_uri)
                return s3_uri
            except Exception as e:
                logger.warning("S3 upload failed (%s); storing in sovereign local store.", e)

        # Sovereign local store fallback
        target_dir = self.local_dir / document_id
        target_dir.mkdir(parents=True, exist_ok=True)
        target_file = target_dir / filename
        shutil.copyfile(str(file_path), str(target_file))
        logger.info("Persisted original document locally at %s", target_file)
        return str(target_file)

    def fetch_to_temp(self, document_id: str, filename: str) -> Optional[Path]:
        """Copies the stored original to a new temp file the caller must delete, or None if missing."""
        import tempfile

        fd, tmp = tempfile.mkstemp(suffix=Path(filename).suffix)
        os.close(fd)
        tmp_path = Path(tmp)
        local = self.local_dir / document_id / filename
        try:
            if local.exists():
                shutil.copyfile(str(local), str(tmp_path))
                return tmp_path
            if self._use_s3():
                self._get_s3_client().download_file(self.bucket_name, f"{document_id}/{filename}", str(tmp_path))
                return tmp_path
        except Exception as e:
            logger.warning("Could not fetch stored original for %s: %s", document_id, type(e).__name__)
        tmp_path.unlink(missing_ok=True)
        return None

    def delete_stored(self, document_id: str, filename: str) -> bool:
        """
        Removes the persisted original (ingestion rollback and right-to-erasure deletes).
        Returns True when no copy remains (including when none existed), False on any failure.
        """
        ok = True
        key = f"{document_id}/{filename}"
        if self._use_s3():
            try:
                client = self._get_s3_client()
                client.delete_object(Bucket=self.bucket_name, Key=key)
                logger.info("Deleted %s from S3 bucket %s", key, self.bucket_name)
            except Exception as e:
                logger.warning("Failed deleting S3 object %s: %s", key, e)
                ok = False

        # Uploads may have fallen back to local storage even with a bucket configured
        target_dir = self.local_dir / document_id
        target_file = target_dir / filename
        try:
            if target_file.exists():
                target_file.unlink()
            if target_dir.exists() and not any(target_dir.iterdir()):
                target_dir.rmdir()
        except OSError as e:
            logger.warning("Failed deleting local original %s: %s", target_file, e)
            ok = False
        return ok


storage_service = StorageService()

