"""
Upload Security & File Validation.
Resolves Audit IDs: F3, F4, F5, F6.
"""
import os
import re
import zipfile
from pathlib import Path
from typing import Optional
from fastapi import HTTPException, status

# Prohibited dangerous binary signatures
EXECUTABLE_HEADERS = [
    b"MZ",           # Windows PE executable
    b"\x7fELF",      # Linux ELF executable
    b"\xca\xfe\xba\xbe"  # Java Class / Mach-O Fat Binary
]

# Magic numbers for allowed modern document and image types
MAGIC_BYTES = {
    ".pdf": b"%PDF",
    ".docx": b"PK\x03\x04",
    ".xlsx": b"PK\x03\x04",
    ".png": b"\x89PNG\r\n\x1a\n",
    ".jpg": b"\xff\xd8\xff",
    ".jpeg": b"\xff\xd8\xff",
    ".tiff": (b"II*\x00", b"MM\x00*"),
    ".tif": (b"II*\x00", b"MM\x00*"),
}

# Maximum uncompressed size for zip archives (DOCX, XLSX): 150MB
MAX_UNCOMPRESSED_ZIP_BYTES = 150 * 1024 * 1024
# Maximum compression expansion ratio to prevent zip bombs
MAX_ZIP_EXPANSION_RATIO = 50.0


def sanitize_filename(filename: Optional[str], max_length: int = 120) -> str:
    """
    Sanitizes untrusted filenames from user uploads (Audit F5):
    - Strips path traversal characters (/, \\, ..)
    - Replaces non-alphanumeric characters (except . _ -) with underscores
    - Truncates to max_length while preserving the file extension.
    """
    if not filename or not filename.strip():
        return "unnamed_document"

    # Extract base name to defeat directory traversal
    base = os.path.basename(filename.strip().replace("\\", "/"))
    stem = Path(base).stem
    suffix = Path(base).suffix.lower()

    # Strip control and dangerous characters
    safe_stem = re.sub(r"[^\w\s.-]", "_", stem).strip()
    safe_stem = re.sub(r"\s+", "_", safe_stem)
    if not safe_stem:
        safe_stem = "document"

    # Truncate stem if too long
    available_len = max(10, max_length - len(suffix))
    truncated_stem = safe_stem[:available_len].rstrip("._-")

    return f"{truncated_stem}{suffix}"


def validate_file_magic_bytes(header: bytes, ext: str) -> bool:
    """
    Validates file magic bytes against extension (Audit F4).
    Rejects executables and mismatches.
    """
    if any(header.startswith(sig) for sig in EXECUTABLE_HEADERS):
        return False

    ext_lower = ext.lower()
    expected = MAGIC_BYTES.get(ext_lower)
    if expected:
        if isinstance(expected, tuple):
            return any(header.startswith(s) for s in expected)
        return header.startswith(expected)

    # Text formats (.txt, .md, .csv) must not start with binary executable headers
    return True


def check_zip_decompression_bomb(file_path: Path) -> None:
    """
    Guards against zip/decompression bombs in OOXML documents (.docx, .xlsx) (Audit F3).
    Inspects archive headers without extracting to verify expansion ratios and total size.
    """
    suffix = file_path.suffix.lower()
    if suffix not in (".docx", ".xlsx"):
        return

    try:
        compressed_size = file_path.stat().st_size
        total_uncompressed = 0

        with zipfile.ZipFile(file_path, "r") as zf:
            for info in zf.infolist():
                total_uncompressed += info.file_size
                if total_uncompressed > MAX_UNCOMPRESSED_ZIP_BYTES:
                    raise HTTPException(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                        detail=(
                            f"Security rejection: Document expands to over "
                            f"{MAX_UNCOMPRESSED_ZIP_BYTES // (1024 * 1024)}MB uncompressed."
                        )
                    )

            if compressed_size > 0:
                ratio = total_uncompressed / compressed_size
                if ratio > MAX_ZIP_EXPANSION_RATIO and total_uncompressed > 10 * 1024 * 1024:
                    raise HTTPException(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                        detail=f"Security rejection: Abnormal compression ratio ({ratio:.1f}x) detected."
                    )
    except zipfile.BadZipFile:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Corrupted or invalid document archive '{file_path.name}'."
        )


def validate_audio_upload(audio_bytes: bytes, max_bytes: int = 25 * 1024 * 1024) -> None:
    """Validates audio file size and non-empty buffer (Audit S8)."""
    if not audio_bytes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded audio file is empty."
        )
    if len(audio_bytes) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Audio file exceeds maximum allowed size of {max_bytes // (1024 * 1024)}MB."
        )
